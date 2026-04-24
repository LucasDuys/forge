#!/usr/bin/env node
// tests/detect-contention.test.cjs
//
// Covers forge-self-fixes R005: detect-contention CLI must flag two
// same-tier tasks that declare overlapping filesTouched, and return
// exit 0 when no conflicts exist.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');

const CLI = path.join(__dirname, '..', 'scripts', 'forge-tools.cjs');

function mktmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function run(frontierPath) {
  return spawnSync(process.execPath, [CLI, 'detect-contention', '--frontier', frontierPath], { encoding: 'utf8' });
}

function testConflictFlagged() {
  const root = mktmpdir('forge-dc-conflict');
  try {
    const frontier = path.join(root, 'f.md');
    fs.writeFileSync(frontier, [
      '---',
      'spec: demo',
      'total_tasks: 3',
      'depth: quick',
      '---',
      '',
      '# demo Frontier',
      '',
      '## Tier 1',
      '- [T001] Scaffold | est: ~3k tokens | files: src/App.tsx, src/index.css',
      '',
      '## Tier 2',
      '- [T002] Hero + Before | est: ~4k tokens | depends: T001 | files: src/App.tsx, src/components/Hero.tsx',
      '- [T003] After | est: ~5k tokens | depends: T001 | files: src/App.tsx, src/components/After.tsx',
      ''
    ].join('\n'));
    const r = run(frontier);
    assert.strictEqual(r.status, 3, 'exit 3 on conflict');
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.conflicts.length, 1);
    assert.strictEqual(out.conflicts[0].tier, 2);
    assert.strictEqual(out.conflicts[0].file, 'src/App.tsx');
    assert.deepStrictEqual(out.conflicts[0].tasks.sort(), ['T002', 'T003']);
    console.log('PASS  testConflictFlagged');
  } finally { cleanup(root); }
}

function testNoConflictPasses() {
  const root = mktmpdir('forge-dc-clean');
  try {
    const frontier = path.join(root, 'f.md');
    fs.writeFileSync(frontier, [
      '---',
      'spec: demo',
      '---',
      '',
      '## Tier 1',
      '- [T001] Scaffold | est: ~3k tokens | files: src/App.tsx',
      '',
      '## Tier 2',
      '- [T002] Hero | est: ~4k tokens | depends: T001 | files: src/components/Hero.tsx',
      '- [T003] After | est: ~5k tokens | depends: T001 | files: src/components/After.tsx',
      ''
    ].join('\n'));
    const r = run(frontier);
    assert.strictEqual(r.status, 0, 'exit 0 when no conflicts');
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.conflicts, []);
    console.log('PASS  testNoConflictPasses');
  } finally { cleanup(root); }
}

function testTasksInDifferentTiersOk() {
  const root = mktmpdir('forge-dc-tiers');
  try {
    const frontier = path.join(root, 'f.md');
    fs.writeFileSync(frontier, [
      '---',
      'spec: demo',
      '---',
      '',
      '## Tier 1',
      '- [T001] Create | est: ~3k | files: src/App.tsx',
      '',
      '## Tier 2',
      '- [T002] Amend | est: ~4k | depends: T001 | files: src/App.tsx',
      ''
    ].join('\n'));
    const r = run(frontier);
    assert.strictEqual(r.status, 0, 'different tiers never conflict');
    console.log('PASS  testTasksInDifferentTiersOk');
  } finally { cleanup(root); }
}

function testMissingFrontierArg() {
  const r = spawnSync(process.execPath, [CLI, 'detect-contention'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  console.log('PASS  testMissingFrontierArg');
}

function run_all() {
  const tests = [
    testConflictFlagged,
    testNoConflictPasses,
    testTasksInDifferentTiersOk,
    testMissingFrontierArg
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
