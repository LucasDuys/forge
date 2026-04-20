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

# Add .forge to .gitignore if not already there
GITIGNORE="${PROJECT_DIR}/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q '^\.forge/' "$GITIGNORE" 2>/dev/null; then
    echo ".forge/" >> "$GITIGNORE"
    echo "Added .forge/ to .gitignore"
  fi
else
  echo ".forge/" > "$GITIGNORE"
  echo "Created .gitignore with .forge/"
fi

echo "Forge initialized. Run /forge brainstorm to get started."
