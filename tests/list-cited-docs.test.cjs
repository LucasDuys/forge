#!/usr/bin/env node
// tests/list-cited-docs.test.cjs
//
// Covers forge-self-fixes R009: list-cited-docs CLI must return only
// external path references (absolute, home-relative, or in a sibling
// repo directory), never internal paths that resolve inside repoRoot.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');

const CLI = path.join(__dirname, '..', 'scripts', 'forge-tools.cjs');

function mktmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function run(cwd, specPath) {
  return spawnSync(
    process.execPath,
    [CLI, 'list-cited-docs', '--spec', specPath, '--repo-root', cwd],
    { encoding: 'utf8', cwd }
  );
}

// ---------------------------------------------------------------------------
// Test: spec with mixed internal + external references returns ONLY
// external ones. 3 external, 2 internal in this fixture.
// ---------------------------------------------------------------------------
function testFiltersInternalRefs() {
  const parent = mktmpdir('forge-cited-parent');
  const repo = path.join(parent, 'current-repo');
  const sibling = path.join(parent, 'sibling-repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(sibling);
  try {
    const specPath = path.join(repo, 'spec.md');
    fs.writeFileSync(specPath, [
      '# Spec',
      '',
      'Internal reference: see `src/App.tsx` for component details.',
      'Another internal: `scripts/build.mjs`.',
      'External absolute: `C:/dev/other/benchmarks.md`.',
      'External sibling: `sibling-repo/docs/notes.md`.',
      'External home: `~/workspace/shared/config.yml`.',
      'External POSIX absolute: `/etc/forge/global.json`.',
      '',
      'URL, not a path: `https://example.com/file.md` (must be skipped).',
      ''
    ].join('\n'), 'utf8');

    const r = run(repo, specPath);
    assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
    const refs = JSON.parse(r.stdout);
    const paths = refs.map((x) => x.path).sort();
    assert.deepStrictEqual(
      paths,
      [
        '/etc/forge/global.json',
        'C:/dev/other/benchmarks.md',
        'sibling-repo/docs/notes.md',
        '~/workspace/shared/config.yml'
      ].sort()
    );
    console.log('PASS  testFiltersInternalRefs');
  } finally {
    cleanup(parent);
  }
}

// ---------------------------------------------------------------------------
// Test: spec with zero external refs prints empty array, exit 0.
// ---------------------------------------------------------------------------
function testEmptyResult() {
  const parent = mktmpdir('forge-cited-empty');
  const repo = path.join(parent, 'only-repo');
  fs.mkdirSync(repo);
  try {
    const specPath = path.join(repo, 'spec.md');
    fs.writeFileSync(specPath, [
      '- [ ] Edit `src/App.tsx` only.',
      '- [ ] Run `scripts/check-loc.mjs`.',
      ''
    ].join('\n'), 'utf8');
    const r = run(repo, specPath);
    assert.strictEqual(r.status, 0);
    const refs = JSON.parse(r.stdout);
    assert.deepStrictEqual(refs, []);
    console.log('PASS  testEmptyResult');
  } finally {
    cleanup(parent);
  }
}

// ---------------------------------------------------------------------------
// Test: deduplicates repeats.
// ---------------------------------------------------------------------------
function testDedup() {
  const parent = mktmpdir('forge-cited-dedup');
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  try {
    const specPath = path.join(repo, 'spec.md');
    fs.writeFileSync(specPath, [
      'First ref: `C:/shared/doc.md`.',
      'Same again: `C:/shared/doc.md` elsewhere.',
      ''
    ].join('\n'), 'utf8');
    const r = run(repo, specPath);
    assert.strictEqual(r.status, 0);
    const refs = JSON.parse(r.stdout);
    assert.strictEqual(refs.length, 1);
    console.log('PASS  testDedup');
  } finally {
    cleanup(parent);
  }
}

// ---------------------------------------------------------------------------
// Test: missing --spec -> exit 2.
// ---------------------------------------------------------------------------
function testMissingSpecArg() {
  const r = spawnSync(process.execPath, [CLI, 'list-cited-docs'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  console.log('PASS  testMissingSpecArg');
}

function run_all() {
  const tests = [
    testFiltersInternalRefs,
    testEmptyResult,
    testDedup,
    testMissingSpecArg
  ];
  let failed = 0;
  for (const t of tests) {
    try { t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run_all();
