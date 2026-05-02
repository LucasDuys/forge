// tests/run-tests-budget-w2.test.cjs -- Wave 2 perf budget verify (T008 / R007)
//
// Wave 2's regression bar, mirroring Wave 1's tests/run-tests-perf.test.cjs
// (T006) but with adjustments for the additional ~176 tests Wave 2 added.
//
// Two assertions, both deterministic:
//
//   1. Wall-time budget: `node scripts/run-tests.cjs` must finish within
//      baseline + SLOP_MS_W2. Baseline is read from .forge/baseline-tests.txt
//      (captured pre-T001 of Wave 1) when present; otherwise the current run
//      records itself as the baseline (recorded-only, never asserted).
//
//      The Wave 2 slop is 25s (vs Wave 1's 15s) to absorb the cumulative
//      ~318 tests added across both waves without flake. If a future wave
//      tightens this further, the slop should be re-baselined against a
//      fresh `.forge/baseline-tests.txt`.
//
//   2. No new dependencies: package.json must declare zero `dependencies`
//      and zero `devDependencies`. Forge is "pure node:* only" per README,
//      so any added dep is a regression. `peerDependencies` (whitelisted to
//      `ably` for collab mode) are exempt -- those are NOT bundled.
//
// Recursion guard:
//   When invoked transitively from inside scripts/run-tests.cjs, the wall-time
//   subprocess call would recurse infinitely. We set FORGE_PERF_RECURSION_GUARD=1
//   on the spawned subprocess and short-circuit when our own process sees it.
//   This mirrors Wave 1's perf test exactly, and the W1 test honors the same
//   guard so a single subprocess invocation skips both budget files.
//
// Platform gate:
//   Wall-time on Windows is bursty (antivirus, indexing, virus-scan-on-spawn).
//   On win32 the wall-time check is record-only -- we still print the duration
//   for visibility but skip the assertion. Linux/macOS get the hard assert.
//   Same policy as Wave 1.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_TESTS_PATH = path.join(REPO_ROOT, 'scripts', 'run-tests.cjs');
const BASELINE_PATH = path.join(REPO_ROOT, '.forge', 'baseline-tests.txt');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

// 25s slop above recorded baseline. Wave 2 has added ~176 more tests on top of
// Wave 1's ~142, so the cumulative test count is ~318 over baseline. The
// extra slop vs Wave 1's 15s reflects this larger delta and accounts for
// Windows-style I/O bursts that occasionally push CI minutes over the line.
const SLOP_MS_W2 = 25000;

// Default baseline if .forge/baseline-tests.txt is missing or unparseable.
// Not used as an assertion floor on first run -- treated as recorded-only.
const DEFAULT_BASELINE_MS = 100000;

function readBaselineMs() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const text = fs.readFileSync(BASELINE_PATH, 'utf8');
  // Format: "duration: 85548ms" on one line. Same format Wave 1 uses.
  const m = text.match(/^duration:\s*(\d+)ms/m);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readPackageJson() {
  if (!fs.existsSync(PACKAGE_JSON_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  } catch (_e) {
    return null;
  }
}

suite('Wave 2 run-tests perf budget (R007)', () => {
  test('wall-time stays within Wave-1 baseline + 25s (or records baseline on first run)', () => {
    if (process.env.FORGE_PERF_RECURSION_GUARD === '1') {
      // Short-circuit: we are already inside a perf-driven subprocess.
      // Skipping prevents infinite spawn recursion when this test file
      // is itself executed by the outer runner under measurement. The same
      // guard is honored by Wave 1's run-tests-perf.test.cjs, so one outer
      // run measures both budgets without recursive dispatch.
      return;
    }

    const baselineMs = readBaselineMs();
    const recordOnly = baselineMs === null;
    const limitMs = (baselineMs || DEFAULT_BASELINE_MS) + SLOP_MS_W2;

    const start = Date.now();
    const result = spawnSync(process.execPath, [RUN_TESTS_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        FORGE_PERF_RECURSION_GUARD: '1',
      }),
      // Hard timeout: 4x the limit so a wedged child can't hang the suite.
      timeout: limitMs * 4,
    });
    const duration = Date.now() - start;

    // Always emit the recorded duration so a maintainer can see the trend
    // even when the assertion is skipped. Tag with [perf-w2] to distinguish
    // from Wave 1's [perf] line in the same run.
    process.stdout.write(
      `[perf-w2] run-tests.cjs wall-time: ${duration}ms ` +
      `(baseline=${baselineMs == null ? 'unset' : baselineMs + 'ms'}, ` +
      `limit=${limitMs}ms, slop=${SLOP_MS_W2}ms, platform=${process.platform})\n`
    );

    // Sanity: the subprocess must have actually executed.
    assert.ok(result, 'spawnSync returned no result');
    assert.notStrictEqual(result.signal, 'SIGTERM',
      `run-tests.cjs subprocess timed out after ${limitMs * 4}ms`);

    if (process.platform === 'win32') {
      // Record-only on Windows -- bursty I/O makes wall-time flaky here.
      // Same policy as Wave 1 (T006 perf test).
      return;
    }

    if (recordOnly) {
      // First-run / missing-baseline: do not assert. The next run will
      // have a baseline to compare against.
      return;
    }

    assert.ok(duration <= limitMs,
      `run-tests.cjs wall-time ${duration}ms exceeds Wave-2 limit ${limitMs}ms ` +
      `(baseline=${baselineMs}ms + slop=${SLOP_MS_W2}ms)`);
  });
});

suite('Wave 2 no new dependencies (R007)', () => {
  test('package.json declares zero `dependencies`', () => {
    const pkg = readPackageJson();
    if (pkg === null) {
      // No package.json on disk = trivially zero deps. Green case.
      return;
    }
    const deps = pkg.dependencies || {};
    const keys = Object.keys(deps);
    assert.strictEqual(keys.length, 0,
      'package.json dependencies must be empty (forge is pure node:*); ' +
      `found: ${JSON.stringify(keys)}`);
  });

  test('package.json declares zero `devDependencies`', () => {
    const pkg = readPackageJson();
    if (pkg === null) return;
    const deps = pkg.devDependencies || {};
    const keys = Object.keys(deps);
    assert.strictEqual(keys.length, 0,
      'package.json devDependencies must be empty; ' +
      `found: ${JSON.stringify(keys)}`);
  });

  test('peerDependencies whitelist unchanged across Wave 2 (only `ably` allowed)', () => {
    // Wave 1 documented this exemption (collab mode optional `ably`); Wave 2
    // must not introduce new peer dependencies. This is a forward-compat
    // tripwire: the day someone adds a peer dep without updating the
    // whitelist, this test fails loudly so the architecture decision is
    // forced through review.
    const pkg = readPackageJson();
    if (pkg === null) return;
    const peers = pkg.peerDependencies || {};
    const allowed = new Set(['ably']);
    const peerKeys = Object.keys(peers);
    for (const k of peerKeys) {
      assert.ok(allowed.has(k),
        `unexpected peerDependency: ${k}. Update the allow-list and ` +
        `document the rationale in spec or README before adding peers.`);
    }
  });
});

runTests();
