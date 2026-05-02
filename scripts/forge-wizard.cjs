#!/usr/bin/env node
// scripts/forge-wizard.cjs -- Wave 3 T003 / R004 (token-output-effort)
//
// First-run wizard. Prints a one-time, non-blocking onboarding banner that
// confirms the three-wave token-reduction stack is on and points at the
// kill switch. After printing once, sets `wizard_completed: true` in
// .forge/config.json and never re-fires.
//
// Behavior contract (R004):
//   - No interactive prompts. First sighting = dismissal.
//   - Output <= 12 lines. Plain ASCII (no ANSI escapes).
//   - When .forge/config.json has wizard_completed === true: no-op.
//   - When state.md frontmatter has tui_active: true: no-op (TUI handles
//     its own banner; the flag is NOT set in this case so the wizard can
//     still fire once after the TUI exits).
//   - When FORGE_TOKEN_OPT=0: print one short line, then set the flag.
//   - Otherwise: print the full banner, then set the flag.
//
// API:
//   runWizard(forgeDir = '.forge') -> { printed, reason }
//     reason in: 'already-dismissed' | 'tui-active' | 'kill-switch' | 'first-run'
//
// CLI:
//   node scripts/forge-wizard.cjs [--forge-dir .forge]
//
// Pure node:* (no third-party deps). Self-contained config + frontmatter
// parsing so no circular dependency on forge-tools.cjs.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// --- helpers --------------------------------------------------------------

function _readJsonSafe(filePath) {
  // Returns {} on any read or parse failure. The wizard must never crash.
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (e) {
    return {};
  }
}

function _atomicWriteJson(filePath, obj) {
  // Same-directory temp file + rename so concurrent reads never see a
  // half-written file. Mirrors _atomicWriteFile in forge-tools.cjs but
  // kept inline to avoid a circular dependency.
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best-effort */ }
  const tmpPath = path.join(dir, path.basename(filePath) + '.tmp');
  const contents = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmpPath, contents);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

function _readStateFrontmatter(forgeDir) {
  // Minimal YAML frontmatter parser: returns the first `--- ... ---` block
  // as a flat key->value map. Only handles `key: value` pairs (no nested
  // structures, no arrays). Sufficient for the tui_active flag check.
  const statePath = path.join(forgeDir, 'state.md');
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    return {};
  }
  // Allow optional BOM + leading whitespace before the opening fence.
  const stripped = raw.replace(/^﻿/, '');
  const match = stripped.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const body = match[1];
  const data = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    // Strip quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === 'true') data[m[1]] = true;
    else if (val === 'false') data[m[1]] = false;
    else if (val === 'null' || val === '') data[m[1]] = null;
    else if (/^-?\d+$/.test(val)) data[m[1]] = parseInt(val, 10);
    else data[m[1]] = val;
  }
  return data;
}

function _isTuiActive(forgeDir) {
  // The TUI's own watcher sets `tui_active: true` in state.md frontmatter
  // while running. R004.AC6 requires the wizard to be a no-op in that
  // window. (No existing producer wires this key today; introducing it
  // here as the documented coordination point for /forge:watch.)
  const fm = _readStateFrontmatter(forgeDir);
  return fm.tui_active === true;
}

function _setWizardCompleted(forgeDir) {
  const cfgPath = path.join(forgeDir, 'config.json');
  const cfg = _readJsonSafe(cfgPath);
  cfg.wizard_completed = true;
  _atomicWriteJson(cfgPath, cfg);
}

// --- banner content -------------------------------------------------------

// Plain ASCII only. No ANSI escape codes. Length <= 12 lines (R004.AC4).
// Trailing newline is a single "\n" so the line count assertion is exact.
function _buildBanner() {
  return [
    'Forge: token-reduction stack is active (one-time notice).',
    '  Wave 1: token instrumentation -- ON',
    '  Wave 2: broader tool cache    -- ON',
    '  Wave 3: broader output filter -- ON',
    '  Wave 3: per-phase effort tune -- ON',
    'Kill switch: set FORGE_TOKEN_OPT=0 to disable the entire stack.',
    'This message will not appear again.'
  ].join('\n') + '\n';
}

function _buildKillSwitchLine() {
  return 'Forge: token-reduction features disabled (FORGE_TOKEN_OPT=0).\n';
}

// --- main API -------------------------------------------------------------

function runWizard(forgeDir) {
  forgeDir = forgeDir || '.forge';

  // 1. TUI suppression (R004.AC6). Check first so we don't read/write the
  //    config when /forge:watch is rendering its own banner.
  if (_isTuiActive(forgeDir)) {
    return { printed: false, reason: 'tui-active' };
  }

  // 2. Already dismissed (R004.AC2).
  const cfgPath = path.join(forgeDir, 'config.json');
  const cfg = _readJsonSafe(cfgPath);
  if (cfg.wizard_completed === true) {
    return { printed: false, reason: 'already-dismissed' };
  }

  // 3. Kill switch (R004.AC5). Print short line, still set flag so we
  //    don't re-fire on the next invocation.
  if (process.env.FORGE_TOKEN_OPT === '0') {
    process.stdout.write(_buildKillSwitchLine());
    try { _setWizardCompleted(forgeDir); } catch (e) { /* best-effort */ }
    return { printed: true, reason: 'kill-switch' };
  }

  // 4. First-run banner (R004.AC1).
  process.stdout.write(_buildBanner());
  try { _setWizardCompleted(forgeDir); } catch (e) { /* best-effort */ }
  return { printed: true, reason: 'first-run' };
}

// --- CLI ------------------------------------------------------------------

function _parseArgs(argv) {
  const args = { forgeDir: '.forge' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--forge-dir' && i + 1 < argv.length) {
      args.forgeDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

if (require.main === module) {
  const args = _parseArgs(process.argv.slice(2));
  runWizard(args.forgeDir);
  process.exit(0);
}

module.exports = {
  runWizard,
  // Exposed for tests; treat as private to the module otherwise.
  _buildBanner,
  _buildKillSwitchLine
};
