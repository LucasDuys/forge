#!/usr/bin/env node
// tests/verify-structural-acs.test.cjs
//
// Covers forge-self-fixes R006: verify-structural-acs CLI must execute
// parseable structural ACs against a built HTML artifact, report pass/
// fail/skipped counts, and surface failures with actionable reasons.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');

const CLI = path.join(__dirname, '..', 'scripts', 'forge-tools.cjs');

function mktmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function run(specPath, artifactPath) {
  return spawnSync(process.execPath, [CLI, 'verify-structural-acs', '--spec', specPath, '--artifact', artifactPath], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Happy path: three parseable ACs, all three pass against a minimal HTML.
// ---------------------------------------------------------------------------
function testThreeAcsAllPass() {
  const root = mktmpdir('forge-vsa-pass');
  try {
    const spec = path.join(root, 'spec.md');
    const html = path.join(root, 'index.html');
    fs.writeFileSync(spec, [
      '### R001',
      '- [ ] An element with `data-testid="hero"` exists in the DOM',
      '- [ ] The page text contains "Multiplayer, spec-driven coding"',
      '- [ ] Exactly 6 elements match `data-testid="layer"`',
      ''
    ].join('\n'));
    fs.writeFileSync(html, [
      '<!doctype html><html><body>',
      '<section data-testid="hero">',
      '<h1>Multiplayer, spec-driven coding. Without the merge hell.</h1>',
      '</section>',
      '<ul>',
      '<li data-testid="layer">1</li>',
      '<li data-testid="layer">2</li>',
      '<li data-testid="layer">3</li>',
      '<li data-testid="layer">4</li>',
      '<li data-testid="layer">5</li>',
      '<li data-testid="layer">6</li>',
      '</ul>',
      '</body></html>'
    ].join('\n'));
    const r = run(spec, html);
    assert.strictEqual(r.status, 0, `expected pass, stdout=${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.pass, 3);
    assert.strictEqual(out.fail, 0);
    assert.strictEqual(out.skipped, 0);
    console.log('PASS  testThreeAcsAllPass');
  } finally { cleanup(root); }
}

// ---------------------------------------------------------------------------
// Fail path: one fail + one skipped + one pass in the same spec.
// ---------------------------------------------------------------------------
function testMixedPassFailSkip() {
  const root = mktmpdir('forge-vsa-mixed');
  try {
    const spec = path.join(root, 'spec.md');
    const html = path.join(root, 'index.html');
    fs.writeFileSync(spec, [
      '- [ ] An element with `data-testid="hero"` exists',
      '- [ ] Page contains "should-not-be-there"',
      '- [ ] The hero is rendered above the fold at 1280x720 viewport (requires getBoundingClientRect)',
      ''
    ].join('\n'));
    fs.writeFileSync(html, '<!doctype html><body><section data-testid="hero">hi</section></body></html>');
    const r = run(spec, html);
    assert.strictEqual(r.status, 3, 'should exit 3 on fail');
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.pass, 1, 'testid-exists passes');
    assert.strictEqual(out.fail, 1, 'text-contains fails');
    assert.strictEqual(out.skipped, 1, 'viewport/fold check is skipped');
    assert.strictEqual(out.failures.length, 1);
    assert.ok(/should-not-be-there/.test(out.failures[0].reason));
    console.log('PASS  testMixedPassFailSkip');
  } finally { cleanup(root); }
}

// ---------------------------------------------------------------------------
// Count mismatch reports expected-vs-got.
// ---------------------------------------------------------------------------
function testCountMismatch() {
  const root = mktmpdir('forge-vsa-count');
  try {
    const spec = path.join(root, 'spec.md');
    const html = path.join(root, 'index.html');
    fs.writeFileSync(spec, [
      '- [ ] Exactly 3 elements match `data-testid="bar"`',
      ''
    ].join('\n'));
    // Only 2 bars in the HTML.
    fs.writeFileSync(html, '<body><rect data-testid="bar" /><rect data-testid="bar" /></body>');
    const r = run(spec, html);
    assert.strictEqual(r.status, 3);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.fail, 1);
    assert.strictEqual(out.failures[0].want, 3);
    assert.strictEqual(out.failures[0].got, 2);
    console.log('PASS  testCountMismatch');
  } finally { cleanup(root); }
}

// ---------------------------------------------------------------------------
// Non-AC lines (prose, headings) are ignored.
// ---------------------------------------------------------------------------
function testProseLinesIgnored() {
  const root = mktmpdir('forge-vsa-prose');
  try {
    const spec = path.join(root, 'spec.md');
    const html = path.join(root, 'index.html');
    fs.writeFileSync(spec, [
      '# Overview',
      '',
      'Prose line about things.',
      '',
      '### R001',
      '- [ ] An element with `data-testid="ok"` exists',
      ''
    ].join('\n'));
    fs.writeFileSync(html, '<body><div data-testid="ok"></div></body>');
    const r = run(spec, html);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.pass, 1);
    assert.strictEqual(out.fail, 0);
    console.log('PASS  testProseLinesIgnored');
  } finally { cleanup(root); }
}

function testMissingArgs() {
  const r = spawnSync(process.execPath, [CLI, 'verify-structural-acs'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  console.log('PASS  testMissingArgs');
}

function run_all() {
  const tests = [
    testThreeAcsAllPass,
    testMixedPassFailSkip,
    testCountMismatch,
    testProseLinesIgnored,
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
