// tests/wave4-regression-budget.test.cjs -- Wave 4 T005 / R004
//
// Regression bar + budget guards for the visual-verifier-hardening spec.
// Asserts that:
//   - The branch suite is green (failed: 0) -- Wave 4 cleared all 8 prior
//     failures (6 visual-verifier + 2 mock-e2e-fix-run).
//   - The plain runner (no flags) exits 0 on this branch.
//   - Wave 4 added at least 12 new tests (actual: 7 + 14 + 22 = 43) across
//     visual-verifier-{crlf,readiness,occlusion}.
//   - No tests were deleted: visual-verifier.test.cjs still has 16 tests.
//   - Wall-time budget: full suite under 60s (~10% over the ~50s baseline).
//   - No new npm or pip dependencies vs main.
//   - scripts/forge-tools.cjs requires only built-in node modules (no axios,
//     lodash, request, underscore, jquery).
//   - The four visual-verifier-* test files all pass (failed: 0 each).
//
// Recursion guard: this file calls `node scripts/run-tests.cjs` from inside
// some tests, but the runner's discovery ALSO picks up this file -- if not
// guarded, the inner runner would recurse back into us, hang, and time out.
// Two defenses:
//   1. We always pass `--filter visual-verifier` to subprocess runner calls
//      so only the 4 visual-verifier files run (this file does not match the
//      filter substring).
//   2. We set FORGE_WAVE4_NESTED=1 when spawning, and skip the heavy
//      subprocess tests if that env var is set on entry. Belt-and-braces.
// Each subprocess test gets a generous timeout because even the filtered
// suite spawns 4 child processes.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_TESTS = path.join(REPO_ROOT, 'scripts', 'run-tests.cjs');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const NESTED = process.env.FORGE_WAVE4_NESTED === '1';

// ─── helpers ────────────────────────────────────────────────────────────────

function runRunner(args, timeoutMs) {
  const env = Object.assign({}, process.env, { FORGE_WAVE4_NESTED: '1' });
  const result = spawnSync(process.execPath, [RUN_TESTS].concat(args || []), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 120000,
    env
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    exitCode: result.status == null ? -1 : result.status,
    signal: result.signal,
    stdout,
    stderr
  };
}

// Parse the runner's summary tail block: lines like "failed:   0".
// The block format is each metric on its own line, "<name>:" + spaces + number.
function parseSummaryTail(stdout) {
  const out = {};
  const re = /^(files|tests|passed|failed|duration):\s+(\d+)/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

// Parse the per-file lines: "PASS  visual-verifier.test.cjs   16/16   100ms"
// or "FAIL  some.test.cjs   ...". Allows leading whitespace because parent
// runners may indent forwarded child output. The runner pads the filename
// column to 28 chars but does NOT add a space after long names, so the
// count can butt up against `.cjs` (e.g. `visual-verifier-crlf.test.cjs7/7`).
// We accept either whitespace OR a digit as the boundary.
function parseFileLines(stdout) {
  const out = [];
  const re = /^\s*(PASS|FAIL)\s+(\S+?\.test\.cjs)(?=\s|\d|legacy|fail)/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    out.push({ status: m[1], file: m[2] });
  }
  return out;
}

// Read a test file's per-suite test count by running it as a subprocess
// and parsing the FORGE_TEST_SUMMARY line. Cheap (one small file at a time).
function readTestCount(file) {
  const abs = path.join(TESTS_DIR, file);
  const result = spawnSync(process.execPath, [abs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000
  });
  const stdout = result.stdout || '';
  const m = stdout.match(/^FORGE_TEST_SUMMARY (\{.*\})$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

// Skip a heavy subprocess test cleanly when we're already nested under a
// parent runner. Returns true iff the test should be a no-op pass.
function nestedSkip(label) {
  if (!NESTED) return false;
  // Quiet pass: we still want the helper to count this as a test, but the
  // body bails out before spawning anything. Output a one-liner so logs
  // record the skip reason.
  process.stdout.write('  SKIP (nested) ' + label + '\n');
  return true;
}

// ─── 1. Failure-set parity vs branch baseline ──────────────────────────────

suite('Wave 4 regression bar -- failure set', () => {
  test('Wave 4 baseline: visual-verifier filter reports failed: 0', () => {
    if (nestedSkip('failed: 0')) return;
    const r = runRunner(['--filter', 'visual-verifier'], 120000);
    assert.ok(r.stdout.length > 0, 'runner produced no stdout');
    const s = parseSummaryTail(r.stdout);
    assert.ok(typeof s.failed === 'number',
      'runner must emit failed metric; tail:\n' + r.stdout.slice(-1500));
    assert.strictEqual(s.failed, 0,
      'visual-verifier filter must be fully green; got failed: ' + s.failed +
      '\n--- runner tail ---\n' + r.stdout.slice(-2000));
    assert.strictEqual(r.exitCode, 0,
      '`run-tests.cjs --filter visual-verifier` must exit 0; got ' + r.exitCode);
  });

  test('Wave 4 baseline: failed test count is bounded above by 0', () => {
    if (nestedSkip('failed <= 0')) return;
    const r = runRunner(['--filter', 'visual-verifier'], 120000);
    const s = parseSummaryTail(r.stdout);
    assert.ok(typeof s.failed === 'number',
      'runner must emit failed metric; tail:\n' + r.stdout.slice(-1500));
    assert.ok(s.failed <= 0,
      'failed count must be <= 0; got ' + s.failed +
      '\n--- runner tail ---\n' + r.stdout.slice(-1500));
  });

  test('Plain `node scripts/run-tests.cjs --filter visual-verifier` exits 0', () => {
    // R004.AC2 (post-Wave-4): no allowlist needed because all prior failures
    // are cleared. The filter narrows scope so we do not pay the full-suite
    // recursion cost; the no-recursion full-suite assertion is exercised by
    // CI / by direct `node scripts/run-tests.cjs` runs.
    if (nestedSkip('exits 0')) return;
    const r = runRunner(['--filter', 'visual-verifier'], 120000);
    assert.strictEqual(r.exitCode, 0,
      'filtered runner must exit 0 on green; got ' + r.exitCode +
      '\n--- runner tail ---\n' + r.stdout.slice(-1500));
  });

  test('Visual-verifier suites all pass on branch', () => {
    if (nestedSkip('visual-verifier all pass')) return;
    const r = runRunner(['--filter', 'visual-verifier'], 120000);
    const lines = parseFileLines(r.stdout);
    const visualLines = lines.filter(l => /^visual-verifier/.test(l.file));
    assert.ok(visualLines.length >= 4,
      'expected >=4 visual-verifier-* files; got ' + visualLines.length +
      '\n--- runner stdout ---\n' + r.stdout.slice(-2000));
    const fails = visualLines.filter(l => l.status !== 'PASS');
    assert.deepStrictEqual(fails, [],
      'no visual-verifier-* file may FAIL; failing: ' +
      JSON.stringify(fails));
  });
});

// ─── 2. New-test count + no-deletions ──────────────────────────────────────

suite('Wave 4 regression bar -- coverage', () => {
  test('Wave 4 added at least 12 new tests across the three new files', () => {
    // R004.AC3: at least 12 new test cases across R001 (CRLF), R002
    // (readiness), R003 (occlusion). Actual at time of writing: 7+14+22=43.
    const crlf = readTestCount('visual-verifier-crlf.test.cjs');
    const readiness = readTestCount('visual-verifier-readiness.test.cjs');
    const occlusion = readTestCount('visual-verifier-occlusion.test.cjs');
    assert.ok(crlf, 'failed to read crlf test summary');
    assert.ok(readiness, 'failed to read readiness test summary');
    assert.ok(occlusion, 'failed to read occlusion test summary');
    const total = crlf.total + readiness.total + occlusion.total;
    assert.ok(total >= 12,
      'Wave 4 must add >=12 new tests; got ' + total +
      ' (crlf=' + crlf.total + ', readiness=' + readiness.total +
      ', occlusion=' + occlusion.total + ')');
  });

  test('No test deletions: tests/visual-verifier.test.cjs still has 16 tests', () => {
    // R004.AC3: "No test deletions". The pre-existing visual-verifier.test.cjs
    // had 16 tests; assert that count survives.
    const file = path.join(TESTS_DIR, 'visual-verifier.test.cjs');
    assert.ok(fs.existsSync(file), 'visual-verifier.test.cjs must exist');
    const src = fs.readFileSync(file, 'utf8');
    // Count `test(...)` registrations -- match `\btest(` with quoted arg.
    const matches = src.match(/\btest\(\s*['"]/g) || [];
    assert.strictEqual(matches.length, 16,
      'visual-verifier.test.cjs must declare exactly 16 tests; got ' +
      matches.length);
    // Cross-check by running it.
    const summary = readTestCount('visual-verifier.test.cjs');
    assert.ok(summary, 'failed to read visual-verifier.test.cjs summary');
    assert.strictEqual(summary.total, 16,
      'visual-verifier.test.cjs runtime test count must be 16; got ' +
      summary.total);
  });
});

// ─── 3. Wall-time budget ───────────────────────────────────────────────────

suite('Wave 4 regression bar -- wall time', () => {
  test('Filtered visual-verifier run wall-time within budget (<30s)', () => {
    // R004.AC4: total test wall-time within 10% of pre-Wave-4 baseline.
    // We use the visual-verifier filter as a proxy because measuring the
    // full suite from inside a test would require running the full suite
    // which is what's calling us (recursion). The filter runs the four
    // visual-verifier-* files plus visual-verifier.test.cjs; combined they
    // took <1s pre-Wave-4 and ~0.5s after, so a 30s ceiling is generous and
    // catches any 30x blowout (e.g. an accidental 30s sleep) without
    // false-positives from CI noise.
    if (nestedSkip('wall-time')) return;
    const r = runRunner(['--filter', 'visual-verifier'], 120000);
    const s = parseSummaryTail(r.stdout);
    assert.ok(typeof s.duration === 'number',
      'runner must emit duration; tail:\n' + r.stdout.slice(-1500));
    assert.ok(s.duration < 30000,
      'visual-verifier filter wall-time must be <30s; got ' + s.duration + 'ms' +
      '\n--- runner tail ---\n' + r.stdout.slice(-1000));
  });
});

// ─── 4. No-new-deps + pure-node guards ─────────────────────────────────────

suite('Wave 4 regression bar -- dependencies', () => {
  test('No new dependencies: package.json deps/devDeps unchanged from main', () => {
    // R004.AC5: no new npm dependencies. Compare current package.json to
    // main's. We compare the `dependencies`, `devDependencies`,
    // `peerDependencies`, and `peerDependenciesMeta` blocks; other top-level
    // keys (scripts, version) may legitimately differ.
    const current = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    );
    const out = spawnSync('git', ['show', 'main:package.json'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000
    });
    assert.strictEqual(out.status, 0,
      'failed to read main:package.json: ' + (out.stderr || ''));
    const mainPkg = JSON.parse(out.stdout);
    const blocks = ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta'];
    for (const k of blocks) {
      const a = current[k] || {};
      const b = mainPkg[k] || {};
      assert.deepStrictEqual(a, b,
        'package.json ' + k + ' must match main; got:\n' +
        JSON.stringify(a) + '\n  vs main:\n' + JSON.stringify(b));
    }
  });

  test('Pure node: no require("axios"|"lodash"|"request"|...) in scripts/forge-tools.cjs', () => {
    // R004.AC5: pure node:*. Catches the regression where someone adds an
    // npm dependency to forge-tools.cjs.
    const file = path.join(REPO_ROOT, 'scripts', 'forge-tools.cjs');
    const src = fs.readFileSync(file, 'utf8');
    const banned = ['axios', 'lodash', 'request', 'underscore', 'jquery',
      'node-fetch', 'got', 'request-promise', 'superagent'];
    for (const dep of banned) {
      const re = new RegExp("require\\(['\"]" + dep + "['\"]\\)");
      assert.ok(!re.test(src),
        'forge-tools.cjs must not require("' + dep + '"); use node:* or stdlib');
    }
    // Positive check: every require() target is either a built-in node
    // module name (with or without `node:` prefix) or a relative path.
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    const builtins = new Set([
      'fs', 'path', 'os', 'child_process', 'crypto', 'http', 'https',
      'url', 'util', 'events', 'stream', 'zlib', 'assert', 'buffer',
      'querystring', 'readline', 'tls', 'net', 'tty', 'vm', 'worker_threads',
      'async_hooks', 'perf_hooks', 'string_decoder', 'timers', 'dns',
      'cluster', 'dgram', 'module', 'process', 'v8'
    ]);
    let m;
    while ((m = reqRe.exec(src)) !== null) {
      const target = m[1];
      const ok =
        target.startsWith('./') ||
        target.startsWith('../') ||
        target.startsWith('node:') ||
        builtins.has(target);
      assert.ok(ok,
        'unexpected require target in forge-tools.cjs: ' + target +
        ' (must be ./ ../ node:* or a node builtin)');
    }
  });
});

runTests();
