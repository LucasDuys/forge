#!/usr/bin/env node
// scripts/run-tests.cjs
//
// Zero-dependency test runner for Forge.
//
// Usage:
//   node scripts/run-tests.cjs                  -- run all tests/*.test.cjs
//   node scripts/run-tests.cjs --verbose        -- forward stdout per file
//   node scripts/run-tests.cjs --filter locks   -- only files whose path contains "locks"
//   node scripts/run-tests.cjs --known-fail-allowlist a.test.cjs,b.test.cjs
//                                              -- treat the comma-separated test
//                                                 files as known-known failures:
//                                                 still reported in the summary,
//                                                 but the runner exits 0 if those
//                                                 are the ONLY failing files.
//                                                 Default behavior (flag absent)
//                                                 is unchanged: any failure -> exit 1.
//
// Exit codes:
//   0  all suites passed (or only known-fail-allowlisted files failed)
//   1  one or more suites failed (or runner error)

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const FILTER = (() => {
  const i = ARGS.indexOf('--filter');
  if (i === -1) return null;
  return ARGS[i + 1] || null;
})();
// --known-fail-allowlist: comma-separated list of test file basenames whose
// failures are treated as known-known. If a flag is given but with no value
// (e.g. `--known-fail-allowlist` at end of args), it acts as "no allowlist"
// (back-compat with absence of flag). Empty strings in the list are ignored.
const KNOWN_FAIL_ALLOWLIST = (() => {
  const i = ARGS.indexOf('--known-fail-allowlist');
  if (i === -1) return null;
  const raw = ARGS[i + 1];
  if (!raw || raw.startsWith('--')) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();

const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'tests');

function discoverTestFiles() {
  if (!fs.existsSync(TEST_DIR)) return [];
  const all = fs.readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.test.cjs'))
    .filter(f => !f.startsWith('_'))
    .sort();
  if (FILTER) return all.filter(f => f.includes(FILTER));
  return all;
}

function parseSummary(stdout) {
  // Find the last FORGE_TEST_SUMMARY line in the output
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^FORGE_TEST_SUMMARY (\{.*\})$/);
    if (m) {
      try { return JSON.parse(m[1]); } catch (e) { return null; }
    }
  }
  return null;
}

function runFile(file) {
  const abs = path.join(TEST_DIR, file);
  const start = Date.now();
  const result = spawnSync(process.execPath, [abs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, VERBOSE ? { FORGE_TEST_VERBOSE: '1' } : {})
  });
  const duration = Date.now() - start;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const summary = parseSummary(stdout);
  return {
    file,
    exitCode: result.status == null ? -1 : result.status,
    duration,
    stdout,
    stderr,
    summary
  };
}

function pad(str, len) {
  str = String(str);
  while (str.length < len) str += ' ';
  return str;
}

function main() {
  const files = discoverTestFiles();
  if (files.length === 0) {
    process.stdout.write('no test files found in ' + TEST_DIR + '\n');
    process.exit(FILTER ? 1 : 0);
  }

  process.stdout.write('Forge test runner\n');
  process.stdout.write('discovered ' + files.length + ' test file(s)\n');
  if (FILTER) process.stdout.write('filter: ' + FILTER + '\n');
  process.stdout.write('\n');

  const results = [];
  let grandTotal = 0;
  let grandPassed = 0;
  let grandFailed = 0;
  let anyFailure = false;
  const failingFiles = [];
  const startAll = Date.now();

  for (const file of files) {
    const r = runFile(file);
    results.push(r);
    const s = r.summary;
    if (s) {
      grandTotal += s.total;
      grandPassed += s.passed;
      grandFailed += s.failed;
    }
    // Legacy test files (without _helper.cjs) emit no FORGE_TEST_SUMMARY.
    // Treat them as a single opaque "pass" if exit code 0, "fail" otherwise.
    const pass = r.exitCode === 0 && (!s || s.failed === 0);
    if (!pass) {
      anyFailure = true;
      failingFiles.push(file);
    }
    const status = pass ? 'PASS' : 'FAIL';
    const counts = s ? `${s.passed}/${s.total}` : (pass ? 'legacy' : 'fail');
    if (!s && pass) {
      grandTotal += 1;
      grandPassed += 1;
    } else if (!s && !pass) {
      grandTotal += 1;
      grandFailed += 1;
    }
    process.stdout.write(
      pad(status, 6) + pad(file, 28) + pad(counts, 10) + r.duration + 'ms\n'
    );
    if (VERBOSE || !pass) {
      const out = (r.stdout || '').trimEnd();
      if (out) process.stdout.write(indent(out) + '\n');
      const err = (r.stderr || '').trimEnd();
      if (err) process.stdout.write(indent('STDERR: ' + err) + '\n');
    }
  }

  const totalDuration = Date.now() - startAll;
  process.stdout.write('\n');
  process.stdout.write('files:    ' + results.length + '\n');
  process.stdout.write('tests:    ' + grandTotal + '\n');
  process.stdout.write('passed:   ' + grandPassed + '\n');
  process.stdout.write('failed:   ' + grandFailed + '\n');
  process.stdout.write('duration: ' + totalDuration + 'ms\n');

  // Known-fail allowlist handling. When the flag is absent (KNOWN_FAIL_ALLOWLIST
  // === null) the historical behavior is preserved exactly: any failing file
  // means exit 1. When the flag is present the runner still PRINTS every
  // failure (visibility is preserved) but exits 0 if and only if every
  // failing file is in the allowlist. This is additive: it never turns a
  // green run red, it only optionally turns a "known-known" red into green.
  let exitCode = anyFailure ? 1 : 0;
  if (KNOWN_FAIL_ALLOWLIST !== null && failingFiles.length > 0) {
    const allowed = new Set(KNOWN_FAIL_ALLOWLIST);
    const unexpected = failingFiles.filter(f => !allowed.has(f));
    if (unexpected.length === 0) {
      process.stdout.write(
        'known-fail-allowlist: ' + failingFiles.length +
        ' file(s) failed but all are allowlisted; exiting 0\n'
      );
      process.stdout.write('  allowlisted-failures: ' + failingFiles.join(', ') + '\n');
      exitCode = 0;
    } else {
      process.stdout.write(
        'known-fail-allowlist: ' + unexpected.length +
        ' unexpected failing file(s) (not on allowlist); exiting 1\n'
      );
      process.stdout.write('  unexpected-failures: ' + unexpected.join(', ') + '\n');
      // exitCode stays 1
    }
  }
  process.exit(exitCode);
}

function indent(text) {
  return text.split('\n').map(l => '    ' + l).join('\n');
}

main();
