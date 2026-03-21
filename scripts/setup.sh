#!/usr/bin/env bash
set -euo pipefail

# Initialize .forge/ directory structure for a project
PROJECT_DIR="${1:-.}"
FORGE_DIR="${PROJECT_DIR}/.forge"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -d "$FORGE_DIR" ]; then
  echo "Forge already initialized in ${FORGE_DIR}"
  exit 0
fi

echo "Initializing Forge in ${FORGE_DIR}..."

mkdir -p "${FORGE_DIR}/specs"
mkdir -p "${FORGE_DIR}/plans"
mkdir -p "${FORGE_DIR}/history/cycles"
mkdir -p "${FORGE_DIR}/summaries"

# Copy default config
cp "${PLUGIN_ROOT}/templates/config.json" "${FORGE_DIR}/config.json"

# Initialize state
cp "${PLUGIN_ROOT}/templates/state.md" "${FORGE_DIR}/state.md"

# Initialize empty token ledger
echo '{"total":0,"iterations":0,"per_spec":{}}' > "${FORGE_DIR}/token-ledger.json"

# Initialize empty backprop log
echo "# Backpropagation Log" > "${FORGE_DIR}/history/backprop-log.md"

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
