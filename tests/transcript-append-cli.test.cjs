#!/usr/bin/env node
// tests/transcript-append-cli.test.cjs
//
// Covers forge-self-fixes R008: the transcript-append CLI must work
// without an explicit --cycle (auto-create), must reject invalid JSON,
// must require a "phase" key, and must auto-inject `ts` when absent.

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
    [CLI, 'transcript-append', '--forge-dir', path.join(cwd, '.forge'), ...extraArgs],
    { encoding: 'utf8', cwd }
  );
}

// ---------------------------------------------------------------------------
// Test 1: Three events append to one transcript.jsonl, each a parseable JSON
// object with phase/event/ts fields, cycle auto-created.
// ---------------------------------------------------------------------------
function testThreeEventAppend() {
  const root = mktmpdir('forge-ta-three');
  try {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    const events = [
      { phase: 'setup', event: 'loop_init' },
      { phase: 'executing', event: 'task_start', task: 'T001' },
      { phase: 'executing', event: 'task_complete', task: 'T001', commit: 'abc1234' }
    ];
    let cycle = null;
    for (const ev of events) {
      const r = run(root, ['--event', JSON.stringify(ev)]);
      assert.strictEqual(r.status, 0, `append should succeed, stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      if (!cycle) cycle = out.cycle;
      else assert.strictEqual(out.cycle, cycle, 'subsequent appends should reuse the same cycle when state.md has it');
    }
    // First call auto-created the cycle and printed it. For subsequent calls,
    // the cycle may differ (since no state.md was written). Accept the reality
    // that auto-created cycles without a state.md pin will each open their
    // own dir — and instead assert the three events landed somewhere.
    const cyclesDir = path.join(root, '.forge', 'history', 'cycles');
    const dirs = fs.readdirSync(cyclesDir);
    assert.ok(dirs.length >= 1, 'at least one cycle dir created');
    let realEntries = 0;
    for (const d of dirs) {
      const file = path.join(cyclesDir, d, 'transcript.jsonl');
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        // appendTranscript injects boundary lines between phase transitions.
        // Those only carry `phase: 'boundary'` + `at`; filter them and verify
        // our real events carry the auto-injected ts + phase.
        if (parsed.phase === 'boundary') continue;
        realEntries += 1;
        assert.ok(parsed.ts, 'ts auto-injected on real entry');
        assert.ok(parsed.phase, 'phase present on real entry');
      }
    }
    assert.strictEqual(realEntries, 3, 'exactly three real events appended');
    console.log('PASS  testThreeEventAppend');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 2: Pinning cycle via state.md frontmatter makes multiple appends
// share one file.
// ---------------------------------------------------------------------------
function testStatePinnedCycle() {
  const root = mktmpdir('forge-ta-pinned');
  try {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.forge', 'state.md'),
      [
        '---',
        'phase: executing',
        'cycle: 20260422T1000Z',
        '---',
        '',
        ''
      ].join('\n')
    );
    for (const ev of [{ phase: 'p1' }, { phase: 'p2' }, { phase: 'p3' }]) {
      const r = run(root, ['--event', JSON.stringify(ev)]);
      assert.strictEqual(r.status, 0);
    }
    const file = path.join(root, '.forge', 'history', 'cycles', '20260422T1000Z', 'transcript.jsonl');
    assert.ok(fs.existsSync(file), 'pinned cycle dir created');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const realLines = lines.filter((l) => JSON.parse(l).phase !== 'boundary');
    assert.strictEqual(realLines.length, 3, 'three real events in the pinned cycle file');
    console.log('PASS  testStatePinnedCycle');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Missing --event -> exit 2 with stderr message.
// ---------------------------------------------------------------------------
function testMissingEvent() {
  const root = mktmpdir('forge-ta-no-event');
  try {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    const r = run(root, []);
    assert.strictEqual(r.status, 2);
    assert.ok(/--event/.test(r.stderr));
    console.log('PASS  testMissingEvent');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Invalid JSON -> exit 2.
// ---------------------------------------------------------------------------
function testInvalidJson() {
  const root = mktmpdir('forge-ta-bad-json');
  try {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    const r = run(root, ['--event', 'not-json{']);
    assert.strictEqual(r.status, 2);
    assert.ok(/not valid JSON/.test(r.stderr));
    console.log('PASS  testInvalidJson');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 5: Missing `phase` key -> exit 2.
// ---------------------------------------------------------------------------
function testMissingPhase() {
  const root = mktmpdir('forge-ta-no-phase');
  try {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    const r = run(root, ['--event', JSON.stringify({ event: 'nothing' })]);
    assert.strictEqual(r.status, 2);
    assert.ok(/phase/.test(r.stderr));
    console.log('PASS  testMissingPhase');
  } finally {
    cleanup(root);
  }
}

function run_all() {
  const tests = [
    testThreeEventAppend,
    testStatePinnedCycle,
    testMissingEvent,
    testInvalidJson,
    testMissingPhase
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
