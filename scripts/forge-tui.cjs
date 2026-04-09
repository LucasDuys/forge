#!/usr/bin/env node
// forge-tui.cjs — Interactive dashboard for the Forge autonomous runner.
//
// Zero-dependency TUI wrapping `claude -p --output-format stream-json --verbose`.
// Parses the line-delimited JSON stream, reconciles with .forge/ state files,
// and renders a live dashboard using ANSI escape sequences.
//
// Entry points:
//   node scripts/forge-tui.cjs                 # run with defaults
//   FORGE_TUI=1 bash scripts/forge-runner.sh   # invoked via runner bridge
//   /forge watch                               # slash command wrapper
//
// See .forge/specs/spec-tui-dashboard.md for the full spec.
// Uses only Node built-ins: child_process, fs, path, readline, process, os.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ============================================================================
// SECTION 1 — CLI arg parsing and --help (T001, R001)
// ============================================================================

const DEFAULTS = {
  maxRestarts: parseInt(process.env.FORGE_MAX_RESTARTS || '10', 10),
  baseDelay: parseInt(process.env.FORGE_BASE_DELAY || '3', 10),
  transcriptLines: 50,
  noFallback: process.env.FORGE_TUI_NO_FALLBACK === '1',
  forgeDir: '.forge',
  contextLimit: 200000,
};

// Sentinel exit codes (R007)
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_FALLBACK = 87;    // TUI self-abort -> runner bash should fall back
const EXIT_NOT_FOUND = 127;  // convention: command not found

function parseArgs(argv) {
  const args = { ...DEFAULTS, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--max-restarts') { args.maxRestarts = parseInt(argv[++i], 10); }
    else if (a === '--base-delay') { args.baseDelay = parseInt(argv[++i], 10); }
    else if (a === '--transcript-lines') { args.transcriptLines = parseInt(argv[++i], 10); }
    else if (a === '--no-fallback') { args.noFallback = true; }
    else if (a === '--forge-dir') { args.forgeDir = argv[++i]; }
    else {
      process.stderr.write(`forge-tui: unknown arg "${a}"\n`);
      process.exit(EXIT_ERROR);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'forge-tui — interactive dashboard for the Forge autonomous runner',
    '',
    'Usage:',
    '  node scripts/forge-tui.cjs [options]',
    '',
    'Options:',
    '  --max-restarts N        Max Claude restart attempts (default 10, env FORGE_MAX_RESTARTS)',
    '  --base-delay N          Base backoff delay seconds (default 3, env FORGE_BASE_DELAY)',
    '  --transcript-lines N    Transcript ring buffer size (default 50)',
    '  --no-fallback           Do not exit with fallback sentinel (env FORGE_TUI_NO_FALLBACK)',
    '  --forge-dir PATH        Path to .forge directory (default ./.forge)',
    '  -h, --help              Show this help',
    '',
    'Env vars:',
    '  FORGE_TUI=1             When set, scripts/forge-runner.sh delegates to this TUI',
    '  FORGE_MAX_RESTARTS      Override --max-restarts',
    '  FORGE_BASE_DELAY        Override --base-delay',
    '  FORGE_TUI_NO_FALLBACK   Disable the exit-code-87 fallback contract',
    '',
    'Exit codes:',
    '  0   forge run completed or task blocked (clean exit)',
    '  1   error or max restarts reached',
    '  87  TUI self-abort (runner bash should fall back to plain mode)',
    '',
  ].join('\n'));
}

// ============================================================================
// SECTION 2 — TuiState persistence (T002, R004)
// ============================================================================
//
// .forge/.tui-state.json caches data that must survive the Claude child
// process being killed and restarted (context reset). Without this, the
// dashboard flickers to zero on every restart.
//
// Schema:
//   {
//     frontier_total: number,
//     completed_task_ids: string[],
//     last_tokens: { input: number, output: number, cache_read: number },
//     restart_count: number,
//     updated_at: ISO8601 string
//   }

const TuiState = {
  path(forgeDir) { return path.join(forgeDir, '.tui-state.json'); },

  default() {
    return {
      frontier_total: 0,
      completed_task_ids: [],
      last_tokens: { input: 0, output: 0, cache_read: 0 },
      restart_count: 0,
      updated_at: new Date().toISOString(),
    };
  },

  load(forgeDir) {
    const p = TuiState.path(forgeDir);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so old state files don't crash on schema additions.
      return Object.assign(TuiState.default(), parsed);
    } catch (e) {
      return TuiState.default();
    }
  },

  save(forgeDir, state) {
    const p = TuiState.path(forgeDir);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      state.updated_at = new Date().toISOString();
      // Atomic write: write to tmp and rename, so a crash mid-write cannot
      // leave a half-written file that crashes the next load.
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, p);
    } catch (e) {
      // Non-fatal: dashboard keeps running without persistence.
    }
  },
};

// ============================================================================
// SECTION 3 — Terminal capability detection + ANSI helpers (T004, R010)
// ============================================================================

function detectCaps() {
  const isTTY = Boolean(process.stdout.isTTY);
  const term = process.env.TERM || '';
  const colorterm = process.env.COLORTERM || '';
  const isWindows = process.platform === 'win32';

  // UTF-8 support: most modern terminals; cmd.exe historically weak.
  // Heuristic: trust COLORTERM/WT_SESSION/TERM_PROGRAM as UTF-8 signals.
  const utf8 = Boolean(
    process.env.WT_SESSION ||
    process.env.TERM_PROGRAM ||
    colorterm ||
    /utf-?8/i.test(process.env.LANG || '') ||
    /utf-?8/i.test(process.env.LC_ALL || '')
  );

  // Color depth: 256-color for xterm-256color / truecolor signals, else 16.
  let colors = 16;
  if (/256color/.test(term) || colorterm === 'truecolor' || colorterm === '24bit') {
    colors = 256;
  }

  return { isTTY, utf8, colors, isWindows, term, colorterm };
}

const ANSI = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  hideCursor:'\x1b[?25l',
  showCursor:'\x1b[?25h',
  clear:     '\x1b[2J',
  clearLine: '\x1b[2K',
  home:      '\x1b[H',
  // 16-color basics
  red:       '\x1b[31m',
  green:     '\x1b[32m',
  yellow:    '\x1b[33m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  cyan:      '\x1b[36m',
  white:     '\x1b[37m',
  gray:      '\x1b[90m',
  bgRed:     '\x1b[41m',
  move(row, col) { return `\x1b[${row};${col}H`; },
};

function enableRawTerminal(caps) {
  if (!caps.isTTY) return;
  process.stdout.write(ANSI.hideCursor);
  process.stdout.write(ANSI.clear);
  process.stdout.write(ANSI.home);
}

function restoreTerminal(caps) {
  if (!caps.isTTY) return;
  process.stdout.write(ANSI.showCursor);
  process.stdout.write(ANSI.reset);
  process.stdout.write('\n');
}

// ============================================================================
// SECTION 4 — Log writer with 10k-line truncation (T005, R009)
// ============================================================================
//
// Every parsed stream-json event is mirrored to .forge/.tui-log.jsonl for
// post-mortem debugging. The file is truncated to its last 10_000 lines on
// TUI startup to prevent unbounded growth.

const MAX_LOG_LINES = 10000;

const TuiLog = {
  path(forgeDir) { return path.join(forgeDir, '.tui-log.jsonl'); },

  truncateOnStartup(forgeDir) {
    const p = TuiLog.path(forgeDir);
    try {
      if (!fs.existsSync(p)) return;
      const raw = fs.readFileSync(p, 'utf8');
      const lines = raw.split('\n');
      if (lines.length <= MAX_LOG_LINES + 1) return;
      const kept = lines.slice(-MAX_LOG_LINES - 1).join('\n');
      fs.writeFileSync(p, kept);
    } catch (e) {
      // Non-fatal.
    }
  },

  append(forgeDir, event) {
    const p = TuiLog.path(forgeDir);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const line = JSON.stringify({ ...event, appended_at: new Date().toISOString() }) + '\n';
      fs.appendFileSync(p, line);
    } catch (e) {
      // Non-fatal.
    }
  },
};

// ============================================================================
// SECTION 5 — Stream-JSON parser with chunk-boundary-safe line buffer (T006, R002)
// ============================================================================
//
// `claude -p --output-format stream-json --verbose` emits one JSON object per
// line over stdout. Chunks from child_process stdout do NOT respect line
// boundaries — a single read can span multiple lines OR split a line in half.
// StreamParser.feed() accumulates chunks in `buffer`, splits on '\n', parses
// each complete line, and retains any trailing partial line for the next feed.
//
// The parser also tracks agent attribution (T008, R005): when it sees a
// tool_use with name "Task" and input.subagent_type, it pushes onto an
// activeSubagent stack keyed by tool_use_id; the matching tool_result pops.
//
// Malformed JSON lines are logged to .tui-log.jsonl with parse_error:true and
// counted — three consecutive parse failures triggers the fallback sentinel.

const MAX_CONSECUTIVE_PARSE_ERRORS = 3;

class StreamParser {
  constructor({ forgeDir, onEvent, onFatal } = {}) {
    this.buffer = '';
    this.forgeDir = forgeDir;
    this.onEvent = onEvent || (() => {});
    this.onFatal = onFatal || (() => {});
    this.consecutiveParseErrors = 0;

    // Agent attribution (T008) — stack of { subagent_type, tool_use_id }.
    // Top of stack is the currently active subagent. Empty stack = 'main'.
    this.agentStack = [];

    // Latest observations from events, surfaced to the renderer.
    this.latest = {
      activeTool: null,       // most recent tool_use name
      lastAssistantText: '',  // most recent assistant text snippet
      tokens: { input: 0, output: 0, cache_read: 0 },
      eventCount: 0,
      toolCount: 0,
    };
  }

  activeSubagent() {
    return this.agentStack.length > 0
      ? this.agentStack[this.agentStack.length - 1].subagent_type
      : 'main';
  }

  feed(chunk) {
    // Accept Buffer or string.
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this._handleLine(line);
    }
  }

  // Flush any trailing buffered content (called on stream end).
  end() {
    if (this.buffer.length > 0) {
      this._handleLine(this.buffer);
      this.buffer = '';
    }
  }

  _handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
      this.consecutiveParseErrors = 0;
    } catch (e) {
      this.consecutiveParseErrors++;
      TuiLog.append(this.forgeDir, { parse_error: true, raw: line, error: e.message });
      if (this.consecutiveParseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS) {
        this.onFatal(new Error(`${MAX_CONSECUTIVE_PARSE_ERRORS} consecutive parse errors`));
      }
      return;
    }

    TuiLog.append(this.forgeDir, event);
    this.latest.eventCount++;
    this._attribute(event);
    this._extractMetrics(event);
    this.onEvent(event, this.activeSubagent());
  }

  _attribute(event) {
    // Assistant tool_use: push subagent if Task, else record active tool.
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          this.latest.activeTool = block.name;
          this.latest.toolCount++;
          if (block.name === 'Task' && block.input && block.input.subagent_type) {
            this.agentStack.push({
              subagent_type: block.input.subagent_type,
              tool_use_id: block.id,
            });
          }
        } else if (block.type === 'text' && block.text) {
          this.latest.lastAssistantText = block.text.slice(0, 200);
        }
      }
    }
    // User tool_result: pop the matching Task frame if this result belongs
    // to one. Non-Task tool_results don't affect the stack.
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const top = this.agentStack[this.agentStack.length - 1];
          if (top && top.tool_use_id === block.tool_use_id) {
            this.agentStack.pop();
          }
        }
      }
    }
  }

  _extractMetrics(event) {
    if (event.type === 'result' && event.usage) {
      this.latest.tokens.input = event.usage.input_tokens || 0;
      this.latest.tokens.output = event.usage.output_tokens || 0;
      this.latest.tokens.cache_read = event.usage.cache_read_input_tokens || 0;
    }
  }
}

// ============================================================================
// SECTION 6 — State file poller + reconciler (T007, R004)
// ============================================================================
//
// StatePoller reads .forge/ files on a 500ms setInterval and exposes a
// snapshot of the current forge state (phase, task, status, progress, tokens
// cumulative-from-disk). On startup it hydrates in-memory counters from
// .tui-state.json so restart-boundary data survives.

const POLL_INTERVAL_MS = 500;

class StatePoller {
  constructor({ forgeDir }) {
    this.forgeDir = forgeDir;
    this.persisted = TuiState.load(forgeDir);
    this.frontier = { total: 0, taskIds: [] };
    this.snapshot = this._empty();
    this.timer = null;
  }

  _empty() {
    return {
      phase: 'unknown',
      currentTask: null,
      taskStatus: 'unknown',
      blockedReason: null,
      loopActive: false,
      toolCount: 0,
      ledger: { input: 0, output: 0, cache_read: 0 },
      frontier: this.frontier,
      completedCount: this.persisted.completed_task_ids.length,
      restartCount: this.persisted.restart_count,
    };
  }

  start() {
    this._readAll();
    this.timer = setInterval(() => this._readAll(), POLL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot() { return this.snapshot; }

  // Reconciliation: merge in-memory parser totals with disk state. Disk wins
  // for phase/task/status, memory wins for transient per-event data.
  reconcile(parserLatest) {
    if (parserLatest.tokens.input > this.snapshot.ledger.input) {
      this.snapshot.ledger = { ...parserLatest.tokens };
    }
    this.snapshot.toolCount = Math.max(this.snapshot.toolCount, parserLatest.toolCount);
    return this.snapshot;
  }

  // Persist cumulative counters so the next restart re-hydrates without flicker.
  persist({ restartCount }) {
    this.persisted.restart_count = restartCount;
    this.persisted.last_tokens = { ...this.snapshot.ledger };
    this.persisted.frontier_total = this.frontier.total;
    TuiState.save(this.forgeDir, this.persisted);
  }

  _readAll() {
    const s = this._empty();

    // .forge/.forge-loop.json — existence indicates loop active.
    s.loopActive = fs.existsSync(path.join(this.forgeDir, '.forge-loop.json'));

    // .forge/state.md — YAML frontmatter block at top.
    try {
      const raw = fs.readFileSync(path.join(this.forgeDir, 'state.md'), 'utf8');
      const fm = parseFrontmatter(raw);
      if (fm.phase) s.phase = fm.phase;
      if (fm.current_task) s.currentTask = fm.current_task;
      if (fm.task_status) s.taskStatus = fm.task_status;
      if (fm.blocked_reason && fm.blocked_reason !== 'null') s.blockedReason = fm.blocked_reason;
    } catch (e) { /* file may not exist yet */ }

    // .forge/token-ledger.json — cumulative numeric usage.
    try {
      const raw = fs.readFileSync(path.join(this.forgeDir, 'token-ledger.json'), 'utf8');
      const ledger = JSON.parse(raw);
      if (ledger.actual && typeof ledger.actual === 'object') {
        s.ledger = {
          input: ledger.actual.input || 0,
          output: ledger.actual.output || 0,
          cache_read: ledger.actual.cache_read || 0,
        };
      }
    } catch (e) { /* optional */ }

    // .forge/.tool-count — integer counter incremented by token-monitor.sh.
    try {
      const raw = fs.readFileSync(path.join(this.forgeDir, '.tool-count'), 'utf8');
      s.toolCount = parseInt(raw.trim(), 10) || 0;
    } catch (e) { /* optional */ }

    // Newest .forge/plans/*-frontier.md — parse total_tasks from frontmatter.
    try {
      const plansDir = path.join(this.forgeDir, 'plans');
      const files = fs.readdirSync(plansDir)
        .filter((f) => f.endsWith('-frontier.md'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        const raw = fs.readFileSync(path.join(plansDir, files[0].f), 'utf8');
        const fm = parseFrontmatter(raw);
        if (fm.total_tasks) {
          this.frontier.total = parseInt(fm.total_tasks, 10) || 0;
        }
        // Extract task ids for a rough completed-count heuristic.
        const ids = (raw.match(/\[T\d{3}\]/g) || []).map((m) => m.slice(1, -1));
        this.frontier.taskIds = Array.from(new Set(ids));
      }
    } catch (e) { /* optional */ }

    s.frontier = this.frontier;
    s.completedCount = this.persisted.completed_task_ids.length;
    s.restartCount = this.persisted.restart_count;

    // Preserve ledger high-water mark from parser reconciliation across ticks.
    if (this.snapshot.ledger.input > s.ledger.input) s.ledger = this.snapshot.ledger;

    this.snapshot = s;
  }
}

// Tiny YAML frontmatter parser — handles the `key: value` subset Forge uses.
// Avoids the need to pull in js-yaml (zero-dep constraint).
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// ============================================================================
// SECTION 7 — main() entry (Tier 2 skeleton; runner/renderer wire in Tier 3)
// ============================================================================

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(EXIT_OK); }

  // Tier 1 wiring — foundational modules initialized.
  // Later tiers add: parser (T006), poller (T007), attribution (T008),
  // renderer (T010), runner semantics (T011), fallback contract (T012).
  TuiLog.truncateOnStartup(args.forgeDir);
  const caps = detectCaps();
  const persisted = TuiState.load(args.forgeDir);

  // Guard: non-TTY invocation is a fallback signal (see R010). For now,
  // exit with the fallback sentinel so forge-runner.sh uses the plain path.
  if (!caps.isTTY) {
    process.stderr.write('FORGE_TUI_FALLBACK: stdout is not a TTY\n');
    process.exit(args.noFallback ? EXIT_ERROR : EXIT_FALLBACK);
  }

  // Placeholder until renderer/runner land — emit a diagnostic frame so
  // manual smoke tests of the scaffold produce visible output.
  enableRawTerminal(caps);
  process.stdout.write(`${ANSI.bold}forge-tui${ANSI.reset} (scaffold)\n`);
  process.stdout.write(`  forge dir:      ${args.forgeDir}\n`);
  process.stdout.write(`  caps:           ${JSON.stringify(caps)}\n`);
  process.stdout.write(`  restart cache:  ${persisted.restart_count}\n`);
  process.stdout.write(`  frontier total: ${persisted.frontier_total}\n`);
  restoreTerminal(caps);
  process.exit(EXIT_OK);
}

// Export for tests (run.cjs loads this with require()).
module.exports = {
  DEFAULTS,
  EXIT_OK, EXIT_ERROR, EXIT_FALLBACK, EXIT_NOT_FOUND,
  parseArgs, printHelp,
  TuiState,
  detectCaps, ANSI, enableRawTerminal, restoreTerminal,
  TuiLog, MAX_LOG_LINES,
  StreamParser, MAX_CONSECUTIVE_PARSE_ERRORS,
  StatePoller, POLL_INTERVAL_MS, parseFrontmatter,
};

// Only run main() when invoked as a script, not when require()'d by tests.
if (require.main === module) {
  main();
}
