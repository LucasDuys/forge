#!/usr/bin/env bash
set -euo pipefail

# Forge Stop Hook -- Smart Loop Engine
# Fires when Claude tries to exit. Reads state, routes to next action.
#
# T013 additions (R003, R005, R007):
#   - Lock heartbeat update on every invocation (R007)
#   - First-invocation lock acquisition with takeover of stale locks (R007)
#   - New phase handling: budget_exhausted, conflict_resolution, recovering, lock_conflict
#   - Honors empty stdout from `route` (T010 exit-action signal) as a clean exit (R003)
#   - Releases lock on completion or clean exit
#
# Graceful degradation: any failure of the new lock/heartbeat helpers must NOT
# break existing routing. Errors are logged to .forge-debug.log and silently
# tolerated unless they represent a hard lock conflict.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FORGE_DIR=".forge"
LOOP_FILE="${FORGE_DIR}/.forge-loop.json"
LOCK_FILE="${FORGE_DIR}/.forge-loop.lock"
STATE_FILE="${FORGE_DIR}/state.md"
TOOLS_CJS="${PLUGIN_ROOT}/scripts/forge-tools.cjs"
# Fix #3: Log errors to debug file instead of /dev/null
DEBUG_LOG="${FORGE_DIR}/.forge-debug.log"

# Read hook input from stdin
INPUT=$(cat)
# T013: portable stdin reading. `/dev/stdin` is mangled to `C:\dev\stdin` by
# Git Bash on Windows; use fd 0 via process.stdin streaming instead.
_PARSE_JSON_FIELD='let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d);console.log(o[process.argv[1]]||"")}catch(e){console.log("")}})'
SESSION_ID=$(printf '%s' "$INPUT" | node -e "$_PARSE_JSON_FIELD" session_id 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | node -e "$_PARSE_JSON_FIELD" transcript_path 2>/dev/null || echo "")

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

# Session isolation -- only the owning session controls the loop
if [ -n "$LOOP_SESSION" ] && [ -n "$SESSION_ID" ] && [ "$LOOP_SESSION" != "$SESSION_ID" ]; then
  exit 0
fi

# === T013: Read current phase from state.md ===
# Used to short-circuit on terminal/error phases like budget_exhausted or lock_conflict.
CURRENT_PHASE=$(node -e "
  try {
    const t = require('fs').readFileSync('${STATE_FILE}', 'utf8');
    const m = t.match(/^---\n([\s\S]*?)\n---/);
    if (!m) { console.log(''); process.exit(0); }
    const fm = m[1];
    const pm = fm.match(/^phase:\s*(.+)$/m);
    console.log(pm ? pm[1].trim() : '');
  } catch (e) { console.log(''); }
" 2>/dev/null || echo "")

# === T013: Lock acquisition / heartbeat (R007) ===
# Lock ownership across short-lived stop-hook node processes is identified by
# the session id stored in the lock's `task` field as `session:<SESSION_ID>`.
# This is necessary because each invocation has a different node PID.
LOCK_OWNER_TAG="session:${SESSION_ID:-unknown}"

LOCK_RESULT=$(node -e "
  const path = require('path');
  const tools = require('${TOOLS_CJS}'.replace(/\\\\/g, '/'));
  const forgeDir = '${FORGE_DIR}';
  const ownerTag = '${LOCK_OWNER_TAG}';
  try {
    const existing = tools.readLock(forgeDir);
    if (!existing) {
      // Fresh acquire on first invocation of this session.
      const r = tools.acquireLock(forgeDir, ownerTag);
      if (r.acquired) {
        console.log(JSON.stringify({ status: 'acquired', tookOverStale: !!r.tookOverStale }));
      } else {
        console.log(JSON.stringify({ status: 'conflict', reason: r.reason || 'unknown', holder: r.holder || null }));
      }
      process.exit(0);
    }
    // Lock exists. If it belongs to this session, refresh heartbeat by
    // rewriting the lock file (works across PIDs).
    if (existing.task === ownerTag) {
      const fs = require('fs');
      const lockPath = path.join(forgeDir, '.forge-loop.lock');
      const refreshed = [
        'pid: ' + process.pid,
        'started: ' + (existing.started || new Date().toISOString()),
        'task: ' + ownerTag,
        'heartbeat: ' + new Date().toISOString(),
        ''
      ].join('\n');
      fs.writeFileSync(lockPath, refreshed);
      console.log(JSON.stringify({ status: 'heartbeat' }));
      process.exit(0);
    }
    // Lock owned by someone else. Check staleness.
    const stale = tools.detectStaleLock(forgeDir);
    if (stale && stale.is_stale) {
      const r = tools.acquireLock(forgeDir, ownerTag);
      if (r.acquired) {
        console.log(JSON.stringify({ status: 'acquired', tookOverStale: true, prior: existing.task || '' }));
      } else {
        console.log(JSON.stringify({ status: 'conflict', reason: r.reason || 'takeover_failed', holder: existing }));
      }
      process.exit(0);
    }
    console.log(JSON.stringify({ status: 'conflict', reason: 'held_by_other_session', holder: existing }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: String(e && e.message || e) }));
  }
" 2>>"$DEBUG_LOG" || echo '{"status":"error","message":"node_invocation_failed"}')

LOCK_STATUS=$(printf '%s' "$LOCK_RESULT" | node -e "$_PARSE_JSON_FIELD" status 2>/dev/null || echo "")

case "$LOCK_STATUS" in
  acquired)
    TOOK_OVER=$(printf '%s' "$LOCK_RESULT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d);console.log(o.tookOverStale?"1":"0")}catch(e){console.log("0")}})' 2>/dev/null || echo "0")
    if [ "$TOOK_OVER" = "1" ]; then
      echo "forge: took over stale loop lock for session ${SESSION_ID:-unknown}" >&2
      echo "[$(date -Iseconds)] lock takeover (stale) by session ${SESSION_ID:-unknown}" >> "$DEBUG_LOG"
    fi
    ;;
  heartbeat)
    : # silent, normal path
    ;;
  conflict)
    REASON=$(printf '%s' "$LOCK_RESULT" | node -e "$_PARSE_JSON_FIELD" reason 2>/dev/null || echo "unknown")
    echo "forge: another session holds the loop lock (${REASON}), exiting" >&2
    echo "[$(date -Iseconds)] lock conflict: ${REASON}" >> "$DEBUG_LOG"
    # Mark phase for visibility but do NOT block; let Claude exit cleanly.
    exit 0
    ;;
  error)
    # Graceful degradation: log and continue without lock support.
    MSG=$(printf '%s' "$LOCK_RESULT" | node -e "$_PARSE_JSON_FIELD" message 2>/dev/null || echo "")
    echo "[$(date -Iseconds)] lock helper error (degraded): ${MSG}" >> "$DEBUG_LOG"
    ;;
  *)
    echo "[$(date -Iseconds)] lock helper returned unexpected status: ${LOCK_STATUS}" >> "$DEBUG_LOG"
    ;;
esac

# === T013: Phase-based short-circuits ===
case "$CURRENT_PHASE" in
  budget_exhausted)
    # R003: hard stop on budget exhaustion. Allow clean exit, no blocking prompt.
    echo "forge: budget exhausted, exiting cleanly" >&2
    node -e "
      try { require('${TOOLS_CJS}'.replace(/\\\\/g,'/')).releaseLock('${FORGE_DIR}'); }
      catch (e) {}
    " 2>>"$DEBUG_LOG" || true
    exit 0
    ;;
  lock_conflict)
    # Defensive: if state.md was previously marked lock_conflict, exit cleanly.
    echo "forge: state phase=lock_conflict, exiting" >&2
    exit 0
    ;;
  conflict_resolution|recovering)
    # Fall through to routeDecision -- it knows how to handle these phases.
    :
    ;;
esac

# Check max iterations
if [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
  echo "Max iterations ($MAX_ITERATIONS) reached. Saving state and exiting." >&2
  node -e "
    try { require('${TOOLS_CJS}'.replace(/\\\\/g,'/')).releaseLock('${FORGE_DIR}'); }
    catch (e) {}
  " 2>>"$DEBUG_LOG" || true
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
    # Fix #9: Generate summary on completion before exiting
    node "$TOOLS_CJS" summary --forge-dir "$FORGE_DIR" 2>>"$DEBUG_LOG" || true
    # T013: release the loop lock on completion.
    node -e "
      try { require('${TOOLS_CJS}'.replace(/\\\\/g,'/')).releaseLock('${FORGE_DIR}'); }
      catch (e) {}
    " 2>>"$DEBUG_LOG" || true
    rm -f "$LOOP_FILE"
    exit 0
  fi
fi

# === ROUTING DECISION ===
# Fix #3: Log stderr to debug file instead of swallowing it.
# T010: route may now print empty stdout to signal a clean exit (e.g., budget
# exhausted mid-route). Empty NEXT_PROMPT below is treated as exit.
NEXT_PROMPT=$(node "$TOOLS_CJS" route \
  --forge-dir "$FORGE_DIR" \
  --iteration "$ITERATION" \
  --transcript "$TRANSCRIPT_PATH" \
  2>>"$DEBUG_LOG") || {
    ROUTE_EXIT=$?
    echo "[$(date -Iseconds)] Route failed with exit code $ROUTE_EXIT" >> "$DEBUG_LOG"
    echo '{"decision":"block","reason":"[Forge] Routing error -- check .forge/.forge-debug.log for details. The route script crashed. Run `cat .forge/.forge-debug.log` to see the error, then fix and /forge resume."}'
    exit 0
  }

if [ -z "$NEXT_PROMPT" ]; then
  # T013/R003: empty stdout from route is the budget-exhausted exit signal
  # (or "phase is idle" -- either way, no further routing needed).
  # The route command writes "forge: exit (...)" to stderr in that case.
  echo "forge: route returned no prompt, allowing clean exit" >&2
  node -e "
    try { require('${TOOLS_CJS}'.replace(/\\\\/g,'/')).releaseLock('${FORGE_DIR}'); }
    catch (e) {}
  " 2>>"$DEBUG_LOG" || true
  exit 0
fi

# === Auto-backprop injection ===
# If hooks/auto-backprop.js wrote a flag file (test failure detected during
# executor runs), inject a backprop directive at the TOP of NEXT_PROMPT so
# the executor handles the failure-to-spec-gap trace before continuing the
# current task. The flag is cleared atomically here so the next iteration
# doesn't re-fire on the same failure. State.md flag is also cleared so the
# TUI dashboard's BACKPROP banner clears on the next render tick.
AUTOBP_FLAG="${FORGE_DIR}/.auto-backprop-pending.json"
if [ -f "$AUTOBP_FLAG" ]; then
  # Read failure context, prepend directive, then delete the flag.
  AUTOBP_PREFIX=$(node -e "
    try {
      const fs = require('fs');
      const flag = JSON.parse(fs.readFileSync('${AUTOBP_FLAG}', 'utf8'));
      const cmd = (flag.command || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
      const excerpt = (flag.failure_excerpt || '').slice(0, 2000);
      const lines = [
        '═══ AUTO-BACKPROP TRIGGERED ═══',
        '',
        'A test failure was detected by the auto-backprop hook at ' + (flag.triggered_at || 'unknown time') + '.',
        'Before continuing with the task below, run the /forge backprop workflow on this failure:',
        '',
        'Failing command:',
        '  ' + cmd,
        '',
        'Failure excerpt:',
        excerpt.split('\n').map(function (l) { return '  ' + l; }).join('\n'),
        '',
        'Backprop instructions:',
        '  1. TRACE the failure to a spec requirement in .forge/specs/',
        '  2. CLASSIFY the gap (missing_criterion / incomplete_criterion / missing_requirement)',
        '  3. PROPOSE a spec update (and apply it after the user confirms)',
        '  4. GENERATE a regression test that would have caught this failure',
        '  5. LOG the entry in .forge/history/backprop-log.md',
        '',
        'If after step 1 you determine the failure is environmental (network, missing tool,',
        'flaky external service) and not a spec gap, log that determination and skip backprop.',
        '',
        'After backprop completes (or is skipped), resume the original task:',
        '',
        '═══ ORIGINAL PROMPT ═══',
        '',
      ];
      console.log(lines.join('\n'));
    } catch (e) {
      console.log('');
    }
  " 2>>"$DEBUG_LOG" || echo "")

  if [ -n "$AUTOBP_PREFIX" ]; then
    NEXT_PROMPT="${AUTOBP_PREFIX}
${NEXT_PROMPT}"
    echo "[$(date -Iseconds)] auto-backprop directive injected" >> "$DEBUG_LOG"
  fi

  # Clear the flag file (idempotent — never re-fire on the same failure).
  rm -f "$AUTOBP_FLAG" 2>/dev/null || true

  # Clear the state.md flag so the TUI dashboard banner goes away.
  if [ -f "$STATE_FILE" ]; then
    node -e "
      try {
        const fs = require('fs');
        let c = fs.readFileSync('${STATE_FILE}', 'utf8');
        c = c.replace(/^\s*auto_backprop_pending\s*:.*$/m, 'auto_backprop_pending: false');
        fs.writeFileSync('${STATE_FILE}', c);
      } catch (e) {}
    " 2>>"$DEBUG_LOG" || true
  fi
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
