#!/usr/bin/env node
// PostToolUse hook -- stores results of cacheable tool calls
// Companion to tool-cache.js (PreToolUse)
// Matcher: "Bash|Grep|Glob|Read"
//
// Wave 2 / R005: also exposes `recordCacheEvent` for the cache-stats rolling
// log. Required by scripts/forge-tools.cjs::aggregateCacheStats and (in T003)
// by hooks/tool-cache.js itself once pattern broadening lands.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_CACHED_OUTPUT = 8000;

// Rolling-log retention: target last N lines. We append on every event and
// compact (rewrite) only when the file grows past N + slack. The slack avoids
// a rewrite on every single append while keeping the file bounded in practice.
const CACHE_STATS_TARGET_LINES = 1000;
const CACHE_STATS_COMPACT_THRESHOLD = 1100;

function hashInput(toolName, toolInput) {
  const key = JSON.stringify({ toolName, toolInput });
  return crypto.createHash('md5').update(key).digest('hex');
}

// recordCacheEvent({ tool, pattern_class, hit, age_ms, output_bytes }, options)
//
// Appends a single JSON line to <forgeDir>/cache-stats.jsonl describing one
// cache lookup. If the file exceeds CACHE_STATS_COMPACT_THRESHOLD lines after
// the append, it is rewritten with only the last CACHE_STATS_TARGET_LINES
// lines preserved.
//
// Defensive: never throws. On any error returns { written: false, error }.
// FORGE_TOKEN_OPT=0 short-circuits to a no-op return { written: false,
// disabled: true } before touching the filesystem.
//
// Returns { written: true, compacted: bool } on success.
function recordCacheEvent(event, options) {
  if (process.env.FORGE_TOKEN_OPT === '0') {
    return { written: false, disabled: true };
  }
  const opts = options || {};
  const forgeDir = opts.forgeDir || '.forge';

  const ev = event || {};
  const record = {
    ts: Date.now(),
    tool: typeof ev.tool === 'string' ? ev.tool : '',
    pattern_class: typeof ev.pattern_class === 'string' ? ev.pattern_class : '',
    hit: !!ev.hit,
    age_ms: Number(ev.age_ms) || 0,
    output_bytes: Number(ev.output_bytes) || 0,
  };
  const line = JSON.stringify(record) + '\n';
  const target = path.join(forgeDir, 'cache-stats.jsonl');

  try {
    if (!fs.existsSync(forgeDir)) {
      fs.mkdirSync(forgeDir, { recursive: true });
    }
    fs.appendFileSync(target, line);
  } catch (e) {
    process.stderr.write('[tool-cache-store] failed to append cache-stats: ' + (e && e.message) + '\n');
    return { written: false, error: (e && e.message) || String(e) };
  }

  // Compaction: read back, count lines, trim if over threshold. We only do
  // the trim on overage so the hot path stays at one append in steady state.
  let compacted = false;
  try {
    const buf = fs.readFileSync(target, 'utf8');
    // Split on \n, drop the trailing empty entry produced by the final newline.
    const all = buf.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    if (all.length > CACHE_STATS_COMPACT_THRESHOLD) {
      const kept = all.slice(all.length - CACHE_STATS_TARGET_LINES);
      fs.writeFileSync(target, kept.join('\n') + '\n');
      compacted = true;
    }
  } catch (e) {
    // Compaction failure is non-fatal: the append already succeeded.
    process.stderr.write('[tool-cache-store] compaction skipped: ' + (e && e.message) + '\n');
  }

  return { written: true, compacted };
}

module.exports = {
  recordCacheEvent,
  CACHE_STATS_TARGET_LINES,
  CACHE_STATS_COMPACT_THRESHOLD,
};

// Hook entry point: only run the stdin handler when this file is invoked
// directly (e.g. by Claude Code's PostToolUse hook). When required as a
// module from tests or scripts/forge-tools.cjs, skip the stdin block so the
// process does not block on stdin.
if (require.main === module) {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      const data = JSON.parse(input);
      const sessionId = data.session_id || 'default';
      const toolName = data.tool_name;
      const toolInput = data.tool_input || {};
      const output = typeof data.tool_output === 'string'
        ? data.tool_output
        : JSON.stringify(data.tool_output);

      if (!output || output.length > MAX_CACHED_OUTPUT) process.exit(0);
      if (!['Bash', 'Grep', 'Glob', 'Read'].includes(toolName)) process.exit(0);

      const cacheDir = path.join(os.tmpdir(), `forge-tool-cache-${sessionId}`);
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

      const hash = hashInput(toolName, toolInput);
      fs.writeFileSync(
        path.join(cacheDir, `${hash}.json`),
        JSON.stringify({ timestamp: Date.now(), output })
      );
    } catch (e) { /* silent */ }
    process.exit(0);
  });
}
