#!/usr/bin/env node
// PostToolUse hook -- detects runtime test failures and queues auto-backprop.
// Matcher: "Bash"
//
// Reads PostToolUse JSON from stdin. If the tool was a Bash invocation
// running a recognised test runner AND the output contains failure markers,
// writes a flag file at .forge/.auto-backprop-pending.json with the captured
// failure context. The Forge state machine (or the user's next /forge resume)
// picks up the flag and runs /forge backprop automatically before continuing.
//
// Opt-out: set auto_backprop:false in .forge/config.json or set the env var
// FORGE_AUTO_BACKPROP=0. Default is on -- it costs nothing when no failures
// occur because the hook exits immediately on non-test output.
//
// This hook is the *trigger* side of auto-backprop. The *consumer* side
// lives in stop-hook.sh which prepends a backprop request to the next
// prompt when the flag file exists.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 3000;
const MAX_CONTEXT_BYTES = 4000;  // truncate failure capture to keep state lean

// Test runner detection -- same family as test-output-filter.js so the two
// hooks fire on identical command sets.
const TEST_COMMANDS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\bnpx\s+test\b/,
  /\bmocha\b/,
  /\bnode\s+--test\b/,
  /\bnode\s+.*run-tests\.cjs\b/,
];

// Failure signal patterns. We require BOTH a runner match AND a failure
// pattern -- prevents false positives from grep output, build noise, etc.
const FAILURE_PATTERNS = [
  /\bFAIL\b/,
  /\bFAILED\b/,
  /AssertionError/,
  /Error: expect/,
  /^\s*not ok\s+\d+/m,
  /\d+ failing/,
  /\d+ failed/,
  /Tests:\s+\d+\s+failed/,
];

// Patterns that indicate a successful run -- override failure detection so
// `0 failed` doesn't trip on the literal word "failed".
const SUCCESS_PATTERNS = [
  /\b0 failing\b/,
  /\b0 failed\b/,
  /Tests:\s+0\s+failed/,
];

function isTestCommand(cmd) {
  for (const re of TEST_COMMANDS) if (re.test(cmd)) return true;
  return false;
}

function looksLikeFailure(output) {
  if (SUCCESS_PATTERNS.some((re) => re.test(output))) return false;
  return FAILURE_PATTERNS.some((re) => re.test(output));
}

// Find the .forge directory by walking up from CWD. Hooks run with CWD set
// to the project root by Claude Code, so this should usually find it on the
// first try.
function findForgeDir() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.forge');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Read .forge/config.json and check the auto_backprop opt-out.
function isEnabled(forgeDir) {
  if (process.env.FORGE_AUTO_BACKPROP === '0') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(forgeDir, 'config.json'), 'utf8'));
    if (cfg.auto_backprop === false) return false;
  } catch (e) { /* config missing -> default on */ }
  return true;
}

// Capture the most relevant slice of the failure output -- failure lines
// plus 4 lines of context above and below, capped at MAX_CONTEXT_BYTES.
function captureFailureContext(output) {
  const lines = output.split('\n');
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeFailure(lines[i])) {
      for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 8); j++) {
        keep.add(j);
      }
    }
  }
  // Always include the last 5 lines (test summary tail).
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) keep.add(i);
  const sorted = Array.from(keep).sort((a, b) => a - b);
  let captured = sorted.map((i) => lines[i]).join('\n');
  if (captured.length > MAX_CONTEXT_BYTES) {
    captured = captured.slice(0, MAX_CONTEXT_BYTES) + '\n...(truncated)';
  }
  return captured;
}

function writeFlagFile(forgeDir, payload) {
  const flagPath = path.join(forgeDir, '.auto-backprop-pending.json');
  // If a flag already exists, do not overwrite -- the queued failure should
  // be handled before a new one is captured. This also makes the hook
  // idempotent across PostToolUse fires for the same failure.
  if (fs.existsSync(flagPath)) return false;
  try {
    fs.writeFileSync(flagPath, JSON.stringify(payload, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

// Also flip the auto_backprop_pending flag in state.md frontmatter so the
// TUI dashboard's BACKPROP banner lights up. We do a minimal in-place edit
// without disturbing the rest of the file.
function setStatePendingFlag(forgeDir) {
  const statePath = path.join(forgeDir, 'state.md');
  try {
    let content = fs.readFileSync(statePath, 'utf8');
    if (/^\s*auto_backprop_pending\s*:/m.test(content)) {
      content = content.replace(/^\s*auto_backprop_pending\s*:.*$/m, 'auto_backprop_pending: true');
    } else {
      // Insert before the closing --- of the frontmatter
      content = content.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, '$1\nauto_backprop_pending: true$2');
    }
    fs.writeFileSync(statePath, content);
  } catch (e) { /* state.md missing -> non-fatal, flag file still written */ }
}

function main() {
  const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);
  if (timer.unref) timer.unref();

  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try {
      const raw = chunks.join('');
      if (!raw.trim()) return process.exit(0);

      const payload = JSON.parse(raw);
      if ((payload.tool_name || '') !== 'Bash') return process.exit(0);

      const command = (payload.tool_input && payload.tool_input.command) || '';
      const output = payload.tool_output || '';

      if (!isTestCommand(command)) return process.exit(0);
      if (!looksLikeFailure(output)) return process.exit(0);

      const forgeDir = findForgeDir();
      if (!forgeDir) return process.exit(0);
      if (!isEnabled(forgeDir)) return process.exit(0);

      const failureContext = captureFailureContext(output);
      const wrote = writeFlagFile(forgeDir, {
        triggered_at: new Date().toISOString(),
        command: command.slice(0, 500),
        failure_excerpt: failureContext,
        hook: 'auto-backprop',
      });
      if (wrote) {
        setStatePendingFlag(forgeDir);
        // Optional stderr line for visibility -- Claude Code surfaces
        // PostToolUse stderr in the transcript at debug log level.
        process.stderr.write('[forge] auto-backprop queued: test failure detected\n');
      }
      process.exit(0);
    } catch (e) {
      // Never crash the host process -- swallow and move on.
      process.exit(0);
    }
  });
}

if (require.main === module) main();

// Export internals for unit tests.
module.exports = {
  isTestCommand,
  looksLikeFailure,
  captureFailureContext,
  isEnabled,
  writeFlagFile,
  setStatePendingFlag,
  findForgeDir,
  TEST_COMMANDS,
  FAILURE_PATTERNS,
  SUCCESS_PATTERNS,
};
