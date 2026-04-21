// tests/streaming-dag.test.cjs -- T029 / R006
//
// Integration test for the per-acceptance-criterion streaming DAG.
//
// Covers the R006 acceptance criteria:
//   - AC-level dep dispatches downstream PROVISIONALLY on ac-met
//   - task-verified promotes provisional downstream to VERIFIED
//   - ac-regression marks every consumer STALE and re-queues
//   - bounded speculation: 4th provisional dispatch on a chain is DENIED
//   - 2 verification failures on a chain disables streaming for that chain
//   - edge primitive carries witness_hash/witness_paths/state/emitted_at
//   - Mermaid renderer emits subgraphs + status classes
//   - opt-in config gate

const { suite, test, assert, runTests } = require('./_helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tools = require('../scripts/forge-tools.cjs');
const dag = require('../scripts/forge-streaming-dag.cjs');

function buildFrontier(rows) {
  return '## Tier 1\n' + rows.join('\n') + '\n';
}

suite('forge-streaming-dag: parser + classify', () => {
  test('parseFrontier accepts AC-level depends and provides', () => {
    const text = buildFrontier([
      '- [T001] Build auth | provides: R001.AC1, R001.AC3 | est: ~5k',
      '- [T002] JWT | depends: T001.R001.AC3 | provides: R002.AC1 | est: ~5k',
      '- [T003] SDK | depends: T002.R002.AC1 | est: ~3k'
    ]);
    const tasks = tools.parseFrontier(text);
    assert.strictEqual(tasks.length, 3);
    assert.deepStrictEqual(tasks[0].provides, ['R001.AC1', 'R001.AC3']);
    assert.deepStrictEqual(tasks[1].depends, ['T001.R001.AC3']);
    assert.deepStrictEqual(tasks[1].provides, ['R002.AC1']);
    assert.deepStrictEqual(tasks[2].depends, ['T002.R002.AC1']);
  });

  test('classifyDeps separates task-level and AC-level edges', () => {
    const { taskDeps, acDeps } = dag.classifyDeps(['T001', 'T002.R002.AC1', 'T003.R003.AC2']);
    assert.deepStrictEqual(taskDeps, ['T001']);
    assert.strictEqual(acDeps.length, 2);
    assert.strictEqual(acDeps[0].taskId, 'T002');
    assert.strictEqual(acDeps[0].acId, 'R002.AC1');
    assert.strictEqual(acDeps[0].raw, 'T002.R002.AC1');
  });

  test('back-compat: legacy frontier with only task-level deps still parses', () => {
    const text = buildFrontier([
      '- [T001] First | est: ~3k',
      '- [T002] Second | depends: T001 | est: ~5k'
    ]);
    const tasks = tools.parseFrontier(text);
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks[1].depends, ['T001']);
  });
});

suite('forge-streaming-dag: witness hashing', () => {
  test('computeWitnessHash is deterministic and content-addressed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdag-'));
    const a = path.join(tmp, 'a.ts');
    const b = path.join(tmp, 'b.ts');
    fs.writeFileSync(a, 'hello world');
    fs.writeFileSync(b, 'second file');
    const h1 = dag.computeWitnessHash(['a.ts', 'b.ts'], { baseDir: tmp });
    const h2 = dag.computeWitnessHash(['a.ts', 'b.ts'], { baseDir: tmp });
    assert.strictEqual(h1, h2);
    assert.ok(h1.startsWith('sha256:'));
    // Changing content flips the hash
    fs.writeFileSync(a, 'hello world!');
    const h3 = dag.computeWitnessHash(['a.ts', 'b.ts'], { baseDir: tmp });
    assert.notStrictEqual(h1, h3);
    // Reordering flips the hash (order-sensitive)
    const h4 = dag.computeWitnessHash(['b.ts', 'a.ts'], { baseDir: tmp });
    assert.notStrictEqual(h3, h4);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('missing files hash to empty-blob without throwing', () => {
    const h = dag.computeWitnessHash(['/nonexistent/does/not/exist.ts']);
    assert.ok(h.startsWith('sha256:'));
  });
});

suite('forge-streaming-dag: provisional dispatch + promotion', () => {
  function mkFrontier() {
    return tools.parseFrontier(buildFrontier([
      '- [T001] Build auth | provides: R001.AC1, R001.AC3 | est: ~5k',
      '- [T002] JWT | depends: T001.R001.AC3 | provides: R002.AC1 | est: ~5k',
      '- [T003] SDK | depends: T002.R002.AC1 | est: ~3k'
    ]));
  }

  test('ac-met on upstream dispatches downstream provisionally', () => {
    const s = dag.createStreamingScheduler({ frontier: mkFrontier() });
    const result = s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC3',
      witnessHash: 'sha256:abc', witnessPaths: ['src/auth.ts']
    });
    assert.ok(result.provisional.includes('T002'), 'T002 should be provisional after ac-met on T001.R001.AC3');
    assert.strictEqual(s.getSnapshot().status.T002, 'provisional');
    assert.strictEqual(s.getSnapshot().status.T001, 'ready', 'T001 has no deps so it is ready');
  });

  test('edge primitive carries state/witness_hash/witness_paths/emitted_at', () => {
    const s = dag.createStreamingScheduler({ frontier: mkFrontier() });
    s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC3',
      witnessHash: 'sha256:abc', witnessPaths: ['src/auth.ts']
    });
    const snap = s.getSnapshot();
    const edge = snap.acEvents.T001['R001.AC3'];
    assert.strictEqual(edge.state, 'provisional');
    assert.strictEqual(edge.witness_hash, 'sha256:abc');
    assert.deepStrictEqual(edge.witness_paths, ['src/auth.ts']);
    assert.ok(typeof edge.emitted_at === 'string' && edge.emitted_at.length > 0);
  });

  test('task-verified promotes provisional downstream to verified', () => {
    const s = dag.createStreamingScheduler({ frontier: mkFrontier() });
    s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC3',
      witnessHash: 'sha256:abc', witnessPaths: ['src/auth.ts']
    });
    assert.strictEqual(s.getSnapshot().status.T002, 'provisional');
    const result = s.emitTaskVerified({ taskId: 'T001' });
    assert.ok(result.promoted.includes('T002'));
    assert.strictEqual(s.getSnapshot().status.T002, 'verified');
    // T001's AC event is now `verified` not `provisional`
    assert.strictEqual(s.getSnapshot().acEvents.T001['R001.AC3'].state, 'verified');
  });

  test('ac-regression marks every downstream consumer STALE and re-queues', () => {
    const s = dag.createStreamingScheduler({ frontier: mkFrontier() });
    s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC3',
      witnessHash: 'sha256:abc', witnessPaths: ['src/auth.ts']
    });
    assert.strictEqual(s.getSnapshot().status.T002, 'provisional');
    const result = s.emitAcRegression({ taskId: 'T001', acId: 'R001.AC3' });
    assert.ok(result.stale.includes('T002'));
    assert.strictEqual(s.getSnapshot().status.T002, 'stale');
    // The AC event is cleared so a fresh ac-met re-queues
    assert.strictEqual(s.getSnapshot().acEvents.T001['R001.AC3'], undefined);
    // Re-emit: T002 should re-enter provisional (stale -> provisional).
    const r2 = s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC3',
      witnessHash: 'sha256:newhash', witnessPaths: ['src/auth.ts']
    });
    assert.ok(r2.provisional.includes('T002'), 'STALE downstream re-queues on fresh ac-met');
  });
});

suite('forge-streaming-dag: bounded speculation', () => {
  test('4th provisional dispatch on a chain is DENIED with cap_exceeded', () => {
    // One upstream task, four downstream consumers all waiting on the same AC.
    const rows = [
      '- [T001] Root | provides: R001.AC1 | est: ~5k',
      '- [T002] D1 | depends: T001.R001.AC1 | est: ~3k',
      '- [T003] D2 | depends: T001.R001.AC1 | est: ~3k',
      '- [T004] D3 | depends: T001.R001.AC1 | est: ~3k',
      '- [T005] D4 | depends: T001.R001.AC1 | est: ~3k'
    ];
    const s = dag.createStreamingScheduler({
      frontier: tools.parseFrontier(buildFrontier(rows)),
      maxProvisional: 3
    });
    const r = s.emitAcMet({
      taskId: 'T001', acId: 'R001.AC1',
      witnessHash: 'sha256:x', witnessPaths: ['a.ts']
    });
    assert.strictEqual(r.provisional.length, 3, 'only 3 provisional dispatches');
    assert.strictEqual(r.denied.length, 1, 'the 4th is denied');
    assert.strictEqual(r.denied[0].reason, 'cap_exceeded');
    assert.strictEqual(r.denied[0].cap, 3);
  });

  test('2 verification failures on a chain disables streaming for that chain', () => {
    const rows = [
      '- [T001] Root | provides: R001.AC1, R001.AC2 | est: ~5k',
      '- [T002] D1 | depends: T001.R001.AC1 | est: ~3k',
      '- [T003] D2 | depends: T001.R001.AC2 | est: ~3k'
    ];
    const s = dag.createStreamingScheduler({
      frontier: tools.parseFrontier(buildFrontier(rows)),
      maxFailuresBeforeFallback: 2
    });
    s.emitAcMet({ taskId: 'T001', acId: 'R001.AC1', witnessHash: 'sha256:1', witnessPaths: ['a.ts'] });
    s.emitAcMet({ taskId: 'T001', acId: 'R001.AC2', witnessHash: 'sha256:2', witnessPaths: ['b.ts'] });
    // Two regressions on T001's chain
    s.emitAcRegression({ taskId: 'T001', acId: 'R001.AC1' });
    assert.strictEqual(s.isStreamingDisabled('T002'), false, 'one failure: still enabled');
    s.emitAcRegression({ taskId: 'T001', acId: 'R001.AC2' });
    assert.strictEqual(s.isStreamingDisabled('T002'), true, 'two failures: disabled');
    assert.strictEqual(s.isStreamingDisabled('T003'), true);
    const snap = s.getSnapshot();
    assert.strictEqual(snap.streamingDisabled.T001, 'max_failures_exceeded');
    // A structured event log line records the reason (R006 AC).
    const disabled = snap.events.find(e => e.kind === 'streaming_disabled');
    assert.ok(disabled);
    assert.strictEqual(disabled.reason, 'max_failures_exceeded');
  });
});

suite('forge-streaming-dag: witness mismatch on verify', () => {
  test('verified upstream with re-written witness marks downstream STALE', () => {
    const rows = [
      '- [T001] Root | provides: R001.AC1 | est: ~5k',
      '- [T002] D | depends: T001.R001.AC1 | est: ~3k'
    ];
    const s = dag.createStreamingScheduler({
      frontier: tools.parseFrontier(buildFrontier(rows))
    });
    s.emitAcMet({ taskId: 'T001', acId: 'R001.AC1', witnessHash: 'sha256:initial', witnessPaths: ['a.ts'] });
    assert.strictEqual(s.getSnapshot().status.T002, 'provisional');
    // Executor rewrites the witness file before verify — new ac-met overwrites
    // the event with a different witness hash; downstream captured the old.
    s.emitAcMet({ taskId: 'T001', acId: 'R001.AC1', witnessHash: 'sha256:rewrote', witnessPaths: ['a.ts'] });
    const verify = s.emitTaskVerified({ taskId: 'T001' });
    assert.ok(verify.stale.includes('T002'), 'witness mismatch on verify -> stale');
    // The stale transition was logged so reviewers can see the mismatch,
    // even if the subsequent _reevaluate re-dispatches T002 against the
    // now-verified (new) witness. The audit trail lives in the event log.
    const snap = s.getSnapshot();
    const staleEvent = snap.events.find(e => e.kind === 'downstream_stale' && e.task_id === 'T002');
    assert.ok(staleEvent, 'expected a downstream_stale event in the log');
    assert.strictEqual(staleEvent.cause, 'witness_mismatch_on_verify');
  });
});

suite('forge-streaming-dag: back-compat (streaming off)', () => {
  test('legacy task-level deps still resolve via emitTaskVerified', () => {
    const rows = [
      '- [T001] First | est: ~3k',
      '- [T002] Second | depends: T001 | est: ~5k'
    ];
    const s = dag.createStreamingScheduler({
      frontier: tools.parseFrontier(buildFrontier(rows))
    });
    // Neither task has AC deps; emitTaskVerified on T001 unblocks T002
    const r = s.emitTaskVerified({ taskId: 'T001' });
    assert.ok(r.ready.includes('T002'), 'legacy task-level dep dispatches on verify');
    assert.strictEqual(s.getSnapshot().status.T002, 'ready');
  });

  test('isStreamingEnabled honors opt-in config flag (default off)', () => {
    assert.strictEqual(dag.isStreamingEnabled({}), false);
    assert.strictEqual(dag.isStreamingEnabled(null), false);
    assert.strictEqual(dag.isStreamingEnabled({ streaming_dag: {} }), false);
    assert.strictEqual(dag.isStreamingEnabled({ streaming_dag: { enabled: false } }), false);
    assert.strictEqual(dag.isStreamingEnabled({ streaming_dag: { enabled: true } }), true);
  });
});

suite('forge-streaming-dag: Mermaid rendering', () => {
  test('toMermaid emits subgraph per task + nodes per AC + status classes', () => {
    const rows = [
      '- [T001] Build auth | provides: R001.AC1, R001.AC3 | est: ~5k',
      '- [T002] JWT | depends: T001.R001.AC3 | provides: R002.AC1 | est: ~5k'
    ];
    const s = dag.createStreamingScheduler({
      frontier: tools.parseFrontier(buildFrontier(rows))
    });
    s.emitAcMet({ taskId: 'T001', acId: 'R001.AC3', witnessHash: 'sha256:a', witnessPaths: ['x.ts'] });
    s.emitTaskVerified({ taskId: 'T001' });

    const mmd = dag.toMermaid(s);
    assert.ok(mmd.startsWith('flowchart LR'));
    assert.ok(mmd.includes('subgraph T001'));
    assert.ok(mmd.includes('subgraph T002'));
    // AC nodes exist for each known AC
    assert.ok(mmd.includes('T001_R001_AC1'));
    assert.ok(mmd.includes('T001_R001_AC3'));
    assert.ok(mmd.includes('T002_R002_AC1'));
    // Cross-subgraph edge from the upstream AC node to the downstream entry
    assert.ok(mmd.includes('T001_R001_AC3 --> T002_R002_AC1'));
    // Status classes present
    assert.ok(mmd.includes('classDef ver'));
    assert.ok(mmd.includes('classDef prov'));
    assert.ok(mmd.includes('classDef stale'));
    assert.ok(mmd.includes('classDef pend'));
    // Verified node is in the `ver` class
    assert.ok(/class [^\n]*T001_R001_AC3[^\n]* ver/.test(mmd));
  });
});

suite('forge-streaming-dag: CLI ac-met event log', () => {
  test('ac-met subcommand appends one JSONL line to events.jsonl', () => {
    const { execFileSync } = require('node:child_process');
    const { makeTempForgeDir } = require('./_helper.cjs');
    const { projectDir, forgeDir } = makeTempForgeDir();
    const repoRoot = path.resolve(__dirname, '..');
    const out = execFileSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'forge-tools.cjs'),
      'ac-met',
      '--forge-dir', forgeDir,
      '--task', 'T013',
      '--ac', 'R002.AC1',
      '--witness-hash', 'sha256:testhash',
      '--witness-paths', 'src/a.ts,tests/a.test.ts'
    ], { cwd: repoRoot, encoding: 'utf8' });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(parsed.recorded, true);
    assert.strictEqual(parsed.kind, 'ac_met');
    assert.strictEqual(parsed.task_id, 'T013');
    assert.strictEqual(parsed.ac_id, 'R002.AC1');
    const eventsPath = path.join(forgeDir, 'streaming', 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath));
    const line = JSON.parse(fs.readFileSync(eventsPath, 'utf8').trim().split('\n')[0]);
    assert.strictEqual(line.kind, 'ac_met');
    assert.strictEqual(line.task_id, 'T013');
    assert.strictEqual(line.ac_id, 'R002.AC1');
    assert.strictEqual(line.witness_hash, 'sha256:testhash');
    assert.deepStrictEqual(line.witness_paths, ['src/a.ts', 'tests/a.test.ts']);
  });
});

runTests();
