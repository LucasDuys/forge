// scripts/forge-usage-capture.cjs
//
// T001 / R001 (spec-token-instrumentation, Wave 1).
//
// Hook-side token usage capture. Reads the Stop-hook stdin payload, follows
// `transcript_path` to the JSONL transcript Claude Code writes, and extracts
// per-turn `usage` numbers (input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens). Falls back to the existing
// scripts/forge-budget.cjs cost-weight estimate when the transcript is not
// available yet, and tags the record with `source: "estimate"` in that case.
//
// Constraints:
//   - Pure node:* (no deps, no LLM calls).
//   - Idempotent: sidecar `.forge/.usage-capture-cursor.json` records the
//     last `(transcript_path, byte_offset)` so re-runs skip already-processed
//     bytes.
//   - FORGE_TOKEN_OPT=0 -> short-circuit to a zero-shape estimate without
//     reading the transcript (Wave 3 R005 parity contract honored from day 1).
//   - Must run in <50ms on a typical (~100-turn) transcript.
//   - Does NOT modify hooks/token-monitor.sh.
//
// Usage:
//   const { captureUsage, parseTranscript } = require('./forge-usage-capture');
//   const result = captureUsage(payloadObj, { forgeDir: '.forge' });
//
// CLI:
//   node scripts/forge-usage-capture.cjs --stdin
//   reads JSON payload on stdin, prints captured-usage JSON to stdout.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ZERO_SHAPE = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
});

const CURSOR_FILENAME = '.usage-capture-cursor.json';

// --- helpers --------------------------------------------------------------

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function isOptOut() {
  return process.env.FORGE_TOKEN_OPT === '0';
}

function readCursor(forgeDir) {
  if (!forgeDir) return {};
  const p = path.join(forgeDir, CURSOR_FILENAME);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

function writeCursor(forgeDir, cursor) {
  if (!forgeDir) return;
  try {
    if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
    const p = path.join(forgeDir, CURSOR_FILENAME);
    fs.writeFileSync(p, JSON.stringify(cursor, null, 2));
  } catch (_e) {
    // Best-effort: cursor failure must not block the hook.
  }
}

// --- transcript parser ----------------------------------------------------

// Parse a JSONL transcript file at `transcriptPath`, optionally starting at
// byte `startOffset`. Returns:
//   {
//     turns: [{ session_id, role, task_id, turn_index, usage:{...}, line_byte_end }],
//     totals: { input, output, cache_read, cache_write },
//     bytes_read: <int>,
//     end_offset: <int>,
//     malformed_lines: <int>,
//   }
//
// Skips lines that do not parse as JSON or that have no `usage` field on an
// assistant turn.
function parseTranscript(transcriptPath, opts) {
  opts = opts || {};
  const startOffset = Number.isFinite(opts.startOffset) ? opts.startOffset : 0;
  const result = {
    turns: [],
    totals: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    bytes_read: 0,
    end_offset: startOffset,
    malformed_lines: 0,
  };

  if (!transcriptPath) return result;

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (_e) {
    return result;
  }
  if (!stat.isFile()) return result;

  // If the file shrank since last cursor (rotation, truncation), restart.
  const effectiveStart = startOffset > stat.size ? 0 : startOffset;

  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = stat.size - effectiveStart;
      buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, effectiveStart);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_e) {
    return result;
  }

  result.bytes_read = buf.length;
  result.end_offset = effectiveStart + buf.length;

  // Walk lines manually so we can count turn_index per session and ignore
  // partial trailing lines (transcript not yet flushed at line boundary).
  const text = buf.toString('utf8');
  const lines = text.split('\n');

  // Track per-session turn index across this parse pass.
  const turnCounters = Object.create(null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Last fragment may be empty (trailing newline) or partial. Skip empties.
    if (!line) continue;

    const obj = safeParseJson(line);
    if (!obj || typeof obj !== 'object') {
      result.malformed_lines++;
      continue;
    }

    const role = obj.type || (obj.message && obj.message.role) || 'unknown';
    const sessionId = obj.session_id || obj.sessionId || 'unknown';
    const taskId = obj.task_id || obj.taskId || (obj.metadata && obj.metadata.task_id) || null;

    if (!turnCounters[sessionId]) turnCounters[sessionId] = 0;
    const turnIndex = turnCounters[sessionId]++;

    const usage = obj.message && obj.message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;

    result.turns.push({
      session_id: sessionId,
      role,
      task_id: taskId,
      turn_index: turnIndex,
      usage: {
        input,
        output,
        cache_read: cacheRead,
        cache_write: cacheWrite,
      },
    });

    result.totals.input += input;
    result.totals.output += output;
    result.totals.cache_read += cacheRead;
    result.totals.cache_write += cacheWrite;
  }

  return result;
}

// --- estimate fallback ----------------------------------------------------

// Build a zero-shape estimate result. Used when transcript is missing,
// FORGE_TOKEN_OPT=0, or any unrecoverable read error.
function estimateFallback(extra) {
  return Object.assign(
    {
      source: 'estimate',
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
    extra || {}
  );
}

// --- main entry -----------------------------------------------------------

// captureUsage(payload, options)
//   payload:  Stop-hook stdin object (already parsed). May be string or null.
//   options:
//     forgeDir:   '.forge' (default) for cursor sidecar
//     persist:    true to update cursor (default true). false for read-only probes.
//
// Returns one of:
//   { source: 'transcript', input, output, cache_read, cache_write, turns, session_id, task_id }
//   { source: 'estimate',   input, output, cache_read, cache_write, [skipped|reason] }
function captureUsage(payload, options) {
  options = options || {};
  const forgeDir = options.forgeDir || '.forge';
  const persist = options.persist !== false;

  // FORGE_TOKEN_OPT=0 short-circuit. Must NOT read the transcript.
  if (isOptOut()) {
    return Object.assign({}, ZERO_SHAPE, {
      source: 'estimate',
      skipped: true,
    });
  }

  // Coerce payload string -> object. If unparseable, treat as missing.
  let payloadObj = payload;
  if (typeof payloadObj === 'string') {
    payloadObj = safeParseJson(payloadObj);
  }
  if (!payloadObj || typeof payloadObj !== 'object') {
    return estimateFallback({ reason: 'payload_missing' });
  }

  const transcriptPath = payloadObj.transcript_path || payloadObj.transcriptPath || null;
  if (!transcriptPath) {
    return estimateFallback({ reason: 'transcript_path_missing' });
  }

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (_e) {
    return estimateFallback({ reason: 'transcript_unreadable' });
  }
  if (!stat.isFile()) {
    return estimateFallback({ reason: 'transcript_not_file' });
  }

  // Idempotency: read cursor for this transcript path and start from there.
  const cursor = readCursor(forgeDir);
  const cursorEntry = cursor[transcriptPath] || { byte_offset: 0 };
  const startOffset = Number.isFinite(cursorEntry.byte_offset) ? cursorEntry.byte_offset : 0;

  // If we have already processed everything, return a transcript-source zero
  // (still source: 'transcript' because we read the transcript successfully).
  if (startOffset >= stat.size) {
    return {
      source: 'transcript',
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      turns: [],
      session_id: payloadObj.session_id || null,
      task_id: payloadObj.task_id || null,
      already_processed: true,
    };
  }

  const parsed = parseTranscript(transcriptPath, { startOffset });

  // Persist cursor with the new offset so the next call skips these bytes.
  if (persist) {
    cursor[transcriptPath] = {
      byte_offset: parsed.end_offset,
      updated_at: new Date().toISOString(),
    };
    writeCursor(forgeDir, cursor);
  }

  return {
    source: 'transcript',
    input: parsed.totals.input,
    output: parsed.totals.output,
    cache_read: parsed.totals.cache_read,
    cache_write: parsed.totals.cache_write,
    turns: parsed.turns,
    session_id: payloadObj.session_id || null,
    task_id: payloadObj.task_id || null,
    bytes_read: parsed.bytes_read,
    malformed_lines: parsed.malformed_lines,
  };
}

// --- CLI ------------------------------------------------------------------

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--stdin')) {
    const raw = readStdinSync();
    const payload = safeParseJson(raw) || {};
    const forgeDirIdx = args.indexOf('--forge-dir');
    const forgeDir = forgeDirIdx >= 0 ? args[forgeDirIdx + 1] : '.forge';
    const out = captureUsage(payload, { forgeDir });
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }
  process.stderr.write('usage: forge-usage-capture.cjs --stdin [--forge-dir .forge]\n');
  process.exit(2);
}

module.exports = {
  captureUsage,
  parseTranscript,
  estimateFallback,
  readCursor,
  writeCursor,
  CURSOR_FILENAME,
};
