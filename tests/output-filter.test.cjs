// tests/output-filter.test.cjs
//
// Unit tests for hooks/output-filter.js (Wave 3 T001, R001).
//
// Five filter classes (package install, build, git diff, find, curl) plus
// the top-level applyFilter dispatch + FORGE_TOKEN_OPT=0 kill switch +
// regression check on hooks/test-output-filter.js sha256.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const filter = require('../hooks/output-filter');

// Build a string of >2000 chars by repeating a line.
function bigOutput(line, count) {
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(line + ' ' + i);
  return arr.join('\n');
}

// Helper: ensure FORGE_TOKEN_OPT is unset for tests that depend on default
// behavior (Node propagates parent env, so we clear it here).
function withTokenOpt(value, fn) {
  const prev = process.env.FORGE_TOKEN_OPT;
  if (value === undefined) delete process.env.FORGE_TOKEN_OPT;
  else process.env.FORGE_TOKEN_OPT = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
    else process.env.FORGE_TOKEN_OPT = prev;
  }
}

// --- filterPackageInstall ------------------------------------------------

suite('output-filter :: filterPackageInstall', () => {
  test('npm install large output is condensed', () => {
    const out = bigOutput('  added package foo', 200);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'npm install'));
    assert.notStrictEqual(filtered, out, 'should filter');
    assert.ok(filtered.length < out.length, 'should be shorter');
  });

  test('yarn add large output is condensed', () => {
    const out = bigOutput('info Direct dependency', 150);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'yarn add lodash'));
    assert.notStrictEqual(filtered, out);
    assert.ok(filtered.length < out.length);
  });

  test('pip install preserves error lines', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push('Collecting pkg-' + i);
    lines.push('ERROR: Could not find a version that satisfies the requirement broken');
    for (let i = 0; i < 100; i++) lines.push('Collecting pkg-' + (100 + i));
    const out = lines.join('\n');
    assert.ok(out.length > 2000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'pip install -r req.txt'));
    assert.ok(filtered.indexOf('ERROR: Could not find') !== -1, 'error line preserved');
  });

  test('npm install below threshold is byte-identical', () => {
    const out = 'added 3 packages in 1s';
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'npm install'));
    assert.strictEqual(filtered, out);
  });

  test('non-install command is byte-identical even when large', () => {
    const out = bigOutput('some random output line', 200);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'node script.js'));
    assert.strictEqual(filtered, out);
  });
});

// --- filterBuild ---------------------------------------------------------

suite('output-filter :: filterBuild', () => {
  test('webpack large output is condensed', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push('asset main.' + i + '.js compiled');
    lines.push('webpack compiled successfully in 1234 ms');
    const out = lines.join('\n');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'webpack --mode production'));
    assert.notStrictEqual(filtered, out);
    assert.ok(filtered.indexOf('webpack compiled successfully') !== -1, 'final status preserved');
  });

  test('tsc --noEmit preserves error lines', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push('processing file-' + i + '.ts');
    lines.push('src/foo.ts(10,5): error TS2322: Type mismatch.');
    for (let i = 0; i < 50; i++) lines.push('processing file-' + (50 + i) + '.ts');
    lines.push('Found 1 error.');
    const out = lines.join('\n');
    assert.ok(out.length > 2000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'tsc --noEmit'));
    assert.ok(filtered.indexOf('TS2322') !== -1, 'error line preserved');
    assert.ok(filtered.indexOf('Found 1 error.') !== -1, 'tail preserved');
  });

  test('cargo build large output is condensed', () => {
    const out = bigOutput('   Compiling crate', 200);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'cargo build --release'));
    assert.notStrictEqual(filtered, out);
  });

  test('vite build below threshold is byte-identical', () => {
    const out = 'vite v4.0.0 building for production...\nbuilt in 100ms';
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'vite build'));
    assert.strictEqual(filtered, out);
  });

  test('make (not in build set) passes through unchanged when large', () => {
    const out = bigOutput('compiling target', 200);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'make all'));
    assert.strictEqual(filtered, out);
  });
});

// --- filterGitDiff -------------------------------------------------------

suite('output-filter :: filterGitDiff', () => {
  test('large git diff truncates per-file body', () => {
    const lines = ['diff --git a/foo.txt b/foo.txt',
      'index 1234..5678 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt'];
    for (let i = 0; i < 500; i++) lines.push('+ added line ' + i);
    const out = lines.join('\n');
    assert.ok(out.length > 2000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'git diff'));
    assert.notStrictEqual(filtered, out);
    assert.ok(filtered.indexOf('lines truncated') !== -1, 'truncation marker present');
    assert.ok(filtered.indexOf('full diff in worktree') !== -1, 'worktree note present');
  });

  test('multi-file git diff handles each file independently', () => {
    const lines = [];
    for (let f = 0; f < 3; f++) {
      lines.push('diff --git a/f' + f + '.txt b/f' + f + '.txt');
      lines.push('--- a/f' + f + '.txt');
      lines.push('+++ b/f' + f + '.txt');
      for (let i = 0; i < 200; i++) lines.push('+ file ' + f + ' line ' + i);
    }
    const out = lines.join('\n');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'git diff HEAD~1'));
    // All three file headers must remain
    assert.ok(filtered.indexOf('diff --git a/f0.txt') !== -1);
    assert.ok(filtered.indexOf('diff --git a/f1.txt') !== -1);
    assert.ok(filtered.indexOf('diff --git a/f2.txt') !== -1);
    // Three truncation markers expected
    const markers = filtered.match(/lines truncated, full diff in worktree/g) || [];
    assert.strictEqual(markers.length, 3, 'one marker per file');
  });

  test('git diff --stat large output is filtered', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(' file' + i + '.txt | 5 +++--');
    lines.push('200 files changed, 600 insertions(+), 400 deletions(-)');
    const out = lines.join('\n');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'git diff --stat'));
    assert.ok(filtered.length < out.length, 'something was trimmed');
  });

  test('small git diff is byte-identical', () => {
    const out = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new';
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'git diff'));
    assert.strictEqual(filtered, out);
  });

  test('git status (not git diff) passes through unchanged', () => {
    const out = bigOutput('modified: file', 200);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'git status'));
    assert.strictEqual(filtered, out);
  });
});

// --- filterFind ----------------------------------------------------------

suite('output-filter :: filterFind', () => {
  test('large find output truncated to head + tail + count', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push('./path/to/file_' + i + '.txt');
    const out = lines.join('\n');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'find . -type f'));
    assert.notStrictEqual(filtered, out);
    assert.ok(filtered.indexOf('500 total entries') !== -1, 'count present');
    assert.ok(filtered.indexOf('./path/to/file_0.txt') !== -1, 'head preserved');
    assert.ok(filtered.indexOf('./path/to/file_499.txt') !== -1, 'tail preserved');
  });

  test('find -name pattern large output is filtered', () => {
    const lines = [];
    for (let i = 0; i < 300; i++) lines.push('./src/comp_' + i + '.tsx');
    const out = lines.join('\n');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'find . -name "*.tsx"'));
    assert.ok(filtered.length < out.length);
  });

  test('find with trailing newline preserves trailing newline structure', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push('./some/longer/path/file_' + i + '.txt');
    const out = lines.join('\n') + '\n';
    assert.ok(out.length > 2000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'find . -type f'));
    assert.ok(filtered.length < out.length);
    assert.strictEqual(filtered[filtered.length - 1], '\n', 'trailing newline preserved');
  });

  test('small find output is byte-identical', () => {
    const out = './a\n./b\n./c';
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'find . -type f'));
    assert.strictEqual(filtered, out);
  });

  test('ls (not find) passes through unchanged', () => {
    const out = bigOutput('file', 500);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'ls -la /tmp'));
    assert.strictEqual(filtered, out);
  });
});

// --- filterCurl ----------------------------------------------------------

suite('output-filter :: filterCurl', () => {
  test('large textual response truncates body, keeps headers', () => {
    const headers = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 99999';
    const body = 'a'.repeat(20000);
    const out = headers + '\r\n\r\n' + body;
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'curl -i https://example.com'));
    assert.notStrictEqual(filtered, out);
    assert.ok(filtered.indexOf('HTTP/1.1 200 OK') !== -1, 'status preserved');
    assert.ok(filtered.indexOf('Content-Type: application/json') !== -1, 'headers preserved');
    assert.ok(filtered.indexOf('bytes truncated') !== -1, 'truncation marker present');
  });

  test('curl with no header/body delimiter still filters when huge', () => {
    const out = 'b'.repeat(20000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'curl https://example.com'));
    assert.ok(filtered.length < out.length);
    assert.ok(filtered.indexOf('bytes truncated') !== -1);
  });

  test('curl with LF-only delimiter handled', () => {
    const headers = 'HTTP/1.1 200 OK\nContent-Type: text/html';
    const body = 'c'.repeat(20000);
    const out = headers + '\n\n' + body;
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'curl -i https://example.com'));
    assert.ok(filtered.indexOf('HTTP/1.1 200 OK') !== -1);
    assert.ok(filtered.length < out.length);
  });

  test('curl below 10240 chars is byte-identical', () => {
    const out = 'HTTP/1.1 200 OK\r\n\r\n' + 'short body';
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'curl https://example.com'));
    assert.strictEqual(filtered, out);
  });

  test('wget (not curl) passes through unchanged', () => {
    const out = 'd'.repeat(20000);
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(out, 'wget https://example.com'));
    assert.strictEqual(filtered, out);
  });
});

// --- FORGE_TOKEN_OPT=0 kill switch ---------------------------------------

suite('output-filter :: FORGE_TOKEN_OPT=0 kill switch', () => {
  test('install filter is no-op when FORGE_TOKEN_OPT=0', () => {
    const out = bigOutput('added package', 300);
    const filtered = withTokenOpt('0', () => filter.applyFilter(out, 'npm install'));
    assert.strictEqual(filtered, out);
  });

  test('build filter is no-op when FORGE_TOKEN_OPT=0', () => {
    const out = bigOutput('compiling', 300);
    const filtered = withTokenOpt('0', () => filter.applyFilter(out, 'webpack'));
    assert.strictEqual(filtered, out);
  });

  test('git diff filter is no-op when FORGE_TOKEN_OPT=0', () => {
    const lines = ['diff --git a/x b/x'];
    for (let i = 0; i < 300; i++) lines.push('+ line ' + i);
    const out = lines.join('\n');
    const filtered = withTokenOpt('0', () => filter.applyFilter(out, 'git diff'));
    assert.strictEqual(filtered, out);
  });

  test('find filter is no-op when FORGE_TOKEN_OPT=0', () => {
    const out = bigOutput('./file', 500);
    const filtered = withTokenOpt('0', () => filter.applyFilter(out, 'find . -type f'));
    assert.strictEqual(filtered, out);
  });

  test('curl filter is no-op when FORGE_TOKEN_OPT=0', () => {
    const out = 'HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(20000);
    const filtered = withTokenOpt('0', () => filter.applyFilter(out, 'curl https://example.com'));
    assert.strictEqual(filtered, out);
  });
});

// --- test-output-filter.js sha regression -------------------------------

suite('output-filter :: test-output-filter.js untouched', () => {
  test('hooks/test-output-filter.js sha256 matches pinned hash', () => {
    const p = path.join(__dirname, '..', 'hooks', 'test-output-filter.js');
    const buf = fs.readFileSync(p);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = '66be99d78ce17b974e4bd283f155674219cc7e6bed57ce4bbcca9341a6fea032';
    assert.strictEqual(sha, expected,
      'hooks/test-output-filter.js was modified -- T001 must keep it byte-identical');
  });
});

// --- hook entrypoint smoke ----------------------------------------------

suite('output-filter :: hook entrypoint', () => {
  test('non-Bash tool input is passed through (no stdout)', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo' },
      tool_output: 'irrelevant'
    });
    const r = spawnSync(process.execPath, [hookPath], { input: payload, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  });

  test('Bash + npm install large output emits filtered hook output', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
    const big = bigOutput('added package', 300);
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_output: big
    });
    const r = spawnSync(process.execPath, [hookPath], { input: payload, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.length > 0, 'filtered hook output expected');
    const parsed = JSON.parse(r.stdout.trim());
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(parsed.hookSpecificOutput.additionalContext.indexOf('Output Filtered:') !== -1);
  });

  test('Bash + small output emits nothing', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_output: 'added 1 package'
    });
    const r = spawnSync(process.execPath, [hookPath], { input: payload, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  });

  test('Bash + non-matching command emits nothing', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
    const big = bigOutput('random', 300);
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_output: big
    });
    const r = spawnSync(process.execPath, [hookPath], { input: payload, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  });

  test('FORGE_TOKEN_OPT=0 in env disables hook (no stdout)', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
    const big = bigOutput('added package', 300);
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_output: big
    });
    const env = Object.assign({}, process.env, { FORGE_TOKEN_OPT: '0' });
    const r = spawnSync(process.execPath, [hookPath], {
      input: payload, timeout: 5000, encoding: 'utf8', env: env
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'kill switch must yield no hook output');
  });
});

runTests();
