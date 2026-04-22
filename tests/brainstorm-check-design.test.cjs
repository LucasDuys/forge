#!/usr/bin/env node
// tests/brainstorm-check-design.test.cjs
//
// Covers forge-self-fixes R002: brainstorm-check-design CLI must return
// exit 0 with {ok:true, path} when DESIGN.md exists (or design.md or
// docs/DESIGN.md); exit 3 with {ok:false, reason:"missing_design_md"}
// otherwise.

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
function run(cwd, extraArgs) {
  return spawnSync(
    process.execPath,
    [CLI, 'brainstorm-check-design', '--repo-root', cwd, ...(extraArgs || [])],
    { encoding: 'utf8', cwd }
  );
}

function testDesignMdFoundAtRoot() {
  const root = mktmpdir('forge-bcd-root');
  try {
    fs.writeFileSync(path.join(root, 'DESIGN.md'), '# Design', 'utf8');
    const r = run(root, ['--brand-name', 'anthropic']);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'DESIGN.md');
    console.log('PASS  testDesignMdFoundAtRoot');
  } finally { cleanup(root); }
}

function testLowercaseDesignMd() {
  const root = mktmpdir('forge-bcd-lower');
  try {
    fs.writeFileSync(path.join(root, 'design.md'), '# Design', 'utf8');
    const r = run(root);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    console.log('PASS  testLowercaseDesignMd');
  } finally { cleanup(root); }
}

function testDocsDesignMd() {
  const root = mktmpdir('forge-bcd-docs');
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'DESIGN.md'), '# Design', 'utf8');
    const r = run(root);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.ok(out.path.replace(/\\/g, '/').endsWith('docs/DESIGN.md'));
    console.log('PASS  testDocsDesignMd');
  } finally { cleanup(root); }
}

function testMissingFailsGate() {
  const root = mktmpdir('forge-bcd-missing');
  try {
    const r = run(root, ['--brand-name', 'linear']);
    assert.strictEqual(r.status, 3, 'exit code must be 3 for gate-fail');
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'missing_design_md');
    assert.strictEqual(out.brand, 'linear');
    assert.ok(Array.isArray(out.searched) && out.searched.length >= 3);
    console.log('PASS  testMissingFailsGate');
  } finally { cleanup(root); }
}

function run_all() {
  const tests = [
    testDesignMdFoundAtRoot,
    testLowercaseDesignMd,
    testDocsDesignMd,
    testMissingFailsGate
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
