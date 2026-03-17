#!/usr/bin/env bash
set -euo pipefail

# Forge Runner — external loop for fully autonomous execution
# Handles context resets by restarting Claude with resume prompt

echo "Starting Forge autonomous runner..."
echo "Press Ctrl+C to stop"

while true; do
  if [ ! -f .forge/.forge-resume.md ]; then
    echo "No resume prompt found. Run /forge execute first."
    exit 1
  fi

  claude --print -p "$(cat .forge/.forge-resume.md)"

  # Check if forge is done (loop state file removed on completion)
  if [ ! -f .forge/.forge-loop.json ]; then
    echo "Forge complete!"
    break
  fi

  # Check if human intervention needed (YAML frontmatter in state.md)
  if grep -q 'status: blocked' .forge/state.md 2>/dev/null; then
    echo "Forge paused — needs human input."
    echo "Review .forge/state.md, then run /forge resume"
    break
  fi

  echo "Context reset. Starting fresh session in 3 seconds..."
  sleep 3
done
