// tests/mock-demo-evidence.test.cjs -- T025 / spec-mock-and-visual-verify R004
//
// Contract tests for the audit-evidence driver:
//   mock-projects/blurry-graph/demo.sh
//
// What this asserts:
//
//   1. demo.sh exists and is executable (chmod +x).
//   2. demo.sh rejects unknown --mode values with a non-zero exit.
//   3. demo.sh --mode before runs to completion in the sandbox (via
//      FORGE_DISABLE_PLAYWRIGHT=1 placeholder path) without mutating the
//      committed src/config.ts: the file is byte-identical before and
//      after the run, and no .demo-bak sidecar is left on disk.
//   4. demo.sh --mode after writes the three expected after.png files
//      under docs/audit/mock-verify-evidence/{halo,zoomOut,synthesis}/.
//   5. The evidence directory structure matches spec R004: exactly three
//      regression subdirs, each with before.png + after.png, plus a
//      top-level README.md.
//   6. README.md references all six image paths with the correct
//      filenames, and embeds them as markdown images.
//   7. Placeholder PNGs written by the sandbox path are valid PNGs (the
//      standard 8-byte magic number is present at offset 0).
//
// The test runs demo.sh in the REAL mock directory with
// FORGE_DISABLE_PLAYWRIGHT=1, which routes to the 1x1 placeholder PNG
// codepath -- no dev server is started, no browser is launched. Because
// the test runs on the shipped fixture, the config-restore assertion is
// the teeth of AC "demo script must not mutate current git state".

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_ROOT = path.join(REPO_ROOT, 'mock-projects', 'blurry-graph');
const DEMO_SH = path.join(MOCK_ROOT, 'demo.sh');
const CONFIG_FILE = path.join(MOCK_ROOT, 'src', 'config.ts');
const CONFIG_BACKUP = path.join(MOCK_ROOT, 'src', 'config.ts.demo-bak');
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'docs', 'audit', 'mock-verify-evidence');
const README = path.join(EVIDENCE_ROOT, 'README.md');

const REGRESSIONS = ['halo', 'zoomOut', 'synthesis'];
const PHASES = ['before', 'after'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// Resolve a bash executable. On Windows the Git-provided bash lives at a
// well-known absolute path; in a POSIX sandbox `bash` is on PATH. Prefer
// PATH resolution so the test does not hardcode an installer location.
function resolveBash() {
  // On win32, `bash.exe` may be shimmed via Git for Windows; fall back to
  // the standard install path if `bash` is not reachable via PATH.
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    return 'bash';
  } catch (_) {}
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    '/usr/bin/bash',
    '/bin/bash'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runDemo(args, env) {
  const bash = resolveBash();
  if (!bash) {
    // Skip-style sentinel: surface a clear failure rather than a silent
    // pass. The test suite runs on CI images with bash, so a missing
    // bash is a legitimate infra bug.
    throw new Error('no bash executable available to drive demo.sh');
  }
  const mergedEnv = Object.assign({}, process.env, env || {});
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync(bash, [DEMO_SH].concat(args), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: mergedEnv,
      timeout: 30000
    });
  } catch (e) {
    code = e.status == null ? -1 : e.status;
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  return { code, stdout, stderr };
}

// ─── 1. demo.sh exists and is executable ─────────────────────────────────

suite('R004 -- demo.sh presence + permissions', () => {
  test('demo.sh exists at mock-projects/blurry-graph/demo.sh', () => {
    assert.ok(fs.existsSync(DEMO_SH), 'demo.sh must exist at ' + DEMO_SH);
  });

  test('demo.sh is a regular file and readable', () => {
    const stat = fs.statSync(DEMO_SH);
    assert.ok(stat.isFile(), 'demo.sh must be a regular file');
    // On Windows the user-executable bit is often reported as 0o666 under
    // WSL/MSYS even when git preserves +x. Rely on the shebang + the
    // real invocation test below as the binding check for "runs".
    const shebang = fs.readFileSync(DEMO_SH, 'utf8').split('\n', 1)[0];
    assert.match(shebang, /^#!.*bash/, 'demo.sh must start with a bash shebang');
  });
});

// ─── 2. Unknown --mode rejected ──────────────────────────────────────────

suite('R004 -- demo.sh argument validation', () => {
  test('unknown --mode value exits non-zero with a clear message', () => {
    const res = runDemo(['--mode', 'nonsense'], { FORGE_DISABLE_PLAYWRIGHT: '1' });
    assert.notStrictEqual(res.code, 0, 'demo.sh must reject unknown --mode values');
    const combined = res.stdout + res.stderr;
    assert.match(combined, /--mode must be before\|after\|full/,
      'error message must list the valid modes');
  });
});

// ─── 3. --mode before is non-mutating wrt src/config.ts ──────────────────

suite('R004 -- demo.sh --mode before does not mutate git-tracked state', () => {
  test('src/config.ts is byte-identical before and after a before-mode run', () => {
    const originalBytes = fs.readFileSync(CONFIG_FILE);

    const res = runDemo(['--mode', 'before'], { FORGE_DISABLE_PLAYWRIGHT: '1' });
    assert.strictEqual(res.code, 0,
      `demo.sh --mode before must exit 0 in placeholder mode; stderr:\n${res.stderr}`);

    const afterBytes = fs.readFileSync(CONFIG_FILE);
    assert.ok(
      originalBytes.equals(afterBytes),
      'src/config.ts must be byte-identical after demo.sh --mode before (was the restore skipped?)'
    );
    assert.ok(
      !fs.existsSync(CONFIG_BACKUP),
      'src/config.ts.demo-bak sidecar must not remain on disk after a clean run'
    );
  });
});

// ─── 4. --mode after writes the three after.png files ────────────────────

suite('R004 -- demo.sh --mode after writes expected after.png files', () => {
  test('after-mode run produces three valid PNGs', () => {
    const res = runDemo(['--mode', 'after'], { FORGE_DISABLE_PLAYWRIGHT: '1' });
    assert.strictEqual(res.code, 0,
      `demo.sh --mode after must exit 0 in placeholder mode; stderr:\n${res.stderr}`);

    for (const rid of REGRESSIONS) {
      const pngPath = path.join(EVIDENCE_ROOT, rid, 'after.png');
      assert.ok(fs.existsSync(pngPath), `missing: ${pngPath}`);
      const head = fs.readFileSync(pngPath).slice(0, 8);
      assert.ok(head.equals(PNG_MAGIC),
        `${pngPath} must start with the PNG 8-byte magic number`);
    }
  });
});

// ─── 5. Evidence directory structure matches spec ────────────────────────

suite('R004 -- evidence directory structure', () => {
  test('each regression has its own subdirectory with before.png and after.png', () => {
    // Ensure both phases exist for every regression. --mode after above
    // only writes after.png; a prior full run (or the previous suite's
    // before-mode exercise via cleanup path) is expected to have seeded
    // before.png. Run a full cycle here to make the assertion
    // self-sufficient regardless of test ordering.
    const res = runDemo(['--mode', 'full'], { FORGE_DISABLE_PLAYWRIGHT: '1' });
    assert.strictEqual(res.code, 0,
      `demo.sh --mode full must exit 0 in placeholder mode; stderr:\n${res.stderr}`);

    for (const rid of REGRESSIONS) {
      const sub = path.join(EVIDENCE_ROOT, rid);
      assert.ok(fs.existsSync(sub) && fs.statSync(sub).isDirectory(),
        `missing directory: ${sub}`);
      for (const phase of PHASES) {
        const pngPath = path.join(sub, `${phase}.png`);
        assert.ok(fs.existsSync(pngPath), `missing image: ${pngPath}`);
        const head = fs.readFileSync(pngPath).slice(0, 8);
        assert.ok(head.equals(PNG_MAGIC),
          `${pngPath} must start with the PNG 8-byte magic number`);
      }
    }
  });

  test('no unexpected regression subdirectories have crept in', () => {
    // Guard against a future regression where a refactor silently adds a
    // fourth subdirectory without updating the spec + README. Entries
    // other than the three declared regressions, plus README.md, fail.
    const entries = fs.readdirSync(EVIDENCE_ROOT, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const expected = [...REGRESSIONS].sort();
    assert.deepStrictEqual(dirs, expected,
      `unexpected evidence subdirs. got=${JSON.stringify(dirs)} expected=${JSON.stringify(expected)}`);
  });
});

// ─── 6. README.md references all six image paths ────────────────────────

suite('R004 -- README.md references all six image paths', () => {
  test('README.md exists at docs/audit/mock-verify-evidence/README.md', () => {
    assert.ok(fs.existsSync(README), 'README.md must exist at ' + README);
  });

  test('README.md contains a markdown image embed for every (regression, phase) pair', () => {
    const body = fs.readFileSync(README, 'utf8');
    for (const rid of REGRESSIONS) {
      for (const phase of PHASES) {
        // The README uses relative paths of the form `rid/phase.png`.
        // Match both the inline path and the markdown-image-embed syntax
        // so a future reorganisation into a different embed form (HTML
        // <img>, absolute path) is flagged early.
        const relPath = `${rid}/${phase}.png`;
        assert.ok(body.includes(relPath),
          `README.md must reference "${relPath}"`);
        const embed = new RegExp(
          `!\\[[^\\]]*\\]\\(\\s*${rid}/${phase}\\.png\\s*\\)`
        );
        assert.ok(embed.test(body),
          `README.md must embed ${rid}/${phase}.png via markdown image syntax`);
      }
    }
  });

  test('README.md documents the --mode options of demo.sh', () => {
    const body = fs.readFileSync(README, 'utf8');
    assert.match(body, /--mode full/,   'README must mention --mode full');
    assert.match(body, /--mode before/, 'README must mention --mode before');
    assert.match(body, /--mode after/,  'README must mention --mode after');
  });
});

runTests();
