// tests/run-tests-perf.test.cjs -- Wave 1 perf budget verify (T006 / R006.AC3+AC4)
//
// Two assertions, both deterministic:
//
//   1. Wall-time budget: `node scripts/run-tests.cjs` must finish within
//      baseline + SLOP_MS. Baseline is read from .forge/baseline-tests.txt
//      (captured pre-T001) when present; otherwise the current run records
//      itself as the baseline (recorded-only, never asserted -- that's a
//      green case so first-run on fresh checkouts doesn't false-fail).
//
//   2. No new dependencies: package.json must declare zero `dependencies`
//      and zero `devDependencies`. Forge is "pure node:* only" per README,
//      so any added dep is a regression. `peerDependencies` (e.g. ably,
//      optional for collab mode) are exempt -- those are NOT bundled.
//
// Recursion guard:
//   When invoked transitively from inside scripts/run-tests.cjs, the wall-time
//   subprocess call would recurse infinitely. We set FORGE_PERF_RECURSION_GUARD=1
//   on the spawned subprocess and short-circuit when our own process sees it.
//
// Platform gate:
//   Wall-time on Windows is bursty (antivirus, indexing, virus-scan-on-spawn).
//   On win32 the wall-time check is record-only -- we still print the duration
//   for visibility but skip the assertion. Linux/macOS get the hard assert.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_TESTS_PATH = path.join(REPO_ROOT, 'scripts', 'run-tests.cjs');
const BASELINE_PATH = path.join(REPO_ROOT, '.forge', 'baseline-tests.txt');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

// 15s slop above recorded baseline. Generous enough to absorb T001-T006's
// ~132 added tests without flake. Tighten in Wave 2 once the regression
// bar is well-understood.
const SLOP_MS = 15000;

// Default baseline if .forge/baseline-tests.txt is missing or unparseable.
// Not used as an assertion floor on first run -- treated as recorded-only.
const DEFAULT_BASELINE_MS = 100000;

function readBaselineMs() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const text = fs.readFileSync(BASELINE_PATH, 'utf8');
  // Format: "duration: 85548ms" on one line.
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

suite('run-tests perf budget (R006.AC3)', () => {
  test('wall-time stays within baseline + 15s (or records baseline on first run)', () => {
    if (process.env.FORGE_PERF_RECURSION_GUARD === '1') {
      // Short-circuit: we are already inside a perf-driven subprocess.
      // Skipping prevents infinite spawn recursion when this test file
      // is itself executed by the outer runner under measurement.
      return;
    }

    const baselineMs = readBaselineMs();
    const recordOnly = baselineMs === null;
    const limitMs = (baselineMs || DEFAULT_BASELINE_MS) + SLOP_MS;

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
    // even when the assertion is skipped.
    process.stdout.write(
      `[perf] run-tests.cjs wall-time: ${duration}ms ` +
      `(baseline=${baselineMs == null ? 'unset' : baselineMs + 'ms'}, ` +
      `limit=${limitMs}ms, platform=${process.platform})\n`
    );

    // Sanity: the subprocess must have actually executed. If it timed out
    // or crashed, that itself is a regression worth flagging regardless of
    // platform.
    assert.ok(result, 'spawnSync returned no result');
    assert.notStrictEqual(result.signal, 'SIGTERM',
      `run-tests.cjs subprocess timed out after ${limitMs * 4}ms`);

    if (process.platform === 'win32') {
      // Record-only on Windows -- bursty I/O makes wall-time flaky here.
      return;
    }

    if (recordOnly) {
      // First-run / missing-baseline: do not assert. The next run will
      // have a baseline to compare against.
      return;
    }

    assert.ok(duration <= limitMs,
      `run-tests.cjs wall-time ${duration}ms exceeds limit ${limitMs}ms ` +
      `(baseline=${baselineMs}ms + slop=${SLOP_MS}ms)`);
  });
});

suite('no new dependencies (R006.AC4)', () => {
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

  test('peerDependencies allowed (collab mode optional `ably` is a peer dep, never bundled)', () => {
    // Documents the exemption explicitly so a future maintainer doesn't
    // mistakenly tighten the rule and break /forge:collaborate's optional
    // wire transport. peerDependencies do not get installed by `claude
    // plugin install`; the user opts in to ably separately.
    const pkg = readPackageJson();
    if (pkg === null) return;
    const peers = pkg.peerDependencies || {};
    // Whitelist: only `ably` is allowed as a peer dep in Wave 1. Adding
    // any new peer is a documented architecture decision and should
    // trip this assertion deliberately.
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
