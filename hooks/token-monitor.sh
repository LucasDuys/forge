#!/usr/bin/env bash
set -euo pipefail

# Lightweight PostToolUse hook — just increments a counter file
# Heavy lifting (token estimation, budget checks) done in stop-hook.sh

FORGE_DIR=".forge"
COUNTER_FILE="${FORGE_DIR}/.tool-count"

# Only act if forge is active
[ ! -f "${FORGE_DIR}/.forge-loop.json" ] && exit 0

# Increment tool use counter
COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
echo $((COUNT + 1)) > "$COUNTER_FILE"

exit 0
