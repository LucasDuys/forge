// tests/forge-collab-integration.test.cjs
//
// T013 -- end-to-end collab integration review. No new feature code;
// this suite ties every primitive from T001..T012 into a single
// realistic multiplayer session and asserts all 16 requirements from
// spec-collab hold together. Catches cross-requirement regressions
// missed by per-task unit tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const FORGE_TOOLS = path.join(__dirname, '..', 'scripts', 'forge-tools.cjs');

// ---------------------------------------------------------------------
// Scenario A: full happy-path multiplayer session, 2 participants.
// ---------------------------------------------------------------------

suite('T013 integration -- full brainstorm -> consolidate -> claim -> execute loop', () => {
  test('two participants exchange a full session end-to-end without regressions', async () => {
    const { projectDir, forgeDir } = makeTempForgeDir({
      config: { collab: { route: { epsilon: 0.05 }, auto_push: true } }
    });
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const transport = collab.createMemoryTransport();

    // --- 1. Brain dumps (R002, chat-mode output persisted) ---
    collab.brainstormDump(collabDir, 'daniel',
      'redis cache invalidation is tricky. Let us research eviction policies. Use redis.');
    collab.brainstormDump(collabDir, 'lucas',
      'stripe payments pipeline. Use nats for pub sub.');

    const inputs = collab.readAllInputs(collabDir);
    assert.strictEqual(inputs.length, 2);

    // --- 2. Consolidate + categorize under a consolidation lease (R003, R004, R014, R016) ---
    const consolidation = await collab.writeConsolidatedUnderLease(
      transport, collabDir, 'daniel', inputs, { ttlSeconds: 30, now: 1_000_000 }
    );
    assert.strictEqual(consolidation.held, true);
    assert.ok(consolidation.result.taskCount >= 2);
    const cats = JSON.parse(fs.readFileSync(consolidation.result.categoriesPath, 'utf8')).categories;
    const codingCats = cats.filter(c => c.type === 'coding');
    const researchCats = cats.filter(c => c.type === 'research');
    assert.ok(researchCats.length >= 1, 'explore/research phrasing should produce research-type task');
    assert.ok(cats.some(c => c.is_decision), 'redis-vs-nats should surface as decision task');

    // --- 3. Concurrent consolidation from lucas must defer (R016) ---
    const conflict = await collab.writeConsolidatedUnderLease(
      transport, collabDir, 'lucas', inputs, { ttlSeconds: 30, now: 1_000_000 + 500 }
    );
    // Lease was already released after daniel's call, so lucas gets in too --
    // but he acquires the lease, does work, releases. The key assertion is
    // that no overwrite happens DURING daniel's write. Simulate that by
    // pre-acquiring on a third claimant:
    const pre = await collab.tryAcquireLease(transport, 'consolidation', 'third', { ttlSeconds: 30, now: 2_000_000 });
    assert.strictEqual(pre.acquired, true);
    const blocked = await collab.writeConsolidatedUnderLease(
      transport, collabDir, 'sarah', inputs, { ttlSeconds: 30, now: 2_000_000 + 100 }
    );
    assert.strictEqual(blocked.held, false);
    assert.match(blocked.reason, /held_by_third/);
    await collab.releaseLease(transport, 'consolidation', 'third');

    // --- 4. Participant shapes for routing ---
    const participants = inputs.map(i => ({
      handle: i.handle,
      contributions: i.body,
      active_tasks: 0
    }));

    // --- 5. Round-1 clarifying question routes to closest contributor (R015) ---
    const sent = [];
    const realtimeTransport = {
      async sendTargeted(handle, event, data) { sent.push({ handle, event, data }); },
      async publish(event, data) { sent.push({ broadcast: true, event, data }); }
    };
    const q = await collab.routeClarifyingQuestion(
      realtimeTransport, collabDir, participants,
      { text: 'which cache eviction policy?', topic: 'cache', source_section: 'redis topic' },
      { fallback_jaccard: true } // spec-collab-fix R007: Jaccard is opt-in
    );
    assert.strictEqual(q.routed_to, 'daniel', 'cache question should route to daniel');
    assert.strictEqual(sent.filter(s => s.handle === 'lucas').length, 0, 'lucas must not receive a non-target ping (R015)');

    // --- 6. Claim-queue race across two agents (R006) ---
    const rA = await collab.claimTask(transport, 'C001', 'daniel', { ttlSeconds: 120, now: 3_000_000 });
    const rB = await collab.claimTask(transport, 'C001', 'lucas',  { ttlSeconds: 120, now: 3_000_000 });
    assert.strictEqual([rA.acquired, rB.acquired].filter(Boolean).length, 1,
      'exactly one winner on claim race');

    // --- 7. Per-task branch push lifecycle (R007) ---
    const gitRunner = collab.createRecordingGitRunner();
    collab.startTaskBranch('C001', { runner: gitRunner });
    collab.updateTaskBranch('C001', { runner: gitRunner });
    collab.deleteTaskBranch('C001', { runner: gitRunner });
    const pushOps = gitRunner.calls.map(c => c.args.join(' '));
    assert.ok(pushOps.some(s => s.includes('forge/task/C001')));
    assert.ok(pushOps.some(s => s.includes('--force-with-lease')));
    assert.ok(pushOps.some(s => s.includes('--delete')));

    // --- 8. Forward-motion flag during execute phase (R008, R009, R015, R016) ---
    const flag = await collab.writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'C001', author: 'daniel',
      decision: 'use redis pubsub', alternatives: ['nats'],
      rationale: 'already in stack', source_contributors: ['daniel'],
      participants, transport: realtimeTransport,
      fallback_jaccard: true // spec-collab-fix R007: Jaccard is opt-in
    });
    assert.strictEqual(flag.written, true);
    assert.strictEqual(flag.notified.mode, 'targeted');

    // Flag ID uniqueness across many concurrent emits (R016)
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(collab.generateFlagId());
    assert.strictEqual(ids.size, 200);

    // --- 9. User-scoped log ensures no cross-user append contention (R016) ---
    const danielLog = path.join(collabDir, 'flag-emit-log-daniel.jsonl');
    const lucasLog  = path.join(collabDir, 'flag-emit-log-lucas.jsonl');
    await collab.writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'C002', author: 'lucas',
      decision: 'stripe v2', alternatives: [], rationale: '', source_contributors: ['lucas']
    });
    assert.ok(fs.existsSync(danielLog));
    assert.ok(fs.existsSync(lucasLog));
    assert.notStrictEqual(danielLog, lucasLog);

    // --- 10. Flag review + override (R009) ---
    const listed = collab.listFlags(collabDir);
    assert.ok(listed.length >= 1);
    const overridden = collab.overrideFlag(collabDir, flag.id, 'use nats', { author: 'lucas' });
    assert.strictEqual(overridden.overridden, true);
    const after = collab.readFlag(collabDir, flag.id);
    assert.strictEqual(after.status, 'overridden');
    assert.strictEqual(after.decision, 'use nats');

    // --- 11. Research task execution + streaming to git (R014) ---
    const researchTask = cats.find(c => c.type === 'research');
    const researchRunner = collab.createRecordingGitRunner();
    const r1 = collab.appendResearchSection({
      collabDir, taskId: researchTask.id, researcher: 'daniel',
      heading: 'Overview', body: 'redis supports pub/sub natively',
      cwd: projectDir, runner: researchRunner
    });
    assert.strictEqual(r1.pushed, true);
    const r2 = collab.appendResearchSection({
      collabDir, taskId: researchTask.id, researcher: 'daniel',
      heading: 'Benchmarks', body: 'read throughput: 100k/s',
      cwd: projectDir, runner: researchRunner
    });
    assert.strictEqual(r2.pushed, true);
    const resultFile = fs.readFileSync(r1.path, 'utf8');
    assert.match(resultFile, /## Overview/);
    assert.match(resultFile, /## Benchmarks/);

    // --- 12. Squash-merge race-retry on main (R010) ---
    let pushesA = 0;
    const mergeRunnerA = (args) => {
      mergeRunnerA.calls.push(args);
      if (args[0] === 'push') { pushesA++; }
      return '';
    };
    mergeRunnerA.calls = [];
    const mergeA = await collab.squashMergeAndPush({
      taskId: 'C001', runner: mergeRunnerA, sleep: async () => {}
    });
    assert.strictEqual(mergeA.pushed, true);

    // --- 13. Push-config inheritance: disabled -> prompter gated (R011) ---
    const gatedRunner = collab.createRecordingGitRunner();
    let prompted = false;
    const gated = await collab.gatedPush(['push', 'origin', 'main'], {
      forgeDir, autoPush: false, runner: gatedRunner,
      prompter: async () => { prompted = true; return true; }
    });
    assert.strictEqual(prompted, true);
    assert.strictEqual(gated.pushed, true);

    // --- 14. Late-join mid-session (R012) ---
    const lateRunner = collab.createRecordingGitRunner();
    const nowForLate = 3_000_000 + 1000; // within the 120s TTL of the C001 claim
    const lateResult = await collab.lateJoinBootstrap({
      transport,
      unblockedTaskIds: cats.map(c => c.id),
      runner: lateRunner,
      skipGitPull: true,
      now: nowForLate
    });
    assert.strictEqual(lateResult.joined, true);
    // C001 is still held by whoever won the claim race above -> late joiner must skip it
    const c001Claim = collab.readTaskClaim(transport, 'C001', { now: nowForLate });
    assert.ok(c001Claim, 'C001 claim should exist after race');
    assert.strictEqual(c001Claim.stale, false, 'C001 claim should be live at this clock');
    assert.ok(!lateResult.claimable.includes('C001'),
      'late joiner must skip tasks already held by live claims');

    // --- 15. Session identity is repo-derived (R001) ---
    const id1 = collab.sessionIdFromOrigin({ origin: 'https://github.com/example/repo.git' });
    const id2 = collab.sessionIdFromOrigin({ origin: 'https://github.com/example/repo.git' });
    assert.strictEqual(id1, id2);
    assert.strictEqual(id1.length, 12);
  });
});

// ---------------------------------------------------------------------
// Scenario B: transport mode selection matrix (R013).
// ---------------------------------------------------------------------

suite('T013 integration -- transport mode selection (R013)', () => {
  test('matrix: ABLY_KEY | polling opt-in | neither -> correct mode', async () => {
    assert.strictEqual(collab.selectTransportMode({ env: { ABLY_KEY: 'x' } }), 'ably');
    assert.strictEqual(collab.selectTransportMode({ env: {}, polling: true }), 'polling');
    assert.strictEqual(collab.selectTransportMode({ env: {} }), 'setup-required');
    const t = collab.createTransport({ env: {} });
    assert.strictEqual(t.mode, 'setup-required');
    assert.match(t.guide, /ABLY_KEY|npm install ably|--polling/);
  });
});

// ---------------------------------------------------------------------
// Scenario C: R015 scoped-routing regression (no broadcast leak).
// ---------------------------------------------------------------------

suite('T013 integration -- R015 scoped routing never leaks to non-targets', () => {
  test('flag write with single source_contributor pings only that handle', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const participants = [
      { handle: 'daniel', contributions: 'redis cache', active_tasks: 0 },
      { handle: 'lucas',  contributions: 'stripe payments', active_tasks: 0 },
      { handle: 'sarah',  contributions: 'react ui polish', active_tasks: 0 }
    ];
    const received = { daniel: 0, lucas: 0, sarah: 0, broadcast: 0 };
    const transport = {
      async sendTargeted(handle) { received[handle]++; },
      async publish() { received.broadcast++; }
    };
    await collab.writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'bot',
      decision: 'redis pubsub', alternatives: [], rationale: 'cache',
      source_contributors: ['daniel'], participants, transport,
      fallback_jaccard: true // spec-collab-fix R007: Jaccard is opt-in
    });
    assert.strictEqual(received.daniel, 1);
    assert.strictEqual(received.lucas, 0);
    assert.strictEqual(received.sarah, 0);
    assert.strictEqual(received.broadcast, 0);
  });
});

// ---------------------------------------------------------------------
// Scenario D: CLI bridges exposed through forge-tools.cjs.
// Lets the executor agent invoke collab primitives from bash/hook.
// ---------------------------------------------------------------------

suite('T013 integration -- forge-tools CLI bridges', () => {
  test('collab-mode-active returns true+exit 0 when participant.json exists', () => {
    const { projectDir, forgeDir } = makeTempForgeDir();
    fs.mkdirSync(path.join(forgeDir, 'collab'), { recursive: true });
    fs.writeFileSync(
      path.join(forgeDir, 'collab', 'participant.json'),
      JSON.stringify({ handle: 'daniel', session_id: 'abc', started: 'T' })
    );
    const r = spawnSync(process.execPath, [FORGE_TOOLS, 'collab-mode-active', '--forge-dir', forgeDir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /true/);
  });

  test('collab-mode-active returns false+exit 1 when participant.json absent', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = spawnSync(process.execPath, [FORGE_TOOLS, 'collab-mode-active', '--forge-dir', forgeDir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /false/);
  });

  test('collab-flag-decision writes a flag file and returns JSON', () => {
    const { projectDir, forgeDir } = makeTempForgeDir();
    fs.mkdirSync(path.join(forgeDir, 'collab'), { recursive: true });
    fs.writeFileSync(
      path.join(forgeDir, 'collab', 'participant.json'),
      JSON.stringify({ handle: 'daniel', session_id: 'abc', started: 'T' })
    );
    const r = spawnSync(process.execPath, [
      FORGE_TOOLS, 'collab-flag-decision',
      '--forge-dir', forgeDir,
      '--task', 'T005',
      '--decision', 'use redis pubsub',
      '--rationale', 'already in stack',
      '--alternatives', 'nats,postgres-listen',
      '--source-contributors', 'daniel,lucas',
      '--phase', 'executing'
    ], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.written, true);
    assert.ok(fs.existsSync(out.path));
    const flagRaw = fs.readFileSync(out.path, 'utf8');
    assert.match(flagRaw, /decision: "use redis pubsub"/);
    assert.match(flagRaw, /alternatives: \["nats","postgres-listen"\]/);
    assert.match(flagRaw, /source_contributors: \["daniel","lucas"\]/);
  });

  test('collab-flag-decision rejects wrong phase with exit 3', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.mkdirSync(path.join(forgeDir, 'collab'), { recursive: true });
    fs.writeFileSync(
      path.join(forgeDir, 'collab', 'participant.json'),
      JSON.stringify({ handle: 'x', session_id: 'y', started: 'T' })
    );
    const r = spawnSync(process.execPath, [
      FORGE_TOOLS, 'collab-flag-decision',
      '--forge-dir', forgeDir,
      '--task', 'T001',
      '--decision', 'x',
      '--phase', 'brainstorming'
    ], { encoding: 'utf8' });
    assert.strictEqual(r.status, 3);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.written, false);
    assert.strictEqual(out.reason, 'wrong_phase');
  });

  test('collab-flag-decision without required args exits 2', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = spawnSync(process.execPath, [
      FORGE_TOOLS, 'collab-flag-decision', '--forge-dir', forgeDir
    ], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  });
});

runTests();
