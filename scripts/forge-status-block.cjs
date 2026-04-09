#!/usr/bin/env node
// forge-status-block.cjs — render a compact status snapshot of the current
// .forge/ run as a multi-line text block. Designed to be called from
// hooks/stop-hook.sh and prepended to every /forge:execute iteration prompt
// so the user sees what forge is doing automatically, without needing to
// switch to /forge:watch in a separate terminal.
//
// Usage:
//   node scripts/forge-status-block.cjs                      # default plain text
//   node scripts/forge-status-block.cjs --no-color           # strip ANSI codes
//   node scripts/forge-status-block.cjs --forge-dir PATH     # explicit forge dir
//   node scripts/forge-status-block.cjs --width N            # output column width
//
// Exit codes:
//   0  block printed
//   1  .forge dir not found (caller should treat as no-op)
//
// Reads (silently tolerates missing files):
//   .forge/state.md             — phase, current_task, task_status, blocked_reason
//   .forge/.forge-loop.json     — iteration count, max_iterations
//   .forge/.forge-loop.lock     — pid, last_heartbeat (lock display)
//   .forge/token-ledger.json    — cumulative token usage
//   .forge/task-status.json     — running task list
//   .forge/progress/{T###}.json — per-task checkpoint step + token usage
//   .forge/plans/*-frontier.md  — total task count for the progress bar
//   .forge/config.json          — per_task_budget, depth, status_header opt-out

'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) { printHelp(); process.exit(0); }

const FORGE_DIR = ARGS.forgeDir || '.forge';
const COLOR = ARGS.color !== false && process.env.NO_COLOR !== '1';
const WIDTH = ARGS.width || 72;

if (!fs.existsSync(FORGE_DIR)) {
  // No forge dir = no status block. Caller treats this as a clean no-op.
  process.exit(1);
}

// ─── Color helpers ────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m',
};
function c(color, str) { return COLOR ? `${ANSI[color] || ''}${str}${ANSI.reset}` : String(str); }

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function safeJSON(p) { const r = safeRead(p); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
function nonNull(v) { return (v && v !== 'null') ? v : null; }
function fmtK(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

function parseFrontmatter(raw) {
  const m = raw && raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!k) continue;
    let v = k[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k[1]] = v;
  }
  return out;
}

// ─── Read state ───────────────────────────────────────────────────────────

const stateFM = parseFrontmatter(safeRead(path.join(FORGE_DIR, 'state.md')));
const phase = stateFM.phase || 'unknown';
const currentTask = nonNull(stateFM.current_task);
const taskStatus = nonNull(stateFM.task_status) || 'pending';
const blockedReason = nonNull(stateFM.blocked_reason);

// Config opt-out check — caller already checks but double-check here too
// so direct invocations also respect the flag.
const config = safeJSON(path.join(FORGE_DIR, 'config.json')) || {};
if (config.execute && config.execute.status_header === false) {
  process.exit(1);
}

// Iteration / max from loop file
const loop = safeJSON(path.join(FORGE_DIR, '.forge-loop.json')) || {};
const iteration = loop.iteration || 0;
const maxIterations = loop.max_iterations || 100;

// Lock status (5-min stale threshold)
let lockLabel = c('gray', 'free');
const lock = safeJSON(path.join(FORGE_DIR, '.forge-loop.lock'));
if (lock && lock.pid) {
  const beatStr = lock.last_heartbeat || lock.heartbeat || '';
  const beatMs = Date.parse(beatStr);
  const ageMs = Number.isFinite(beatMs) ? Date.now() - beatMs : Infinity;
  const ageSec = Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : '?';
  const stale = ageMs > 5 * 60 * 1000;
  lockLabel = stale
    ? c('red', `STALE pid ${lock.pid}, ${ageSec}s ago`)
    : c('gray', `alive pid ${lock.pid}, ${ageSec}s ago`);
}

// Token ledger
const ledger = safeJSON(path.join(FORGE_DIR, 'token-ledger.json')) || {};
const actual = (ledger.actual && typeof ledger.actual === 'object') ? ledger.actual : {};
const tokIn = actual.input || 0;
const tokOut = actual.output || 0;
const tokCache = actual.cache_read || 0;

// Frontier total + completed count
let frontierTotal = 0;
let completedCount = 0;
try {
  const plansDir = path.join(FORGE_DIR, 'plans');
  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir)
      .filter((f) => f.endsWith('-frontier.md'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) {
      const fm = parseFrontmatter(safeRead(path.join(plansDir, files[0].f)));
      if (fm.total_tasks) frontierTotal = parseInt(fm.total_tasks, 10) || 0;
    }
  }
} catch (e) { /* ignore */ }
const reg = safeJSON(path.join(FORGE_DIR, 'task-status.json'));
if (reg && reg.tasks) {
  for (const t of Object.values(reg.tasks)) {
    if (t && t.status === 'complete') completedCount++;
  }
}

// Per-task: current step + tokens + budget
let currentStep = null, nextStep = null, currentTaskTokens = null;
if (currentTask) {
  const cp = safeJSON(path.join(FORGE_DIR, 'progress', `${currentTask}.json`));
  if (cp) {
    currentStep = cp.current_step || null;
    nextStep = cp.next_step || null;
    if (typeof cp.token_usage === 'number') currentTaskTokens = cp.token_usage;
  }
}

const ptb = (config && config.per_task_budget) || { quick: 5000, standard: 15000, thorough: 40000 };
const depth = (config && config.depth) || 'standard';
const currentTaskBudget = ptb[depth] || null;

// Running tasks for parallel summary
const runningTasks = (reg && reg.tasks)
  ? Object.keys(reg.tasks).filter((id) => reg.tasks[id] && reg.tasks[id].status === 'running').sort()
  : [];

// Session budget
const sessionBudget = ledger.session_budget_total || (config && config.session_budget_tokens) || ledger.token_budget || 500000;
const sessionUsed = ledger.session_used || tokIn || 0;

// ─── Build status block ───────────────────────────────────────────────────

const lines = [];

// Header bar with iteration counter
const titleLeft = c('bold', 'FORGE') + c('gray', ` iteration ${iteration}/${maxIterations}`);
const titleRight = c('cyan', `phase: ${phase}`);
lines.push(headerBar(titleLeft, titleRight));

// Task line — id, status, step
const statusColor = taskStatus === 'blocked' ? 'red'
                 : taskStatus === 'complete' ? 'green'
                 : 'yellow';
let taskLine = `  Task    ${c('bold', currentTask || '—')}  ${c(statusColor, '[' + taskStatus + ']')}`;
if (currentStep) {
  const arrow = nextStep ? ` → ${c('cyan', nextStep)}` : '';
  taskLine += `  ${c('gray', '@ ' + currentStep)}${arrow}`;
}
lines.push(taskLine);

// Step / agent line — only when we have something to show
if (runningTasks.length > 1) {
  lines.push(`  Running ${c('yellow', runningTasks.join(', '))} ${c('gray', '(' + runningTasks.length + ' parallel)')}`);
}

// Progress bar
const total = frontierTotal || 0;
const done = Math.min(completedCount, total);
const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
const barWidth = Math.min(40, WIDTH - 30);
const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
lines.push(`  Tasks   [${c('green', bar)}] ${done}/${total} (${pct}%)`);

// Token line
let tokLine = `  Tokens  ${fmtK(tokIn)} in / ${fmtK(tokOut)} out / ${fmtK(tokCache)} cached`;
if (sessionBudget > 0) {
  const sbPct = Math.floor((sessionUsed / sessionBudget) * 100);
  const sbColor = sbPct >= 90 ? 'red' : sbPct >= 70 ? 'yellow' : 'green';
  tokLine += `   ${c('gray', 'budget')} ${c(sbColor, `${fmtK(sessionUsed)}/${fmtK(sessionBudget)} (${sbPct}%)`)}`;
}
lines.push(tokLine);

// Per-task budget line — only if we have current task tokens
if (currentTaskTokens != null && currentTaskBudget) {
  const tPct = Math.floor((currentTaskTokens / currentTaskBudget) * 100);
  const tColor = tPct >= 90 ? 'red' : tPct >= 70 ? 'yellow' : 'green';
  lines.push(`  Per-task ${c(tColor, `${fmtK(currentTaskTokens)}/${fmtK(currentTaskBudget)} tok (${tPct}%)`)}`);
}

// Lock + restart line
const restartCount = loop.restart_count || 0;
const maxRestarts = loop.max_restarts || 10;
lines.push(`  Lock    ${lockLabel}   ${c('gray', `restarts ${restartCount}/${maxRestarts}`)}`);

// Blocked banner takes the bottom slot when present
if (blockedReason) {
  lines.push(`  ${c('red', '⚠ BLOCKED:')} ${c('red', blockedReason)}`);
}

// Footer bar
lines.push(c('gray', '─'.repeat(WIDTH)));

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);

// ─── Render helpers ───────────────────────────────────────────────────────

function headerBar(left, right) {
  const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const sep = '═';
  const bar = c('gray', sep.repeat(2));
  const labelL = ` ${left} `;
  const labelR = ` ${right} `;
  const used = visibleLen(bar) + visibleLen(labelL) + visibleLen(labelR) + visibleLen(bar);
  const fill = Math.max(0, WIDTH - used);
  return `${bar}${labelL}${c('gray', sep.repeat(fill))}${labelR}${bar}`;
}

function parseArgs(argv) {
  const args = { forgeDir: null, color: true, width: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-color') args.color = false;
    else if (a === '--forge-dir') args.forgeDir = argv[++i];
    else if (a === '--width') args.width = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'forge-status-block — compact status snapshot for the active forge run',
    '',
    'Usage: node scripts/forge-status-block.cjs [options]',
    '',
    'Options:',
    '  --no-color           Strip ANSI escape codes',
    '  --forge-dir PATH     Path to .forge directory (default ./.forge)',
    '  --width N            Output column width (default 72)',
    '  -h, --help           Show this help',
    '',
    'Exit codes: 0 on success, 1 if .forge dir missing or status_header disabled',
    '',
  ].join('\n'));
}
