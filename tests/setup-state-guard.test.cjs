// tests/setup-state-guard.test.cjs -- T009 / R008
//
// Verifies the two halves of the "silent iteration-zero complete" fix:
//
//   1. writeState refuses to land `task_status: complete` unless the frontier
//      file exists AND every task has a DONE / DONE_WITH_CONCERNS registry
//      entry. Violations land in
//      .forge/history/cycles/<cycle>/state-violations.jsonl with a stable
//      JSON shape including an actionable reason.
//
//   2. The `setup-state` CLI subcommand is authoritative for the ingest
//      frontmatter: no matter what the inbound state.md claims, it writes
//      `task_status: pending, current_task: <first-task-id>, completed_tasks: []`.
//      This closes the graph-visual-quality trap where a fresh spec shipped
//      with `task_status: complete`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const {
  writeState,
  readState,
  readTaskRegistry,
  writeTaskRegistry,
  initTaskRegistry,
  parseFrontier
} = tools;

// Resolve the forge-tools CLI once. Tests invoke it via child_process so they
// exercise the real setup-state subcommand end-to-end (same code path the
// loop uses).
const FORGE_TOOLS_CLI = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');

// Seed a minimal approved spec + frontier pair into a temp forgeDir. Returns
// the parsed task list from the frontier for convenience.
function seedSpecAndFrontier(forgeDir, specName, taskIds) {
  const specsDir = path.join(forgeDir, 'specs');
  const plansDir = path.join(forgeDir, 'plans');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  const specFile = path.join(specsDir, `spec-${specName}.md`);
  fs.writeFileSync(
    specFile,
    '---\n' +
      `domain: ${specName}\n` +
      'status: approved\n' +
      '---\n\n' +
      `# ${specName}\n`
  );

  const lines = ['---', `spec: ${specName}`, '---', '', '## Tier 1'];
  for (const id of taskIds) {
    lines.push(`- [${id}] task ${id} | est: ~5k tokens`);
  }
  const frontierPath = path.join(plansDir, `${specName}-frontier.md`);
  fs.writeFileSync(frontierPath, lines.join('\n') + '\n');

  return { specFile, frontierPath, tasks: parseFrontier(fs.readFileSync(frontierPath, 'utf8')) };
}

// Read all violation log lines across any cycle directory. Tests accept any
// cycle id because the guard derives one from wall-clock when opts.now is
// not supplied, and we want the assertions to stay deterministic.
function readAllViolations(forgeDir) {
  const cyclesDir = path.join(forgeDir, 'history', 'cycles');
  if (!fs.existsSync(cyclesDir)) return [];
  const out = [];
  for (const cycle of fs.readdirSync(cyclesDir)) {
    const vPath = path.join(cyclesDir, cycle, 'state-violations.jsonl');
    if (!fs.existsSync(vPath)) continue;
    const text = fs.readFileSync(vPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      out.push({ cycle, record: JSON.parse(line) });
    }
  }
  return out;
}

// ─── 1. Direct writeState guard — reject task_status: complete on fresh spec ─

suite('writeState R008 guard — direct write rejection', () => {
  test('fresh spec with no completed tasks: guard throws + violation appended', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002', 'T003']);
    initTaskRegistry(forgeDir, [
      { id: 'T001' }, { id: 'T002' }, { id: 'T003' }
    ]);

    // Land a baseline state.md where the active spec points at the frontier
    // but no tasks have been completed yet.
    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', current_task: 'T001', task_status: 'pending' },
      '## done\n'
    );

    // Attempt the pathological write: task_status=complete with current_task=null.
    let thrown = null;
    try {
      writeState(forgeDir, { task_status: 'complete', current_task: null }, { now: '2026-04-20T17:30:00.000Z' });
    } catch (e) {
      thrown = e;
    }

    assert.ok(thrown, 'guard must throw on silent-complete write');
    assert.strictEqual(thrown.code, 'E_STATE_WRITE_GUARD');
    assert.match(thrown.message, /Refusing task_status=complete/);
    assert.match(thrown.message, /non-DONE statuses/);

    // State file must remain untouched by the rejected write — task_status
    // still reads `pending` from the prior successful write.
    const state = readState(forgeDir);
    assert.strictEqual(state.data.task_status, 'pending');

    // Violation log should have exactly one line with a stable shape.
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 1);
    const rec = violations[0].record;
    assert.ok(rec.at && typeof rec.at === 'string', 'violation carries ISO timestamp');
    assert.deepStrictEqual(rec.attempted, {
      task_status: 'complete',
      current_task: null,
      spec: 'demo'
    });
    assert.match(rec.reason, /Refusing task_status=complete/);
    assert.ok(rec.frontier_path && rec.frontier_path.endsWith('demo-frontier.md'));
    // Missing task ids list must call out every not-yet-DONE task — all
    // three here because the registry statuses are 'pending'.
    assert.deepStrictEqual(rec.missing_task_ids.sort(), ['T001', 'T002', 'T003']);
  });

  test('frontier missing: guard throws + violation names the missing path', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    // Establish a spec in state.md but NO frontier file on disk.
    writeState(
      forgeDir,
      { phase: 'executing', spec: 'ghost', current_task: 'T001', task_status: 'pending' },
      ''
    );

    let thrown = null;
    try {
      writeState(forgeDir, { task_status: 'complete' });
    } catch (e) { thrown = e; }

    assert.ok(thrown, 'guard must throw when frontier file is absent');
    assert.strictEqual(thrown.code, 'E_STATE_WRITE_GUARD');
    assert.match(thrown.message, /frontier file not found/);

    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 1);
    assert.match(violations[0].record.reason, /frontier file not found/);
    assert.deepStrictEqual(violations[0].record.missing_task_ids, []);
  });

  test('no active spec: guard throws with spec-missing reason', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'executing', task_status: 'pending' }, '');

    let thrown = null;
    try {
      writeState(forgeDir, { task_status: 'complete' });
    } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.match(thrown.message, /no active spec declared/);
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].record.frontier_path, null);
  });
});

// ─── 2. Direct writeState — all three gates satisfied — success path ────────

suite('writeState R008 guard — all gates green', () => {
  test('frontier exists + every task DONE: write succeeds, no violation', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002']);

    // Populate registry with all-complete statuses (internal lowercase form).
    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'complete', completed_at: 'x', commit: 'a' };
    reg.tasks['T002'] = { status: 'complete_with_concerns', completed_at: 'x', commit: 'b' };
    writeTaskRegistry(forgeDir, reg);

    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', current_task: 'T002', task_status: 'testing' },
      '## done\n'
    );

    // The spec-level complete signal must now be acceptable.
    assert.doesNotThrow(() => {
      writeState(forgeDir, { task_status: 'complete', current_task: null });
    });

    const state = readState(forgeDir);
    assert.strictEqual(state.data.task_status, 'complete');

    // No violations should have been written because the gates were green.
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 0);
  });

  test('status-report shape (DONE, DONE_WITH_CONCERNS) is also accepted', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002']);

    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'DONE', completed_at: 'x', commit: 'a' };
    reg.tasks['T002'] = { status: 'DONE_WITH_CONCERNS', completed_at: 'x', commit: 'b' };
    writeTaskRegistry(forgeDir, reg);

    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', task_status: 'testing', current_task: 'T002' },
      ''
    );

    assert.doesNotThrow(() => {
      writeState(forgeDir, { task_status: 'complete' });
    });
  });

  test('one task still pending: guard throws and names just that task', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002', 'T003']);

    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'complete', completed_at: 'x', commit: 'a' };
    reg.tasks['T002'] = { status: 'complete', completed_at: 'x', commit: 'b' };
    reg.tasks['T003'] = { status: 'testing', completed_at: null, commit: null };
    writeTaskRegistry(forgeDir, reg);

    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', task_status: 'testing', current_task: 'T003' },
      ''
    );

    let thrown = null;
    try {
      writeState(forgeDir, { task_status: 'complete' });
    } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.match(thrown.message, /T003=testing/);
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 1);
    // Only T003 was non-DONE so that's the only entry in missing_task_ids.
    assert.deepStrictEqual(violations[0].record.missing_task_ids, ['T003']);
  });

  test('frontier lists a task not present in the registry: flagged as missing', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002']);

    // Deliberately omit T002 from the registry.
    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'complete', completed_at: 'x', commit: 'a' };
    writeTaskRegistry(forgeDir, reg);

    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', task_status: 'pending', current_task: 'T001' },
      ''
    );

    let thrown = null;
    try { writeState(forgeDir, { task_status: 'complete' }); }
    catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.match(thrown.message, /missing registry entries for T002/);
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].record.missing_task_ids, ['T002']);
  });
});

// ─── 3. Non-complete writes are never guarded ─────────────────────────────

suite('writeState R008 guard — scope', () => {
  test('task_status: pending / testing / reviewing all pass through untouched', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001']);
    initTaskRegistry(forgeDir, [{ id: 'T001' }]);

    // None of these writes involve task_status=complete, so the guard
    // must not intercept them even though the frontier is full of pending
    // tasks.
    assert.doesNotThrow(() => {
      writeState(forgeDir, { spec: 'demo', phase: 'executing', task_status: 'pending' });
      writeState(forgeDir, { task_status: 'testing' });
      writeState(forgeDir, { task_status: 'reviewing' });
      writeState(forgeDir, { task_status: 'blocked' });
      writeState(forgeDir, { task_status: null });
    });

    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 0);
  });

  test('legacy 3-arg full-write form honours the guard too', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001']);
    initTaskRegistry(forgeDir, [{ id: 'T001' }]);

    let thrown = null;
    try {
      writeState(
        forgeDir,
        { phase: 'executing', spec: 'demo', task_status: 'complete' },
        '## done\n'
      );
    } catch (e) { thrown = e; }

    assert.ok(thrown, 'legacy full-write must also be guarded');
    assert.strictEqual(thrown.code, 'E_STATE_WRITE_GUARD');
  });
});

// ─── 4. setup-state CLI hardening — ingest overrides source state ──────────

suite('setup-state ingest hardening (R008 AC1)', () => {
  test('state.md authored as task_status=complete: setup-state rewrites to pending/T001', () => {
    const { projectDir, forgeDir } = makeTempForgeDir({ seedState: false });

    // Seed an adversarial inbound state.md — simulates the graph-visual-quality
    // case where the source state claims completion on a fresh spec.
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\n' +
        'phase: executing\n' +
        'task_status: complete\n' +
        'current_task: null\n' +
        'completed_tasks: ["T001","T002","T003"]\n' +
        '---\n\n' +
        '## done\nlies about completion\n'
    );

    seedSpecAndFrontier(forgeDir, 'demo', ['T001', 'T002', 'T003']);

    // Invoke the CLI the same way /forge:execute does.
    const out = execFileSync(
      process.execPath,
      [
        FORGE_TOOLS_CLI,
        'setup-state',
        '--forge-dir', forgeDir,
        '--spec', 'demo',
        '--autonomy', 'full',
        '--depth', 'standard',
        '--max-iterations', '10',
        '--token-budget', '100000'
      ],
      { cwd: projectDir, encoding: 'utf8' }
    );
    assert.match(out, /Loop state initialized/);

    // After ingest, state.md must be authoritative for the three fields
    // regardless of what the inbound state claimed.
    const state = readState(forgeDir);
    assert.strictEqual(state.data.task_status, 'pending');
    assert.strictEqual(state.data.current_task, 'T001');
    assert.deepStrictEqual(state.data.completed_tasks, []);
    assert.strictEqual(state.data.spec, 'demo');
    assert.strictEqual(state.data.phase, 'executing');

    // Registry must be populated from every frontier file so the guard has
    // something to consult on future writes.
    const reg = readTaskRegistry(forgeDir);
    assert.ok(reg.tasks['T001']);
    assert.strictEqual(reg.tasks['T001'].status, 'pending');
    assert.strictEqual(reg.tasks['T002'].status, 'pending');
    assert.strictEqual(reg.tasks['T003'].status, 'pending');

    // No violations should have been logged — setup-state never writes
    // task_status=complete, so the guard never fires during ingest.
    const violations = readAllViolations(forgeDir);
    assert.strictEqual(violations.length, 0);
  });

  test('multi-spec workspace: current_task lands on the active spec first task', () => {
    const { projectDir, forgeDir } = makeTempForgeDir({ seedState: false });
    // Write an adversarial state.md so the fallback isn't accidentally
    // picking up whatever happens to be there.
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: idle\ntask_status: complete\ncurrent_task: T999\n---\n'
    );
    // Two specs coexist; the active spec's first task is T042 (not T001).
    seedSpecAndFrontier(forgeDir, 'alpha', ['T100', 'T101']);
    seedSpecAndFrontier(forgeDir, 'beta', ['T042', 'T043', 'T044']);

    execFileSync(
      process.execPath,
      [
        FORGE_TOOLS_CLI, 'setup-state',
        '--forge-dir', forgeDir,
        '--spec', 'beta',
        '--autonomy', 'full',
        '--depth', 'standard',
        '--max-iterations', '10',
        '--token-budget', '100000'
      ],
      { cwd: projectDir, encoding: 'utf8' }
    );

    const state = readState(forgeDir);
    assert.strictEqual(state.data.task_status, 'pending');
    assert.strictEqual(state.data.current_task, 'T042');
    assert.deepStrictEqual(state.data.completed_tasks, []);
  });
});

// ─── 5. Violation JSONL shape stability ───────────────────────────────────

suite('violation JSONL shape is stable (R008 AC3)', () => {
  test('record carries exactly {at, attempted, reason, frontier_path, missing_task_ids}', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedSpecAndFrontier(forgeDir, 'demo', ['T001']);
    initTaskRegistry(forgeDir, [{ id: 'T001' }]);

    writeState(
      forgeDir,
      { phase: 'executing', spec: 'demo', task_status: 'pending', current_task: 'T001' },
      ''
    );

    // Deterministic clock so the violation lands in a known cycle directory.
    const fixedNow = '2026-04-20T17:30:12.345Z';
    try {
      writeState(forgeDir, { task_status: 'complete' }, { now: fixedNow });
      assert.fail('expected guard to throw');
    } catch (e) {
      assert.strictEqual(e.code, 'E_STATE_WRITE_GUARD');
    }

    // Cycle id derived from the fixed now: YYYYMMDDTHHMMZ (the `T` marker
    // is preserved so the name stays ISO-recognisable).
    const expectedCycle = '20260420T1730Z';
    const vPath = path.join(
      forgeDir, 'history', 'cycles', expectedCycle, 'state-violations.jsonl'
    );
    assert.ok(fs.existsSync(vPath), 'violation jsonl should live in the deterministic cycle dir');

    const lines = fs.readFileSync(vPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);

    const rec = JSON.parse(lines[0]);
    const keys = Object.keys(rec).sort();
    assert.deepStrictEqual(
      keys,
      ['at', 'attempted', 'frontier_path', 'missing_task_ids', 'reason']
    );
    assert.strictEqual(rec.at, fixedNow);
    assert.strictEqual(typeof rec.reason, 'string');
    assert.ok(rec.reason.length > 10, 'reason must be actionable, not a bare sentinel');
    assert.ok(Array.isArray(rec.missing_task_ids));
  });
});

runTests();
