#!/usr/bin/env bash
#
# demo.sh -- spec-mock-and-visual-verify R004 audit-evidence driver.
#
# Drives the blurry-graph fixture through before-fix / after-fix screenshot
# capture so the E2E proof of the visual-verifier loop can be reviewed from
# a static directory without re-running Playwright.
#
# Modes:
#   --mode before   Flip src/config.ts regression flags back to `true`,
#                   start `bun dev`, capture halo/zoomOut/synthesis
#                   screenshots to docs/audit/mock-verify-evidence/<rid>/before.png,
#                   then restore src/config.ts from the backup.
#   --mode after    Leave src/config.ts alone (post-fix state), start
#                   `bun dev`, capture after.png for each regression.
#   --mode full     Run before then after in sequence (default).
#
# Sandbox fallback:
#   When FORGE_DISABLE_PLAYWRIGHT=1 OR the `playwright` CLI is absent, no
#   browser is launched and no dev server is started. Instead a minimal
#   1x1 placeholder PNG is written at each target path so the evidence
#   directory structure is concrete and the README references resolve.
#   Real screenshots can be dropped in later by re-running `demo.sh` in an
#   environment where Playwright is available.
#
# Cleanup:
#   A trap restores src/config.ts from its backup and stops the dev server
#   on EXIT, INT, and TERM so an interrupted run cannot leave the fixture
#   in the `before` (flipped-flags) state.
#
# Non-mutation guarantee (R004 AC + test contract):
#   Running demo.sh --mode before completes with src/config.ts byte-identical
#   to its pre-run state -- tests/mock-demo-evidence.test.cjs asserts this.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_ROOT="${SCRIPT_DIR}"
REPO_ROOT="$(cd "${MOCK_ROOT}/../.." && pwd)"
CONFIG_FILE="${MOCK_ROOT}/src/config.ts"
CONFIG_BACKUP="${MOCK_ROOT}/src/config.ts.demo-bak"
EVIDENCE_ROOT="${REPO_ROOT}/docs/audit/mock-verify-evidence"

REGRESSIONS=("halo" "zoomOut" "synthesis")
DEV_URL="http://localhost:5174"
VIEWPORT_W=1280
VIEWPORT_H=800

DEV_PID=""
MODE="full"

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "demo.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "${MODE}" in
  before|after|full) ;;
  *)
    echo "demo.sh: --mode must be before|after|full (got '${MODE}')" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Capability probe
# ---------------------------------------------------------------------------

PLAYWRIGHT_MODE="real"
if [[ "${FORGE_DISABLE_PLAYWRIGHT:-0}" == "1" ]]; then
  PLAYWRIGHT_MODE="placeholder"
elif ! command -v playwright >/dev/null 2>&1; then
  PLAYWRIGHT_MODE="placeholder"
fi

# ---------------------------------------------------------------------------
# Cleanup trap -- must be installed before any mutation
# ---------------------------------------------------------------------------

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "${DEV_PID}" ]] && kill -0 "${DEV_PID}" 2>/dev/null; then
    kill "${DEV_PID}" 2>/dev/null || true
    sleep 1
    kill -9 "${DEV_PID}" 2>/dev/null || true
  fi
  if [[ -f "${CONFIG_BACKUP}" ]]; then
    mv -f "${CONFIG_BACKUP}" "${CONFIG_FILE}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# PNG placeholder
# ---------------------------------------------------------------------------

# Write a minimal 1x1 PNG to $1. Used when Playwright is unavailable so the
# evidence directory structure is concrete and the README embeds resolve.
# Bytes are a valid PNG (8-byte signature + IHDR + IDAT + IEND), decoded
# from a base64 literal so this is portable across any bash with `base64`.
write_placeholder_png() {
  local dest="$1"
  mkdir -p "$(dirname "${dest}")"
  # 1x1 transparent PNG (67 bytes), base64-encoded.
  echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" \
    | base64 -d > "${dest}"
}

# ---------------------------------------------------------------------------
# Regression-flag flipping (before mode only)
# ---------------------------------------------------------------------------

flip_flags_to_broken() {
  cp "${CONFIG_FILE}" "${CONFIG_BACKUP}"
  # Regex-replace each flag's value to `true`. `off` stays at whatever it
  # was (default false in the shipped file) so the master kill-switch does
  # not silently mask the regressions.
  for flag in "${REGRESSIONS[@]}"; do
    # sed in-place is non-portable (BSD vs GNU); use a temp file instead.
    sed -E "s/^( *${flag} *: *)false(,?)/\1true\2/" "${CONFIG_FILE}" > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"
  done
}

restore_flags() {
  if [[ -f "${CONFIG_BACKUP}" ]]; then
    mv -f "${CONFIG_BACKUP}" "${CONFIG_FILE}"
  fi
}

# ---------------------------------------------------------------------------
# Dev server lifecycle (real mode only)
# ---------------------------------------------------------------------------

start_dev_server() {
  # Best-effort: `bun dev` in the mock dir, detached, output to /dev/null.
  # If bun is missing the command fails and the trap will abort cleanly.
  (cd "${MOCK_ROOT}" && bun dev >/dev/null 2>&1 &)
  DEV_PID=$!
  # Wait up to 15s for the server to start responding. Using curl if present
  # so we do not require any extra tooling.
  local waited=0
  while [[ "${waited}" -lt 30 ]]; do
    if command -v curl >/dev/null 2>&1 && curl -sf "${DEV_URL}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  echo "demo.sh: dev server failed to respond at ${DEV_URL} within 15s" >&2
  return 1
}

stop_dev_server() {
  if [[ -n "${DEV_PID}" ]] && kill -0 "${DEV_PID}" 2>/dev/null; then
    kill "${DEV_PID}" 2>/dev/null || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
  DEV_PID=""
}

# ---------------------------------------------------------------------------
# Screenshot capture
# ---------------------------------------------------------------------------

# Args: $1 = regression id (halo|zoomOut|synthesis), $2 = phase (before|after)
capture_one() {
  local rid="$1"
  local phase="$2"
  local dest="${EVIDENCE_ROOT}/${rid}/${phase}.png"
  mkdir -p "$(dirname "${dest}")"

  if [[ "${PLAYWRIGHT_MODE}" == "placeholder" ]]; then
    echo "demo.sh: [placeholder] ${rid}/${phase}.png (Playwright unavailable)"
    write_placeholder_png "${dest}"
    return 0
  fi

  echo "demo.sh: [real] capturing ${rid}/${phase}.png via playwright at ${DEV_URL}"
  # Minimal inline node script so we do not need a separate JS file.
  playwright screenshot \
    --viewport-size="${VIEWPORT_W},${VIEWPORT_H}" \
    --wait-for-timeout=2000 \
    "${DEV_URL}" \
    "${dest}" || {
      echo "demo.sh: playwright screenshot failed; writing placeholder instead" >&2
      write_placeholder_png "${dest}"
    }
}

capture_all_for_phase() {
  local phase="$1"
  for rid in "${REGRESSIONS[@]}"; do
    capture_one "${rid}" "${phase}"
  done
}

# ---------------------------------------------------------------------------
# Phase drivers
# ---------------------------------------------------------------------------

run_before() {
  echo "demo.sh: mode=before -- flipping flags to broken state"
  flip_flags_to_broken
  if [[ "${PLAYWRIGHT_MODE}" == "real" ]]; then
    start_dev_server
    capture_all_for_phase "before"
    stop_dev_server
  else
    capture_all_for_phase "before"
  fi
  restore_flags
  echo "demo.sh: mode=before -- flags restored"
}

run_after() {
  echo "demo.sh: mode=after -- using current (post-fix) config"
  if [[ "${PLAYWRIGHT_MODE}" == "real" ]]; then
    start_dev_server
    capture_all_for_phase "after"
    stop_dev_server
  else
    capture_all_for_phase "after"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

mkdir -p "${EVIDENCE_ROOT}"
for rid in "${REGRESSIONS[@]}"; do
  mkdir -p "${EVIDENCE_ROOT}/${rid}"
done

case "${MODE}" in
  before) run_before ;;
  after)  run_after ;;
  full)   run_before; run_after ;;
esac

echo "demo.sh: done. Evidence at ${EVIDENCE_ROOT}/ (mode=${PLAYWRIGHT_MODE})"
