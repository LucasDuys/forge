// tests/tui-auto-attach.test.cjs -- regression tests for R003 (T012).
//
// Covers acceptance criteria from spec-forge-v03-gaps.md R003:
//   AC1: autonomy==="full" spawns TUI appropriate to the environment.
//   AC2: Unix + tmux on PATH -> detached `forge-tui-<pid>` session +
//        stdout `Attach: tmux attach -t forge-tui-<pid>`.
//   AC3: win32 OR tmux unavailable -> stdout `Monitor progress with: /forge:watch`
//        and no fork attempt.
//   AC4: autonomy==="gated" -> no spawn, no output.
//   AC5: `.forge/config.json` `tui.auto_attach: false` -> no spawn, no output.
//
// The helper ships a DRY_RUN mode so the test can assert spawn argv without
// forking a real tmux process inside the sandbox.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(REPO_ROOT, 'scripts', 'forge-tui-attach.cjs');

function mkProject(configOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tui-attach-test-'));
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  const cfg = Object.assign({}, configOverrides || {});
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    JSON.stringify(cfg, null, 2)
  );
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// Create a shim directory that contains a fake `tmux` executable so the
// helper's PATH probe succeeds without touching the real system. On POSIX
// we write an executable shell script; on Windows the helper also accepts
// `tmux` without the .exe suffix when fs.statSync sees a file, so a plain
// empty file suffices for the existence check.
function makeTmuxShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tmux-shim-'));
  const binPath = path.join(dir, 'tmux');
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
  try { fs.chmodSync(binPath, 0o755); } catch (_) { /* win32 ignores */ }
  return dir;
}

function makeEmptyPath() {
  // A directory that definitely does not contain tmux.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-path-'));
}

function runHelper(projectDir, argv, env) {
  const res = spawnSync(
    process.execPath,
    [HELPER, ...argv],
    {
      cwd: projectDir,
      encoding: 'utf8',
      env: Object.assign({}, process.env, env || {}),
      timeout: 10000,
    }
  );
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

suite('tui-auto-attach (R003 / T012)', () => {

  test('AC2: full autonomy + tmux available spawns detached session and prints Attach line', () => {
    const project = mkProject({});
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '12345',
        }
      );

      assert.strictEqual(res.status, 0, 'helper should exit 0');
      // AC2 stdout: Attach line with deterministic pid.
      assert.match(
        res.stdout,
        /^Attach: tmux attach -t forge-tui-12345\n$/,
        `expected Attach line, got: ${JSON.stringify(res.stdout)}`
      );
      // Assert the spawn command that would run (DRY_RUN captures it on stderr).
      assert.match(
        res.stderr,
        /DRY_SPAWN: tmux new-session -d -s forge-tui-12345 node /,
        `expected DRY_SPAWN line, got: ${JSON.stringify(res.stderr)}`
      );
      // AC4 negative: not the headless message.
      assert.ok(
        !/Monitor progress with/.test(res.stdout),
        'must not fall back to headless when tmux is available'
      );
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('AC3: platform=win32 produces headless message and no spawn attempt', () => {
    const project = mkProject({});
    const shim = makeTmuxShim(); // even with tmux present, win32 must not spawn
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'win32',
          FORGE_TUI_ATTACH_FAKE_PID: '99',
        }
      );

      assert.strictEqual(res.status, 0, 'helper should exit 0 on win32');
      assert.strictEqual(
        res.stdout,
        'Monitor progress with: /forge:watch\n',
        `expected headless message, got: ${JSON.stringify(res.stdout)}`
      );
      // Critical: no DRY_SPAWN means no spawn attempt was made.
      assert.ok(
        !/DRY_SPAWN/.test(res.stderr),
        `win32 must not attempt spawn, stderr was: ${JSON.stringify(res.stderr)}`
      );
      assert.ok(
        !/Attach: tmux/.test(res.stdout),
        'win32 must not print Attach line'
      );
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('AC3: tmux missing on non-Windows produces headless message, no spawn', () => {
    const project = mkProject({});
    const empty = makeEmptyPath();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: empty,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '88',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.strictEqual(
        res.stdout,
        'Monitor progress with: /forge:watch\n',
        `expected headless message, got: ${JSON.stringify(res.stdout)}`
      );
      assert.ok(
        !/DRY_SPAWN/.test(res.stderr),
        'must not attempt spawn when tmux missing'
      );
    } finally {
      cleanup(project);
      cleanup(empty);
    }
  });

  test('AC5: tui.auto_attach=false disables even with full autonomy + tmux present', () => {
    const project = mkProject({ tui: { auto_attach: false } });
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '77',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.strictEqual(
        res.stdout,
        '',
        `opt-out must be silent, got stdout: ${JSON.stringify(res.stdout)}`
      );
      assert.ok(
        !/DRY_SPAWN/.test(res.stderr),
        'opt-out must not attempt spawn'
      );
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('AC5: default (no tui block in config) enables auto-attach', () => {
    const project = mkProject({ autonomy: 'full' }); // no tui block
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '66',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /^Attach: tmux attach -t forge-tui-66\n$/);
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('AC4: autonomy=gated is silent no-op regardless of environment', () => {
    const project = mkProject({});
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'gated', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '55',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.strictEqual(
        res.stdout,
        '',
        `gated must be silent, got: ${JSON.stringify(res.stdout)}`
      );
      assert.ok(
        !/DRY_SPAWN/.test(res.stderr),
        'gated must not attempt spawn'
      );
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('AC4: autonomy=supervised is silent no-op', () => {
    const project = mkProject({});
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'supervised', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '44',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout, '');
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

  test('malformed config.json does not block execute (defaults to auto_attach=true)', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tui-attach-test-'));
    fs.mkdirSync(path.join(project, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(project, '.forge', 'config.json'), '{ not valid json');
    const shim = makeTmuxShim();
    try {
      const res = runHelper(
        project,
        ['--autonomy', 'full', '--forge-dir', '.forge'],
        {
          FORGE_TUI_ATTACH_DRY_RUN: '1',
          FORGE_TUI_ATTACH_FAKE_PATH: shim,
          FORGE_TUI_ATTACH_FAKE_PLATFORM: 'linux',
          FORGE_TUI_ATTACH_FAKE_PID: '33',
        }
      );

      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /^Attach: tmux attach -t forge-tui-33\n$/);
    } finally {
      cleanup(project);
      cleanup(shim);
    }
  });

});

runTests();
