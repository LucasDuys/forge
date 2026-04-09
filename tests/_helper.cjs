// tests/_helper.cjs
//
// Tiny zero-dependency test framework for the Forge test suites.
//
// API:
//   suite(name, fn)        -- group tests under a label
//   test(name, fn)         -- register a test (sync or async)
//   beforeEach(fn)         -- run fn before each test in the current suite
//   afterEach(fn)          -- run fn after each test in the current suite
//   makeTempForgeDir(opts) -- create a fresh temp .forge/ dir, returns abs path
//   gitAvailable()         -- check whether git is on PATH (cached)
//   runTests()             -- execute the registered suites and exit with
//                             code 0 on success, 1 on any failure
//
// Each test file requires this helper, registers tests, then calls
// runTests() at the bottom. Cleanup of temp dirs is automatic via
// process.on('exit').

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const _suites = [];
let _currentSuite = null;
const _tempDirs = [];
let _gitAvailableCache = null;

function suite(name, fn) {
  const s = { name, tests: [], beforeEach: [], afterEach: [] };
  _suites.push(s);
  _currentSuite = s;
  try {
    fn();
  } finally {
    _currentSuite = null;
  }
}

function _ensureSuite() {
  if (!_currentSuite) {
    // Anonymous suite for tests defined at top level
    _currentSuite = { name: '(default)', tests: [], beforeEach: [], afterEach: [] };
    _suites.push(_currentSuite);
  }
  return _currentSuite;
}

function test(name, fn) {
  _ensureSuite().tests.push({ name, fn });
}

function beforeEach(fn) {
  _ensureSuite().beforeEach.push(fn);
}

function afterEach(fn) {
  _ensureSuite().afterEach.push(fn);
}

function makeTempForgeDir(opts) {
  opts = opts || {};
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  _tempDirs.push(projectDir);
  const forgeDir = path.join(projectDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });

  // Optional config seeding so tests do not depend on DEFAULT_CONFIG drift
  const config = opts.config || {};
  fs.writeFileSync(
    path.join(projectDir, '.forge', 'config.json'),
    JSON.stringify(config, null, 2)
  );

  // Seed an empty state.md so readState has something to chew on
  if (opts.seedState !== false) {
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: ready\niteration: 0\n---\n\n## What\'s Done\n'
    );
  }

  return { projectDir, forgeDir };
}

function gitAvailable() {
  if (_gitAvailableCache !== null) return _gitAvailableCache;
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    _gitAvailableCache = true;
  } catch (e) {
    _gitAvailableCache = false;
  }
  return _gitAvailableCache;
}

process.on('exit', () => {
  for (const dir of _tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
});

async function runTests() {
  const start = Date.now();
  let total = 0;
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const s of _suites) {
    for (const t of s.tests) {
      total++;
      const label = s.name === '(default)' ? t.name : `${s.name} > ${t.name}`;
      try {
        for (const hook of s.beforeEach) await hook();
        await t.fn();
        for (const hook of s.afterEach) await hook();
        passed++;
        if (process.env.FORGE_TEST_VERBOSE) {
          process.stdout.write(`  PASS ${label}\n`);
        }
      } catch (err) {
        failed++;
        failures.push({ label, err });
        // Try to still run afterEach hooks
        try { for (const hook of s.afterEach) await hook(); } catch (_) {}
      }
    }
  }

  const duration = Date.now() - start;
  const summary = {
    file: path.basename(require.main ? require.main.filename : 'unknown'),
    total,
    passed,
    failed,
    duration_ms: duration
  };

  // Machine-readable line for the runner to parse
  process.stdout.write('FORGE_TEST_SUMMARY ' + JSON.stringify(summary) + '\n');

  if (failed > 0) {
    process.stdout.write(`\nFAILURES (${failed}):\n`);
    for (const f of failures) {
      process.stdout.write(`  - ${f.label}\n`);
      const msg = (f.err && f.err.stack) ? f.err.stack : String(f.err);
      process.stdout.write('    ' + msg.split('\n').join('\n    ') + '\n');
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`OK ${total} tests in ${duration}ms\n`);
  }
}

module.exports = {
  assert,
  suite,
  test,
  beforeEach,
  afterEach,
  makeTempForgeDir,
  gitAvailable,
  runTests
};
