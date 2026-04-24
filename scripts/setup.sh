#!/usr/bin/env bash
set -euo pipefail

# Initialize .forge/ directory structure for a project
PROJECT_DIR="${1:-.}"
FORGE_DIR="${PROJECT_DIR}/.forge"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Idempotency gate (R001): treat the presence of config.json as the signal
# that Forge is already initialized. A bare `.forge/` directory can be left
# behind by the TUI (e.g. `.tui-log.jsonl`), a mid-init crash, or a backup
# restore -- in those cases we still need to lay down the rest of the
# scaffolding. The `mkdir -p` + `cp -n` calls below are all idempotent so
# repeated partial runs converge to a fully-initialized directory.
if [ -f "${FORGE_DIR}/config.json" ]; then
  echo "Forge already initialized (config.json present)"
  exit 0
fi

if [ -d "$FORGE_DIR" ]; then
  echo "Completing partial Forge init in ${FORGE_DIR}..."
else
  echo "Initializing Forge in ${FORGE_DIR}..."
fi

mkdir -p "${FORGE_DIR}/specs"
mkdir -p "${FORGE_DIR}/plans"
mkdir -p "${FORGE_DIR}/history/cycles"
mkdir -p "${FORGE_DIR}/summaries"
mkdir -p "${FORGE_DIR}/collab"

# Copy default config (cp -n: never overwrite an existing file)
cp -n "${PLUGIN_ROOT}/templates/config.json" "${FORGE_DIR}/config.json"

# Initialize state
cp -n "${PLUGIN_ROOT}/templates/state.md" "${FORGE_DIR}/state.md"

# Initialize empty token ledger (only if missing)
if [ ! -f "${FORGE_DIR}/token-ledger.json" ]; then
  echo '{"total":0,"iterations":0,"per_spec":{}}' > "${FORGE_DIR}/token-ledger.json"
fi

# Initialize empty backprop log (only if missing)
if [ ! -f "${FORGE_DIR}/history/backprop-log.md" ]; then
  echo "# Backpropagation Log" > "${FORGE_DIR}/history/backprop-log.md"
fi

# Add collab carve-out rules to .gitignore (R001 AC1).
# Must use the glob form `/.forge/*` plus un-ignore re-entries so git descends
# into .forge/collab/ and publishes shared artifacts while keeping per-machine
# state (participant.json, flag-emit-log-*.jsonl, .enabled) local. A bare
# `.forge/` rule would ignore the whole tree and git refuses to re-include
# files under an ignored parent directory.
#
# Idempotency: the outer `[ -f "${FORGE_DIR}/config.json" ]` gate above means
# setup.sh only falls through here on first init or partial re-init. Inside
# this block we still check for the carve-out marker so a partial re-init on
# top of an already-patched .gitignore is a no-op.
#
# Legacy migration: if an existing checkout has a bare `.forge/` rule (from
# pre-collab setup.sh), it is left alone here. The migration path lives in
# `scripts/forge-collab.cjs::patchGitignore` and is surfaced by
# `/forge:collaborate start` when it detects `legacy_rule_no_carve_out`.
GITIGNORE="${PROJECT_DIR}/.gitignore"
CARVE_OUT_MARKER="# forge: collab carve-out"
CARVE_OUT_BLOCK="${CARVE_OUT_MARKER}
/.forge/*
!/.forge/collab/
!/.forge/collab/**"

if [ -f "$GITIGNORE" ]; then
  if grep -qF "$CARVE_OUT_MARKER" "$GITIGNORE" 2>/dev/null; then
    : # carve-out already present, no-op
  else
    # Append with a separating blank line if the file does not already end in
    # a newline so the marker lands on its own line.
    if [ -s "$GITIGNORE" ] && [ -n "$(tail -c 1 "$GITIGNORE")" ]; then
      printf '\n' >> "$GITIGNORE"
    fi
    printf '\n%s\n' "$CARVE_OUT_BLOCK" >> "$GITIGNORE"
    echo "Added .forge/ collab carve-out to .gitignore"
  fi
else
  printf '%s\n' "$CARVE_OUT_BLOCK" > "$GITIGNORE"
  echo "Created .gitignore with .forge/ collab carve-out"
fi

# Nested .forge/collab/.gitignore so per-machine state never propagates via
# git pull, even though the carve-out above un-ignores the whole collab dir.
NESTED_GITIGNORE="${FORGE_DIR}/collab/.gitignore"
if [ ! -f "$NESTED_GITIGNORE" ]; then
  cp "${PLUGIN_ROOT}/templates/collab-gitignore" "$NESTED_GITIGNORE"
fi

echo "Forge initialized. Run /forge brainstorm to get started."
