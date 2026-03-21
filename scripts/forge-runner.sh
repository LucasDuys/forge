#!/usr/bin/env bash
set -euo pipefail

# Forge Runner — external loop for fully autonomous execution
# Handles context resets by restarting Claude with resume prompt
#
# Fix #8: Added max restart limit and exponential backoff to prevent
# infinite loops when Claude keeps crashing for non-Forge reasons
# (API errors, network issues, etc.)

MAX_RESTARTS=${FORGE_MAX_RESTARTS:-10}
BASE_DELAY=${FORGE_BASE_DELAY:-3}
RESTART_COUNT=0

echo "Starting Forge autonomous runner..."
echo "Max restarts: $MAX_RESTARTS (set FORGE_MAX_RESTARTS to override)"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  if [ ! -f .forge/.forge-resume.md ]; then
    echo "No resume prompt found. Run /forge execute first."
    exit 1
  fi

  echo "[Restart $((RESTART_COUNT + 1))/$MAX_RESTARTS] Launching Claude session..."
  claude --print -p "$(cat .forge/.forge-resume.md)"
  SESSION_EXIT=$?

  # Check if forge is done (loop state file removed on completion)
  if [ ! -f .forge/.forge-loop.json ]; then
    echo ""
    echo "Forge complete!"
    # Show summary if it exists
    SUMMARY=$(ls .forge/summary-*.md 2>/dev/null | tail -1)
    if [ -n "$SUMMARY" ]; then
      echo "Summary: $SUMMARY"
    fi
    break
  fi

  # Check if human intervention needed
  if grep -q 'task_status: blocked' .forge/state.md 2>/dev/null; then
    echo ""
    echo "Forge paused — task blocked, needs human input."
    BLOCKED_REASON=$(grep 'blocked_reason:' .forge/state.md 2>/dev/null | head -1 | sed 's/.*: //')
    if [ -n "$BLOCKED_REASON" ]; then
      echo "Reason: $BLOCKED_REASON"
    fi
    echo "Review .forge/state.md, then run /forge resume"
    break
  fi

  # Increment restart counter
  RESTART_COUNT=$((RESTART_COUNT + 1))

  # Check restart limit
  if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
    echo ""
    echo "Max restarts ($MAX_RESTARTS) reached. Stopping."
    echo "Review .forge/state.md for current progress."
    echo "To continue: increase FORGE_MAX_RESTARTS or run /forge resume"
    exit 1
  fi

  # Exponential backoff: base * 2^(restart-1), capped at 60 seconds
  DELAY=$BASE_DELAY
  for i in $(seq 1 $((RESTART_COUNT - 1))); do
    DELAY=$((DELAY * 2))
    if [ "$DELAY" -gt 60 ]; then
      DELAY=60
      break
    fi
  done

  # If Claude exited with an error (non-zero), increase backoff
  if [ "$SESSION_EXIT" -ne 0 ]; then
    echo "Claude exited with error code $SESSION_EXIT"
    DELAY=$((DELAY * 2))
    if [ "$DELAY" -gt 120 ]; then
      DELAY=120
    fi
  fi

  echo "Context reset. Restarting in ${DELAY}s... (restart $RESTART_COUNT/$MAX_RESTARTS)"
  sleep "$DELAY"
done
