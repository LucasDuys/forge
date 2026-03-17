#!/usr/bin/env bash
set -euo pipefail

# Forge Stop Hook — Smart Loop Engine
# Fires when Claude tries to exit. Reads state, routes to next action.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FORGE_DIR=".forge"
LOOP_FILE="${FORGE_DIR}/.forge-loop.json"
STATE_FILE="${FORGE_DIR}/state.md"
TOOLS_CJS="${PLUGIN_ROOT}/scripts/forge-tools.cjs"

# Read hook input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.session_id||'')}catch(e){}" 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(echo "$INPUT" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.transcript_path||'')}catch(e){}" 2>/dev/null || echo "")

# Not in a forge loop? Allow normal exit
[ ! -f "$LOOP_FILE" ] && exit 0

# Check for Ralph Loop conflict
if [ -f ".claude/ralph-loop.local.md" ]; then
  echo '{"decision":"block","reason":"WARNING: Ralph Loop is also active. Please run /cancel-ralph first, then /forge resume. Only one loop plugin should be active at a time."}'
  exit 0
fi

# Read loop state
LOOP_DATA=$(cat "$LOOP_FILE")
ITERATION=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.iteration||1)}catch(e){console.log(1)}")
MAX_ITERATIONS=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.max_iterations||100)}catch(e){console.log(100)}")
COMPLETION_PROMISE=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.completion_promise||'FORGE_COMPLETE')}catch(e){console.log('FORGE_COMPLETE')}")
LOOP_SESSION=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.session_id||'')}catch(e){console.log('')}")

# Session isolation — only the owning session controls the loop
if [ -n "$LOOP_SESSION" ] && [ -n "$SESSION_ID" ] && [ "$LOOP_SESSION" != "$SESSION_ID" ]; then
  exit 0
fi

# Check max iterations
if [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
  echo "Max iterations ($MAX_ITERATIONS) reached. Saving state and exiting." >&2
  rm -f "$LOOP_FILE"
  exit 0
fi

# Check for completion promise in last output
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LAST_OUTPUT=$(tail -20 "$TRANSCRIPT_PATH" | node -e "
    const lines=require('fs').readFileSync('/dev/stdin','utf8').split('\n').filter(Boolean);
    let last='';
    for(const l of lines){try{const d=JSON.parse(l);if(d.role==='assistant'){
      if(typeof d.content==='string')last=d.content;
      else if(Array.isArray(d.content)){for(const b of d.content){if(b.type==='text')last=b.text;}}
    }}catch(e){}}
    console.log(last);
  " 2>/dev/null || echo "")

  if echo "$LAST_OUTPUT" | grep -qF "<promise>${COMPLETION_PROMISE}</promise>"; then
    rm -f "$LOOP_FILE"
    exit 0
  fi
fi

# === ROUTING DECISION ===
# Call forge-tools.cjs for the smart routing
NEXT_PROMPT=$(node "$TOOLS_CJS" route \
  --forge-dir "$FORGE_DIR" \
  --iteration "$ITERATION" \
  --transcript "$TRANSCRIPT_PATH" \
  2>/dev/null || echo "")

if [ -z "$NEXT_PROMPT" ]; then
  # No routing decision — allow exit
  exit 0
fi

# Update iteration counter
NEXT_ITERATION=$((ITERATION + 1))
echo "$LOOP_DATA" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  d.iteration=$NEXT_ITERATION;
  d.last_updated=new Date().toISOString();
  console.log(JSON.stringify(d,null,2));
" > "$LOOP_FILE" 2>/dev/null

# Block exit and feed next prompt (use node for proper JSON escaping)
node -e "console.log(JSON.stringify({decision:'block',reason:'[Forge iteration ${NEXT_ITERATION}/${MAX_ITERATIONS}]\\n\\n'+process.argv[1]}))" "$NEXT_PROMPT"
