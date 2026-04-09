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
    // Forge templates use literal "null" strings for unset fields (v2.1
    // template/state.md has phase: idle, current_task: null, ...).
    // Treat "null" the same as missing so dashboard fallbacks work.
    const nonNull = (v) => (v && v !== 'null' ? v : null);
    try {
      const raw = fs.readFileSync(path.join(this.forgeDir, 'state.md'), 'utf8');
      const fm = parseFrontmatter(raw);
      if (fm.phase) s.phase = fm.phase;
      const t = nonNull(fm.current_task); if (t) s.currentTask = t;
      const st = nonNull(fm.task_status); if (st) s.taskStatus = st;
      s.blockedReason = nonNull(fm.blocked_reason);
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
// SECTION 7 — Renderer: 5-region ANSI dashboard with transcript ring buffer (T010, R003 + R009)
// ============================================================================
//
// Five regions:
//   1. Header line              — "Forge" + "phase X/Y"
//   2. Status block (3 lines)   — task / agent+tool / progress bar
//   3. Token+meter line         — input/output/cached + restarts + context%
//   4. Separator
//   5. Transcript pane          — ring buffer of last N events
//
// Rendered as a single string per frame and written in one stdout.write to
// minimize tearing. 10Hz tick (setInterval 100ms). The renderer DOES NOT
// react to individual events — it always reads the latest snapshot. This
// keeps the data flow one-way and avoids race conditions.

const MIN_COLS = 80;
const MIN_ROWS = 24;
const RENDER_INTERVAL_MS = 100;

class Renderer {
  constructor({ caps, args, poller, parser }) {
    this.caps = caps;
    this.args = args;
    this.poller = poller;
    this.parser = parser;
    this.transcript = [];   // ring buffer of { glyph, text }
    this.maxTranscript = args.transcriptLines;
    this.timer = null;
    this.alert = null;      // { kind: 'blocked'|'error', text }
    this.countdown = null;  // { remaining, total } during backoff
    this.lastFrame = '';
  }

  start() {
    this.timer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pushTranscript(glyph, text) {
    // Collapse multiline tool_result bodies to first line + (N more lines).
    const lines = String(text).split('\n');
    const display = lines.length > 1
      ? `${lines[0]} (${lines.length - 1} more lines)`
      : lines[0];
    this.transcript.push({ glyph, text: display });
    if (this.transcript.length > this.maxTranscript) {
      this.transcript.shift();
    }
  }

  setAlert(alert) { this.alert = alert; }
  clearAlert() { this.alert = null; }
  setCountdown(remaining, total) { this.countdown = { remaining, total }; }
  clearCountdown() { this.countdown = null; }

  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    if (cols < MIN_COLS || rows < MIN_ROWS) {
      const msg = `Terminal too small — resize to ${MIN_COLS}x${MIN_ROWS} (current ${cols}x${rows})`;
      const frame = ANSI.home + ANSI.clear + msg + '\n';
      if (frame !== this.lastFrame) {
        process.stdout.write(frame);
        this.lastFrame = frame;
      }
      return;
    }

    const snap = this.poller.getSnapshot();
    this.poller.reconcile(this.parser.latest);

    const frame = this._buildFrame(snap, cols, rows);
    if (frame !== this.lastFrame) {
      process.stdout.write(frame);
      this.lastFrame = frame;
    }
  }

  _buildFrame(snap, cols, rows) {
    const lines = [];
    lines.push(this._header(snap, cols));
    lines.push(this._statusLine(snap, cols));
    lines.push(this._agentLine(snap, cols));
    lines.push(this._progressLine(snap, cols));
    lines.push(this._tokenLine(snap, cols));
    lines.push(this._meterLine(snap, cols));
    lines.push(this._sep(cols));
    if (this.alert) lines.push(this._alertLine(this.alert, cols));
    if (this.countdown) lines.push(this._countdownLine(this.countdown, cols));
    lines.push(this._sep(cols, 'Transcript'));

    const overhead = lines.length + 2;
    const transcriptRows = Math.max(3, rows - overhead);
    const slice = this.transcript.slice(-transcriptRows);
    for (const t of slice) {
      lines.push(`  ${this._color('gray', t.glyph)} ${this._truncate(t.text, cols - 4)}`);
    }
    while (lines.length < rows - 1) lines.push('');

    return ANSI.home + ANSI.clear + lines.join('\n') + '\n';
  }

  _header(snap, cols) {
    const left = `${ANSI.bold}Forge${ANSI.reset} ${this._color('gray', '— interactive runner')}`;
    const phase = snap.phase || 'idle';
    const right = this._color('cyan', `phase: ${phase}`);
    return this._twoCol(left, right, cols);
  }

  _statusLine(snap, cols) {
    const task = snap.currentTask || '—';
    const status = snap.taskStatus || 'unknown';
    const statusColor = status === 'blocked' ? 'red'
                      : status === 'complete' ? 'green'
                      : 'yellow';
    return `  Task:   ${ANSI.bold}${task}${ANSI.reset}  ${this._color(statusColor, `[${status}]`)}`;
  }

  _agentLine(snap, cols) {
    const agent = this.parser.activeSubagent();
    const tool = this.parser.latest.activeTool || '—';
    return `  Agent:  ${this._color('magenta', agent)}   Tool: ${this._color('cyan', tool)}`;
  }

  _progressLine(snap, cols) {
    const total = snap.frontier.total || 0;
    const done = Math.min(snap.completedCount, total);
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    const barWidth = Math.min(40, cols - 30);
    const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
    const fillChar = this.caps.utf8 ? '\u2588' : '#';
    const emptyChar = this.caps.utf8 ? '\u2591' : '-';
    const bar = fillChar.repeat(filled) + emptyChar.repeat(barWidth - filled);
    return `  Tasks:  [${this._color('green', bar)}] ${done}/${total} (${pct}%)`;
  }

  _tokenLine(snap, cols) {
    const t = snap.ledger;
    return `  Tokens: ${this._fmtTokens(t.input)} in / ${this._fmtTokens(t.output)} out / ${this._fmtTokens(t.cache_read)} cached`;
  }

  _meterLine(snap, cols) {
    const ctxPct = Math.min(100, Math.floor((snap.ledger.input / this.args.contextLimit) * 100));
    const ctxColor = ctxPct >= 80 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green';
    return `  Meters: Restarts ${snap.restartCount}/${this.args.maxRestarts}   Context ${this._color(ctxColor, ctxPct + '%')}   Tools used ${snap.toolCount}`;
  }

  _alertLine(alert, cols) {
    const label = alert.kind === 'blocked' ? ' BLOCKED ' : ' ERROR ';
    return `  ${ANSI.bgRed}${ANSI.bold}${label}${ANSI.reset} ${this._color('red', alert.text)}`;
  }

  _countdownLine(c, cols) {
    return `  ${this._color('yellow', `Restarting in ${c.remaining}s... (${c.total - c.remaining + 1} of ${c.total})`)}`;
  }

  _sep(cols, label) {
    const line = '─'.repeat(Math.max(0, cols));
    if (!label) return this._color('gray', line);
    const tag = ` ${label} `;
    const left = '─'.repeat(2);
    const right = '─'.repeat(Math.max(0, cols - left.length - tag.length));
    return this._color('gray', left + tag + right);
  }

  _color(name, str) {
    if (!this.caps.isTTY) return str;
    const code = ANSI[name] || '';
    return `${code}${str}${ANSI.reset}`;
  }

  _fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'k';
    return String(n);
  }

  _truncate(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  _twoCol(left, right, cols) {
    // Strip ANSI for length math, then pad.
    const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    const pad = Math.max(1, cols - visibleLen(left) - visibleLen(right));
    return left + ' '.repeat(pad) + right;
  }
}

// ============================================================================
// SECTION 8 — Runner: spawn claude, restart loop, blocked/complete detection (T011, R006)
// ============================================================================
//
// Reimplements scripts/forge-runner.sh in JS, plus:
//   - spawns claude with --output-format stream-json --verbose
//   - pipes stdout into StreamParser
//   - countdown displayed in dashboard during backoff
//   - hydrates restart count from .tui-state.json so restarts survive process death
//
// Identical math to forge-runner.sh:
//   delay = base * 2^(restart-1), capped at 60
//   on non-zero child exit: delay *= 2, capped at 120

class Runner {
  constructor({ args, parser, poller, renderer }) {
    this.args = args;
    this.parser = parser;
    this.poller = poller;
    this.renderer = renderer;
    this.restartCount = poller.persisted.restart_count || 0;
    this.aborted = false;
    this.fatal = null;
  }

  abort(reason) {
    this.aborted = true;
    this.fatal = reason;
  }

  // Compute backoff delay matching forge-runner.sh integer arithmetic exactly.
  static computeDelay(baseDelay, restartCount, childExitedNonZero) {
    let delay = baseDelay;
    for (let i = 1; i < restartCount; i++) {
      delay *= 2;
      if (delay > 60) { delay = 60; break; }
    }
    if (childExitedNonZero) {
      delay *= 2;
      if (delay > 120) delay = 120;
    }
    return delay;
  }

  resumePromptPath() {
    return path.join(this.args.forgeDir, '.forge-resume.md');
  }

  async run() {
    while (true) {
      const resumePath = this.resumePromptPath();
      if (!fs.existsSync(resumePath)) {
        process.stderr.write(`No resume prompt found at ${resumePath}. Run /forge execute first.\n`);
        return EXIT_ERROR;
      }
      const prompt = fs.readFileSync(resumePath, 'utf8');

      this.renderer.pushTranscript('>', `Launching Claude (restart ${this.restartCount + 1}/${this.args.maxRestarts})`);

      const exitCode = await this._spawnOnce(prompt);

      if (this.aborted) {
        process.stderr.write(`FORGE_TUI_FALLBACK: ${this.fatal && this.fatal.message ? this.fatal.message : 'aborted'}\n`);
        return this.args.noFallback ? EXIT_ERROR : EXIT_FALLBACK;
      }

      // Completion: loop file removed.
      if (!fs.existsSync(path.join(this.args.forgeDir, '.forge-loop.json'))) {
        this.renderer.pushTranscript('=', 'Forge complete!');
        return EXIT_OK;
      }

      // Blocked: state.md task_status: blocked.
      const snap = this.poller.getSnapshot();
      if (snap.taskStatus === 'blocked') {
        this.renderer.setAlert({ kind: 'blocked', text: snap.blockedReason || 'task blocked, needs human input' });
        return EXIT_OK;
      }

      this.restartCount++;
      this.poller.persist({ restartCount: this.restartCount });

      if (this.restartCount >= this.args.maxRestarts) {
        this.renderer.setAlert({ kind: 'error', text: `Max restarts (${this.args.maxRestarts}) reached` });
        return EXIT_ERROR;
      }

      const delay = Runner.computeDelay(this.args.baseDelay, this.restartCount, exitCode !== 0);
      for (let s = delay; s > 0; s--) {
        this.renderer.setCountdown(s, delay);
        await sleep(1000);
        if (this.aborted) break;
      }
      this.renderer.clearCountdown();
    }
  }

  _spawnOnce(prompt) {
    return new Promise((resolve) => {
      const child = spawn('claude', [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      child.on('error', (err) => {
        // ENOENT means claude isn't on PATH — fallback sentinel via abort().
        this.abort(err.code === 'ENOENT'
          ? new Error('claude command not found on PATH')
          : err);
        resolve(EXIT_ERROR);
      });

      child.stdout.on('data', (chunk) => this.parser.feed(chunk));
      child.stderr.on('data', (chunk) => {
        // stderr lines are not stream-json — surface in transcript.
        const txt = chunk.toString('utf8').trim();
        if (txt) this.renderer.pushTranscript('!', txt);
      });

      child.on('close', (code) => {
        this.parser.end();
        resolve(code == null ? EXIT_ERROR : code);
      });
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SECTION 9 — main() entry (Tier 3 wired)
// ============================================================================

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(EXIT_OK); }

  TuiLog.truncateOnStartup(args.forgeDir);
  const caps = detectCaps();

  // Non-TTY invocation: emit a compact one-line-per-event stream and let the
  // runner still drive to completion. This satisfies R010 AC: "When isTTY is
  // false, TUI prints a one-line status per event instead of rendering the
  // full dashboard." We also don't exit with the fallback sentinel here — a
  // piped invocation is legitimate (e.g. CI logs), not a TUI failure.
  if (!caps.isTTY) {
    return runHeadless(args);
  }

  // Wire the pipeline: parser -> poller reconciles -> renderer reads snapshot.
  const poller = new StatePoller({ forgeDir: args.forgeDir });
  poller.start();

  const parser = new StreamParser({
    forgeDir: args.forgeDir,
    onEvent: (event, agent) => onEvent(event, agent, renderer),
    onFatal: (err) => runner.abort(err),
  });

  const renderer = new Renderer({ caps, args, poller, parser });
  const runner = new Runner({ args, parser, poller, renderer });

  enableRawTerminal(caps);
  renderer.start();

  // Terminal restore on any exit path.
  const cleanup = (code) => {
    renderer.stop();
    poller.stop();
    restoreTerminal(caps);
    process.exit(typeof code === 'number' ? code : EXIT_OK);
  };
  process.on('SIGINT', () => cleanup(EXIT_OK));
  process.on('SIGTERM', () => cleanup(EXIT_OK));

  try {
    const code = await runner.run();
    // One final frame so the completion/blocked banner is visible.
    renderer.render();
    cleanup(code);
  } catch (err) {
    process.stderr.write(`FORGE_TUI_FALLBACK: ${err && err.message ? err.message : err}\n`);
    cleanup(args.noFallback ? EXIT_ERROR : EXIT_FALLBACK);
  }
}

// Glyph mapping for transcript events.
function onEvent(event, agent, renderer) {
  if (!event || !event.type) return;
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        renderer.pushTranscript('>', `[${agent}] ${block.text}`);
      } else if (block.type === 'tool_use') {
        const inputHint = summarizeToolInput(block);
        renderer.pushTranscript('~', `${block.name}${inputHint ? ' ' + inputHint : ''}`);
      }
    }
  } else if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const body = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text || '').join('\n')
            : '';
        renderer.pushTranscript('=', body || '(ok)');
      }
    }
  } else if (event.type === 'result') {
    const u = event.usage || {};
    renderer.pushTranscript('>', `turn complete — ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`);
  }
}

function summarizeToolInput(block) {
  if (!block.input) return '';
  if (block.input.file_path) return String(block.input.file_path);
  if (block.input.pattern) return String(block.input.pattern);
  if (block.input.command) return String(block.input.command).slice(0, 60);
  if (block.input.subagent_type) return `→ ${block.input.subagent_type}`;
  return '';
}

// Headless mode: no dashboard, just tails events as single lines. Used when
// stdout is not a TTY (piped/CI). Still runs the full runner loop.
async function runHeadless(args) {
  const poller = new StatePoller({ forgeDir: args.forgeDir });
  poller.start();
  const parser = new StreamParser({
    forgeDir: args.forgeDir,
    onEvent: (event, agent) => {
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const b of event.message.content) {
          if (b.type === 'text' && b.text) process.stdout.write(`[${agent}] ${b.text}\n`);
          if (b.type === 'tool_use') process.stdout.write(`[${agent}] ~${b.name}\n`);
        }
      } else if (event.type === 'result' && event.usage) {
        process.stdout.write(`[result] ${event.usage.input_tokens}in/${event.usage.output_tokens}out\n`);
      }
    },
    onFatal: () => {},
  });
  // Render is a no-op stub for runner.run() — provide a minimal shim.
  const rendererStub = {
    pushTranscript: (_g, t) => process.stdout.write(t + '\n'),
    setAlert: (a) => process.stdout.write(`[ALERT ${a.kind}] ${a.text}\n`),
    clearAlert: () => {},
    setCountdown: (r) => process.stdout.write(`restart in ${r}s...\n`),
    clearCountdown: () => {},
    render: () => {},
  };
  const runner = new Runner({ args, parser, poller, renderer: rendererStub });
  const code = await runner.run();
  poller.stop();
  process.exit(code);
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
  Renderer, MIN_COLS, MIN_ROWS, RENDER_INTERVAL_MS,
  Runner,
};

// Only run main() when invoked as a script, not when require()'d by tests.
if (require.main === module) {
  main();
}
