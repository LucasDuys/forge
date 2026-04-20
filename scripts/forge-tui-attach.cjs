#!/usr/bin/env node
// scripts/forge-tui-attach.cjs -- auto-attach a detached TUI session when
// `/forge:execute` runs in full autonomy (R003 / T012).
//
// Usage:
//   node scripts/forge-tui-attach.cjs --autonomy full [--forge-dir .forge]
//
// Behavior (per spec R003 acceptance criteria):
//   AC1: autonomy==="full" spawns TUI in a way appropriate to the environment.
//   AC2: Unix + tmux available -> start detached `forge-tui-<pid>` session and
//        print `Attach: tmux attach -t forge-tui-<pid>` to stdout.
//   AC3: process.platform==="win32" OR tmux missing -> print
//        `Monitor progress with: /forge:watch` and continue headless,
//        no fork attempt.
//   AC4: autonomy==="gated" (or any non-full) -> no-op, no output.
//   AC5: `.forge/config.json` `tui.auto_attach: false` -> no-op, no output.
//        Default is true when the flag is absent.
//
// Exit codes:
//   0 -- decision made (attached, skipped, or fell back to headless message).
//        Never blocks the calling /forge:execute flow.
//   2 -- invalid arguments.
//
// Testing hooks:
//   FORGE_TUI_ATTACH_DRY_RUN=1 -- do not actually spawn tmux; print the
//     command that would run on stderr as `DRY_SPAWN: <argv>` and still
//     emit the normal `Attach:` line on stdout. Used by the regression
//     test so it can assert the spawn arguments without forking a real
//     tmux session (which the sandbox cannot do).
//   FORGE_TUI_ATTACH_FAKE_PATH -- overrides $PATH for tmux lookup. Lets
//     the test inject a shim directory that contains (or omits) `tmux`.
//   FORGE_TUI_ATTACH_FAKE_PLATFORM -- when set to `win32`, forces the
//     Windows branch regardless of real platform. Lets the test assert
//     no-spawn on win32 from any host.
//   FORGE_TUI_ATTACH_FAKE_PID -- pin the session pid for deterministic
//     stdout comparison.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { autonomy: null, forgeDir: '.forge', help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--autonomy') args.autonomy = argv[++i];
    else if (a === '--forge-dir') args.forgeDir = argv[++i];
    else {
      process.stderr.write(`forge-tui-attach: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'forge-tui-attach -- auto-attach TUI on /forge:execute full autonomy',
    '',
    'Usage:',
    '  node scripts/forge-tui-attach.cjs --autonomy full [--forge-dir .forge]',
    '',
    'Options:',
    '  --autonomy MODE    Autonomy mode from /forge:execute (full|gated|supervised)',
    '  --forge-dir PATH   Path to .forge directory (default ./.forge)',
    '  -h, --help         Show this help',
    '',
    'Exits 0 whether it attaches, skips, or falls back to a headless message.',
    ''
  ].join('\n'));
}

function readAutoAttachFlag(forgeDir) {
  // Default is TRUE per AC5: `.forge/config.json` flag `tui.auto_attach`
  // (default true) allows disabling the behavior without changing autonomy mode.
  const cfgPath = path.join(forgeDir, 'config.json');
  if (!fs.existsSync(cfgPath)) return true;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.tui && cfg.tui.auto_attach === false) return false;
    return true;
  } catch (_) {
    // Malformed config -> default true, do not block execute.
    return true;
  }
}

function getPlatform() {
  const fake = process.env.FORGE_TUI_ATTACH_FAKE_PLATFORM;
  if (fake) return fake;
  return process.platform;
}

function getSearchPath() {
  const fake = process.env.FORGE_TUI_ATTACH_FAKE_PATH;
  if (fake !== undefined) return fake;
  return process.env.PATH || '';
}

function tmuxAvailable() {
  // Look for a `tmux` executable on the search path. On win32 we do not
  // check -- Windows branch short-circuits before this function.
  const pathEntries = getSearchPath().split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['tmux.exe', 'tmux'] : ['tmux'];
  for (const dir of pathEntries) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) {
          const st = fs.statSync(candidate);
          if (st.isFile()) return true;
        }
      } catch (_) { /* ignore per-entry errors */ }
    }
  }
  return false;
}

function getPid() {
  const fake = process.env.FORGE_TUI_ATTACH_FAKE_PID;
  if (fake) return String(fake);
  return String(process.pid);
}

function spawnDetachedTmux(sessionName, tuiCommand) {
  // AC2: detached tmux session running the TUI command. We use
  // `tmux new-session -d -s <name> <cmd>` which returns immediately
  // without blocking execute.
  const args = ['new-session', '-d', '-s', sessionName, tuiCommand];

  if (process.env.FORGE_TUI_ATTACH_DRY_RUN === '1') {
    process.stderr.write(`DRY_SPAWN: tmux ${args.join(' ')}\n`);
    return;
  }

  try {
    const child = spawn('tmux', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    // Treat spawn failure as "tmux unavailable": fall back to the
    // headless message so execute keeps moving.
    process.stderr.write(`forge-tui-attach: tmux spawn failed (${e.message}); falling back to headless\n`);
    process.stdout.write('Monitor progress with: /forge:watch\n');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  // AC4: autonomy !== "full" -> no-op, no output. The gated flow is preserved.
  if (args.autonomy !== 'full') {
    process.exit(0);
  }

  // AC5: config flag `tui.auto_attach: false` disables without changing autonomy.
  if (!readAutoAttachFlag(args.forgeDir)) {
    process.exit(0);
  }

  // AC3: Windows or tmux missing -> headless message, no fork attempt.
  // Windows is checked first because tmux.exe under a WSL/Cygwin path could
  // exist but not be usable from the Node host; the spec says "no fork
  // attempt on unsupported platforms".
  const platform = getPlatform();
  if (platform === 'win32') {
    process.stdout.write('Monitor progress with: /forge:watch\n');
    process.exit(0);
  }
  if (!tmuxAvailable()) {
    process.stdout.write('Monitor progress with: /forge:watch\n');
    process.exit(0);
  }

  // AC2: Unix + tmux available -> spawn detached session, print attach hint.
  const pid = getPid();
  const sessionName = `forge-tui-${pid}`;
  const tuiCommand = `node "${path.resolve(__dirname, 'forge-tui.cjs')}" --forge-dir "${args.forgeDir}"`;
  spawnDetachedTmux(sessionName, tuiCommand);
  process.stdout.write(`Attach: tmux attach -t ${sessionName}\n`);
  process.exit(0);
}

// Exposed for unit testing; CLI entry runs main().
module.exports = {
  parseArgs,
  readAutoAttachFlag,
  tmuxAvailable,
  getPlatform,
};

if (require.main === module) {
  main();
}
