#!/usr/bin/env node
// tests/streaming-dag-forge-landing-shape.test.cjs
//
// forge-self-fixes R004 defensive test.
//
// Replays the 2026-04-21 forge-landing topology against the streaming-DAG
// scheduler — 1 scaffold task with 3 parallel siblings consuming its
// early AC, followed by 1 integration task that needs all 3 siblings
// verified. Asserts that:
//
//   1. All 3 siblings go provisional in ONE ac-met call on the scaffold's
//      AC1 (the "tailwind-config + tokens + fonts" AC in the real run).
//   2. Integration task stays pending until all 3 siblings are verified.
//   3. If the scaffold's AC later regresses, ALL 3 siblings are marked
//      stale in one ac-regression call.
//
// This is the shape a well-planned frontier should produce AFTER the
// planner agent's R004 + R005 updates land — T001 exposes an early AC,
// T002/T003/T004 depend on it, T005 needs full task-verified on its
// siblings. The scheduler can do all of this today; what R004 fixes is
// the planner's WILLINGNESS to emit the AC-level edges that make this
// behavior reachable.

'use strict';

const assert = require('node:assert');
const tools = require('../scripts/forge-tools.cjs');
const dag = require('../scripts/forge-streaming-dag.cjs');

function buildFrontier() {
  // A 5-task frontier shaped like the forge-landing run. Real syntax —
  // run through the same parser the plan command uses.
  const text = [
    '## Tier 1',
    '- [T001] Scaffold + tokens | provides: R001.AC1, R002.AC1 | est: ~5k | files: tailwind.config.js, src/tokens.ts, src/index.css',
    '',
    '## Tier 2',
    '- [T002] Hero + Before | depends: T001.R002.AC1 | provides: R003.AC1 | est: ~4k | files: src/components/Hero.tsx, src/components/BeforeChapter.tsx',
    '- [T003] After + diagram | depends: T001.R002.AC1 | provides: R005.AC1 | est: ~6k | files: src/components/AfterChapter.tsx, src/components/MergeConflictDiagram.tsx',
    '- [T004] Benchmark + chart | depends: T001.R002.AC1 | provides: R006.AC1 | est: ~5k | files: src/components/BenchmarkChapter.tsx, src/components/BenchmarkChart.tsx',
    '',
    '## Tier 3',
    '- [T005] Integration + a11y + deploy | depends: T002, T003, T004 | est: ~5k | files: src/App.tsx, scripts/check-loc.mjs, vercel.json',
    ''
  ].join('\n');
  return tools.parseFrontier(text);
}

function testThreeSiblingsProvisionalOnSingleAcMet() {
  const s = dag.createStreamingScheduler({ frontier: buildFrontier() });
  const result = s.emitAcMet({
    taskId: 'T001',
    acId: 'R002.AC1',
    witnessHash: 'sha256:tokens-ready',
    witnessPaths: ['tailwind.config.js', 'src/tokens.ts', 'src/index.css']
  });
  assert.ok(result.provisional.includes('T002'), 'T002 should be provisional');
  assert.ok(result.provisional.includes('T003'), 'T003 should be provisional');
  assert.ok(result.provisional.includes('T004'), 'T004 should be provisional');
  const snap = s.getSnapshot();
  assert.strictEqual(snap.status.T002, 'provisional');
  assert.strictEqual(snap.status.T003, 'provisional');
  assert.strictEqual(snap.status.T004, 'provisional');
  // The integration task still waits for full task-verified on its siblings.
  assert.strictEqual(snap.status.T005, 'pending');
  console.log('PASS  testThreeSiblingsProvisionalOnSingleAcMet');
}

function testIntegrationPromotesOnlyAfterAllSiblingsVerified() {
  const s = dag.createStreamingScheduler({ frontier: buildFrontier() });
  s.emitAcMet({
    taskId: 'T001', acId: 'R002.AC1',
    witnessHash: 'sha256:tokens-ready',
    witnessPaths: ['src/tokens.ts']
  });
  // T001 fully verifies; T002/T003/T004 promote to verified.
  s.emitTaskVerified({ taskId: 'T001' });
  s.emitTaskVerified({ taskId: 'T002' });
  // T005 still pending — T003 and T004 not verified yet.
  assert.strictEqual(s.getSnapshot().status.T005, 'pending', 'T005 waits for T003+T004');
  s.emitTaskVerified({ taskId: 'T003' });
  assert.strictEqual(s.getSnapshot().status.T005, 'pending', 'T005 still waits for T004');
  s.emitTaskVerified({ taskId: 'T004' });
  // All siblings verified — T005 may now dispatch.
  const snap = s.getSnapshot();
  assert.ok(
    snap.status.T005 === 'ready' || snap.status.T005 === 'verified',
    `T005 should be dispatchable after all siblings verify, got ${snap.status.T005}`
  );
  console.log('PASS  testIntegrationPromotesOnlyAfterAllSiblingsVerified');
}

function testRegressionCascadesToAllThreeSiblings() {
  const s = dag.createStreamingScheduler({ frontier: buildFrontier() });
  s.emitAcMet({
    taskId: 'T001', acId: 'R002.AC1',
    witnessHash: 'sha256:v1',
    witnessPaths: ['src/tokens.ts']
  });
  // All three siblings are provisional.
  // Upstream regresses — all three must go stale in one call.
  const result = s.emitAcRegression({ taskId: 'T001', acId: 'R002.AC1' });
  const stale = new Set(result.stale);
  assert.ok(stale.has('T002'));
  assert.ok(stale.has('T003'));
  assert.ok(stale.has('T004'));
  const snap = s.getSnapshot();
  assert.strictEqual(snap.status.T002, 'stale');
  assert.strictEqual(snap.status.T003, 'stale');
  assert.strictEqual(snap.status.T004, 'stale');
  console.log('PASS  testRegressionCascadesToAllThreeSiblings');
}

function run_all() {
  const tests = [
    testThreeSiblingsProvisionalOnSingleAcMet,
    testIntegrationPromotesOnlyAfterAllSiblingsVerified,
    testRegressionCascadesToAllThreeSiblings
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
