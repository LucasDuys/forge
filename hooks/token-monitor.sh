#!/usr/bin/env bash
set -euo pipefail

# Forge PostToolUse hook: per-task token tracking + 80/100 percent gates.
#
# T012 / R001. Runs on every tool use, so it must stay well under 50ms.
# Fast-paths:
#   1. exit immediately if forge loop not active
#   2. exit immediately if no current_task in state.md (regular sessions)
#   3. only spawn node when there is real work to do
#
# Heavy work (transcript scan, depth downgrade) still lives in stop-hook.sh.
# This hook only does the cheap inline tracking the spec requires.

FORGE_DIR=".forge"
LOOP_FILE="${FORGE_DIR}/.forge-loop.json"
STATE_FILE="${FORGE_DIR}/state.md"
COUNTER_FILE="${FORGE_DIR}/.tool-count"
TOOLS_SCRIPT="${CLAUDE_PLUGIN_ROOT:-.}/scripts/forge-tools.cjs"

# Fast path 1: forge not active. Drain stdin so the producer does not block.
if [ ! -f "$LOOP_FILE" ]; then
  cat >/dev/null 2>&1 || true
  exit 0
fi

# Read hook payload from stdin once. We need its length for cheap token
# estimation, and we do not need to parse the JSON in bash.
PAYLOAD="$(cat 2>/dev/null || true)"

# Preserve existing behavior: increment cheap tool counter.
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
fi
echo $((COUNT + 1)) > "$COUNTER_FILE"

# Fast path 2: no state file means no per-task tracking possible.
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Extract current_task from frontmatter. Cheap: read first ~20 lines only,
# match the key, strip whitespace and quotes. No python, no node.
CURRENT_TASK="$(sed -n '1,25p' "$STATE_FILE" \
  | grep -E '^current_task:' \
  | head -n1 \
  | sed -e 's/^current_task:[[:space:]]*//' -e 's/["'\'']//g' -e 's/[[:space:]]*$//' \
  || true)"

# Fast path 3: no current task means nothing to record.
if [ -z "${CURRENT_TASK:-}" ]; then
  exit 0
fi

# Cheap token estimation: chars / 4 (industry rule of thumb). The PostToolUse
# payload contains both tool_input and tool_response, which is what consumes
# context, so its length is a usable proxy.
PAYLOAD_LEN=${#PAYLOAD}
TOKENS=$(( PAYLOAD_LEN / 4 ))
if [ "$TOKENS" -le 0 ]; then
  TOKENS=1
fi

# Fast path 4: forge-tools missing. Fail open so user sessions never break.
if [ ! -f "$TOOLS_SCRIPT" ]; then
  exit 0
fi

# Single node spawn: record tokens, check budget, emit gate decision.
# Output format from forge-tools: pct=<f> used=<i> budget=<i> warn=<0|1> escalated=<0|1>
RESULT="$(node "$TOOLS_SCRIPT" record-task-tokens "$CURRENT_TASK" "$TOKENS" --forge-dir "$FORGE_DIR" 2>/dev/null || true)"

if [ -z "$RESULT" ]; then
  # forge-tools missing the subcommand or failed. Stay silent.
  exit 0
fi

# Parse the key=value line without spawning anything.
PCT=""
BUDGET=""
WARN="0"
ESCALATED="0"
for kv in $RESULT; do
  case "$kv" in
    pct=*)       PCT="${kv#pct=}" ;;
    budget=*)    BUDGET="${kv#budget=}" ;;
    warn=*)      WARN="${kv#warn=}" ;;
    escalated=*) ESCALATED="${kv#escalated=}" ;;
  esac
done

# 100% circuit breaker. State.md was already updated by forge-tools. Emit
# a loud warning to stderr so Claude sees it on the next prompt cycle.
if [ "$ESCALATED" = "1" ]; then
  echo "[budget exhausted] task ${CURRENT_TASK} hit ${PCT}% of ${BUDGET} tokens. state set to budget_exhausted. stop hook will route." 1>&2
  exit 0
fi

# 80% warning gate. Caveman form per R013: short, no articles, fragments ok.
if [ "$WARN" = "1" ]; then
  echo "[budget warning] task ${CURRENT_TASK} at ${PCT}% of ${BUDGET} tokens. wrap up or escalate." 1>&2
fi

exit 0
