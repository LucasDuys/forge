// tests/setup.test.cjs -- regression tests for scripts/setup.sh idempotency (R001).
//
// Covers:
//   - AC3: pre-existing .forge/.tui-log.jsonl does not short-circuit setup;
//          all required scaffolding is created on the next run.
//   - AC4: second invocation exits 0 with the exact "config.json present"
//          message and modifies no tracked files (git status clean).
//   - AC1/AC2 are indirectly verified by the above: the gate is now
//          `-f config.json`, and the scaffolding appears on partial states.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  suite, test, assert, gitAvailable, runTests,
} = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SETUP_SH = path.join(REPO_ROOT, 'scripts', 'setup.sh');

// Resolve a bash executable that can run the script on both Unix and Windows.
// On Windows the forge test environment ships Git for Windows, which bundles
// `bash.exe` under `C:\Program Files\Git\bin`. Fall back to `bash` on PATH.
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return 'bash';
}

function runSetup(projectDir) {
  const bash = resolveBash();
  const res = spawnSync(bash, [SETUP_SH, projectDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT },
    timeout: 30000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function mkProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-test-'));
  return projectDir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

suite('setup.sh idempotency (R001)', () => {
  test('AC3: partial .forge/ state (tui-log.jsonl only) still scaffolds everything', () => {
    const projectDir = mkProject();
    try {
      // Simulate the TUI leaving a log behind without config.json.
      const forgeDir = path.join(projectDir, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      fs.writeFileSync(path.join(forgeDir, '.tui-log.jsonl'), '{"evt":"tick"}\n');

      const res = runSetup(projectDir);
      assert.strictEqual(
        res.status, 0,
        `setup.sh exit: ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
      );

      // Every path in the spec's AC3 must now exist.
      const required = [
        'specs',
        'plans',
        'history/cycles',
        'summaries',
        'config.json',
        'state.md',
        'token-ledger.json',
        'history/backprop-log.md',
      ];
      for (const rel of required) {
        const p = path.join(forgeDir, rel);
        assert.ok(
          fs.existsSync(p),
          `expected ${rel} to exist after partial-state setup run; stdout: ${res.stdout}`
        );
      }

      // Stray file from the partial state is left alone.
      assert.ok(
        fs.existsSync(path.join(forgeDir, '.tui-log.jsonl')),
        'pre-existing .tui-log.jsonl should be preserved, not clobbered'
      );
    } finally {
      cleanup(projectDir);
    }
  });

  test('AC4: second invocation exits 0 with "config.json present" message', () => {
    const projectDir = mkProject();
    try {
      const first = runSetup(projectDir);
      assert.strictEqual(first.status, 0, `first run failed: ${first.stderr}`);

      const second = runSetup(projectDir);
      assert.strictEqual(second.status, 0, `second run status: ${second.status}`);
      assert.ok(
        second.stdout.includes('Forge already initialized (config.json present)'),
        `second run stdout should contain the sentinel message; got:\n${second.stdout}`
      );
      // Confirm the first-run message is NOT emitted on the second run.
      assert.ok(
        !second.stdout.includes('Initializing Forge in'),
        'second run must not re-emit the "Initializing Forge in" message'
      );
      assert.ok(
        !second.stdout.includes('Completing partial Forge init'),
        'second run must not re-emit the partial-init message'
      );
    } finally {
      cleanup(projectDir);
    }
  });

  test('AC4: second invocation leaves git status clean in a git-initialized project', () => {
    if (!gitAvailable()) {
      // Environment without git -- skip by passing a no-op assertion.
      assert.ok(true, 'git not on PATH, skipping git-status invariant');
      return;
    }
    const { execFileSync } = require('node:child_process');
    const projectDir = mkProject();
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
      execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: projectDir });
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: projectDir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectDir });

      // First run produces .gitignore + .forge/. Commit those so "clean" is meaningful.
      const first = runSetup(projectDir);
      assert.strictEqual(first.status, 0, `first run failed: ${first.stderr}`);

      // Stage everything produced by the first run and commit it so the
      // working tree is clean before the second run.
      execFileSync('git', ['add', '-A'], { cwd: projectDir });
      execFileSync('git', ['commit', '-m', 'initial forge scaffold', '--quiet'], { cwd: projectDir });

      const second = runSetup(projectDir);
      assert.strictEqual(second.status, 0, `second run status: ${second.status}`);

      // AC4: second run must not modify tracked files.
      const statusOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectDir, encoding: 'utf8',
      });
      assert.strictEqual(
        statusOut.trim(), '',
        `second run left git status dirty:\n${statusOut}`
      );
    } finally {
      cleanup(projectDir);
    }
  });

  test('AC1/AC2: gate fires on config.json presence, not bare directory', () => {
    const projectDir = mkProject();
    try {
      // Directory exists but no config.json -> must NOT short-circuit.
      fs.mkdirSync(path.join(projectDir, '.forge'), { recursive: true });
      const res = runSetup(projectDir);
      assert.strictEqual(res.status, 0, `exit status: ${res.status}\nstderr: ${res.stderr}`);
      assert.ok(
        !res.stdout.includes('Forge already initialized (config.json present)'),
        'gate must not short-circuit when config.json is missing'
      );
      assert.ok(
        fs.existsSync(path.join(projectDir, '.forge', 'config.json')),
        'config.json must be created when directory exists without it'
      );
    } finally {
      cleanup(projectDir);
    }
  });
});

runTests();
