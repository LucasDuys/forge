#!/usr/bin/env node
// tests/task-classify.test.cjs
//
// Covers forge-self-fixes R003: task-classify CLI must return ui:true
// when AC text references UI paths or the capabilities map lists a
// frontend stack; ui:false otherwise. Brand detection uses a closed list.

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
function run(extraArgs) {
  return spawnSync(process.execPath, [CLI, 'task-classify', ...extraArgs], { encoding: 'utf8' });
}

function testUiPathTriggers() {
  const root = mktmpdir('forge-tc-ui');
  try {
    const spec = path.join(root, 'spec.md');
    fs.writeFileSync(spec, [
      '### R001: Hero component',
      '- [ ] Create `src/components/Hero.tsx` with data-testid=hero',
      ''
    ].join('\n'));
    const r = run(['--task-id', 'T001', '--spec', spec]);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ui, true);
    assert.ok(out.reasons.length >= 1);
    console.log('PASS  testUiPathTriggers');
  } finally { cleanup(root); }
}

function testNonUiReturnsFalse() {
  const root = mktmpdir('forge-tc-server');
  try {
    const spec = path.join(root, 'spec.md');
    fs.writeFileSync(spec, [
      '### R001: migration script',
      '- [ ] Add `scripts/migrate.mjs` that bumps schema to v2',
      '- [ ] Test via `tests/migrate.test.cjs`',
      ''
    ].join('\n'));
    const r = run(['--task-id', 'T001', '--spec', spec]);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ui, false);
    assert.strictEqual(out.brand, null);
    console.log('PASS  testNonUiReturnsFalse');
  } finally { cleanup(root); }
}

function testBrandDetection() {
  const root = mktmpdir('forge-tc-brand');
  try {
    const spec = path.join(root, 'spec.md');
    fs.writeFileSync(spec, [
      'Overview: This page uses Anthropic brand aesthetics in `src/App.tsx`.',
      ''
    ].join('\n'));
    const r = run(['--task-id', 'T002', '--spec', spec]);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ui, true);
    assert.strictEqual(out.brand, 'anthropic');
    console.log('PASS  testBrandDetection');
  } finally { cleanup(root); }
}

function testCapabilitiesSignal() {
  const root = mktmpdir('forge-tc-caps');
  try {
    const spec = path.join(root, 'spec.md');
    const caps = path.join(root, 'capabilities.json');
    // Spec has no UI path references, but capabilities map signals Vite/React.
    fs.writeFileSync(spec, [
      '### R001: refactor docs',
      '- [ ] Update `docs/README.md`',
      ''
    ].join('\n'));
    fs.writeFileSync(caps, JSON.stringify({
      cli_tools: { vite: { available: true }, node: { available: true } },
      mcp_servers: {}
    }));
    const r = run(['--task-id', 'T001', '--spec', spec, '--capabilities', caps]);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ui, true, 'capabilities-has vite should flip ui');
    console.log('PASS  testCapabilitiesSignal');
  } finally { cleanup(root); }
}

function testMissingArgs() {
  const r = spawnSync(process.execPath, [CLI, 'task-classify'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  console.log('PASS  testMissingArgs');
}

function run_all() {
  const tests = [
    testUiPathTriggers,
    testNonUiReturnsFalse,
    testBrandDetection,
    testCapabilitiesSignal,
    testMissingArgs
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
