// tests/completion-gates.test.cjs -- T017 / R009
//
// Covers the four completion gates that must all pass before a
// `<promise>FORGE_COMPLETE</promise>` emission is honored:
//
//   1. tasks     -- every frontier task id is DONE / DONE_WITH_CONCERNS
//   2. visual    -- every [visual] AC in completion-gates.json is `pass`
//   3. nonvisual -- every non-visual AC in completion-gates.json is `pass`
//   4. flags     -- zero open collab flags under .forge/collab/flags/*.md
//
// Any gate failure produces `{ complete: false }` with a `reasons[]` list,
// and the `completion-emit` CLI rewrites the wire form as
// `<promise>FORGE_BLOCKED</promise>` followed by the inline reasons JSON.
// All-green state produces `FORGE_COMPLETE`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const {
  checkCompletionGates,
  emitCompletionPromise,
  writeTaskRegistry,
  initTaskRegistry
} = tools;

const FORGE_TOOLS_CLI = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────

// Seed a frontier with a known list of task ids. Mirrors the helper from
// setup-state-guard.test.cjs but dropped inline here so this suite stays
// standalone (no cross-test imports).
function seedFrontier(forgeDir, specName, taskIds) {
  const plansDir = path.join(forgeDir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const lines = ['---', `spec: ${specName}`, '---', '', '## Tier 1'];
  for (const id of taskIds) {
    lines.push(`- [${id}] task ${id} | est: ~5k tokens`);
  }
  fs.writeFileSync(
    path.join(plansDir, `${specName}-frontier.md`),
    lines.join('\n') + '\n'
  );
}

// Mark every task in the registry DONE so the tasks gate passes.
function markAllTasksDone(forgeDir, taskIds) {
  const reg = { tasks: {}, last_updated: new Date().toISOString() };
  for (const id of taskIds) {
    reg.tasks[id] = { status: 'DONE', completed_at: 'x', commit: 'abc' };
  }
  writeTaskRegistry(forgeDir, reg);
}

// Write a collab flag file with status=open so the flags gate fails.
function writeOpenFlag(forgeDir, flagId, taskId) {
  const flagsDir = path.join(forgeDir, 'collab', 'flags');
  fs.mkdirSync(flagsDir, { recursive: true });
  const fm = [
    '---',
    `id: ${flagId}`,
    `task_id: ${taskId}`,
    'status: open',
    '---',
    '',
    `Open flag ${flagId} awaiting human review.`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(flagsDir, `${flagId}.md`), fm);
}

// Drop a completion-gates.json so we exercise the authoritative-file path.
function writeCompletionGatesFile(forgeDir, payload) {
  fs.writeFileSync(
    path.join(forgeDir, 'completion-gates.json'),
    JSON.stringify(payload, null, 2)
  );
}

// Run `completion-check` CLI and return { exit, stdout, stderr, json }.
function runCompletionCheckCli(forgeDir) {
  const projectDir = path.dirname(forgeDir);
  let exit = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [FORGE_TOOLS_CLI, 'completion-check', '--forge-dir', forgeDir],
      { cwd: projectDir, encoding: 'utf8' }
    );
  } catch (e) {
    exit = e.status;
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  let json = null;
  try { json = JSON.parse(stdout.trim()); } catch (_) {}
  return { exit, stdout, stderr, json };
}

// Run `completion-emit` CLI and return { exit, stdout, stderr, firstLine }.
function runCompletionEmitCli(forgeDir) {
  const projectDir = path.dirname(forgeDir);
  let exit = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [FORGE_TOOLS_CLI, 'completion-emit', '--forge-dir', forgeDir],
      { cwd: projectDir, encoding: 'utf8' }
    );
  } catch (e) {
    exit = e.status;
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  const firstLine = stdout.split('\n')[0] || '';
  return { exit, stdout, stderr, firstLine };
}

// ─── 1. All green → complete:true, FORGE_COMPLETE emitted ──────────────────

suite('checkCompletionGates — all gates green', () => {
  test('all-green: complete=true, reasons empty, FORGE_COMPLETE emitted', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedFrontier(forgeDir, 'demo', ['T001', 'T002']);
    markAllTasksDone(forgeDir, ['T001', 'T002']);
    writeCompletionGatesFile(forgeDir, {
      visual: [{ id: 'R003.AC2', task_id: 'T010', status: 'pass' }],
      nonvisual: [{ id: 'R001.AC1', task_id: 'T010', status: 'pass' }]
    });

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, true);
    assert.deepStrictEqual(result.gates, {
      tasks: true, visual: true, nonvisual: true, flags: true
    });
    assert.deepStrictEqual(result.reasons, []);

    // CLI: exit 0 + JSON complete:true.
    const cli = runCompletionCheckCli(forgeDir);
    assert.strictEqual(cli.exit, 0);
    assert.ok(cli.json);
    assert.strictEqual(cli.json.complete, true);

    // Emit wire form: FORGE_COMPLETE.
    const { emission } = emitCompletionPromise(forgeDir, {});
    assert.match(emission, /<promise>FORGE_COMPLETE<\/promise>/);
    assert.ok(!emission.includes('FORGE_BLOCKED'), 'must not emit BLOCKED when gates pass');

    const emitCli = runCompletionEmitCli(forgeDir);
    assert.strictEqual(emitCli.exit, 0);
    assert.match(emitCli.firstLine, /<promise>FORGE_COMPLETE<\/promise>/);
    assert.ok(!emitCli.stdout.includes('FORGE_BLOCKED'));
  });
});

// ─── 2. Failing tasks gate ────────────────────────────────────────────────

suite('checkCompletionGates — tasks gate', () => {
  test('one task FAILED: complete=false, reasons[0].gate==="tasks"', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedFrontier(forgeDir, 'demo', ['T001', 'T002']);
    // T001 DONE, T002 not DONE (the failure case).
    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'DONE', completed_at: 'x', commit: 'a' };
    reg.tasks['T002'] = { status: 'FAILED', completed_at: null, commit: null };
    writeTaskRegistry(forgeDir, reg);

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.gates.tasks, false);
    assert.ok(result.reasons.length >= 1, 'at least one reason must be emitted');
    // The first-fail reason must be the tasks gate (no other gate can
    // fail here — visual/nonvisual sources are absent and flags dir is
    // missing, both of which are pass-by-default).
    assert.strictEqual(result.reasons[0].gate, 'tasks');
    assert.strictEqual(result.reasons[0].task, 'T002');
    assert.match(result.reasons[0].detail, /T002/);

    // CLI: exit 3, JSON complete:false.
    const cli = runCompletionCheckCli(forgeDir);
    assert.strictEqual(cli.exit, 3);
    assert.strictEqual(cli.json.complete, false);
    assert.strictEqual(cli.json.reasons[0].gate, 'tasks');
  });
});

// ─── 3. Failing visual gate ───────────────────────────────────────────────

suite('checkCompletionGates — visual gate', () => {
  test('one visual AC BLOCKED in completion-gates.json: complete=false, reasons[0].gate==="visual"', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedFrontier(forgeDir, 'demo', ['T001']);
    markAllTasksDone(forgeDir, ['T001']);
    writeCompletionGatesFile(forgeDir, {
      visual: [
        { id: 'R003.AC2', task_id: 'T010', status: 'blocked', detail: 'dev server unreachable' }
      ],
      nonvisual: []
    });

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.gates.visual, false);
    // Other gates unaffected.
    assert.strictEqual(result.gates.tasks, true);
    assert.strictEqual(result.gates.nonvisual, true);
    assert.strictEqual(result.gates.flags, true);

    assert.strictEqual(result.reasons[0].gate, 'visual');
    assert.strictEqual(result.reasons[0].ac, 'R003.AC2');
    assert.match(result.reasons[0].detail, /dev server unreachable/);
  });
});

// ─── 4. Failing flags gate ────────────────────────────────────────────────

suite('checkCompletionGates — flags gate', () => {
  test('one open collab flag: complete=false, reasons[0].gate==="flags"', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedFrontier(forgeDir, 'demo', ['T001']);
    markAllTasksDone(forgeDir, ['T001']);
    writeOpenFlag(forgeDir, 'FLAG-001', 'T001');

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.gates.flags, false);
    assert.strictEqual(result.gates.tasks, true);
    assert.strictEqual(result.gates.visual, true);
    assert.strictEqual(result.gates.nonvisual, true);

    assert.strictEqual(result.reasons[0].gate, 'flags');
    assert.strictEqual(result.reasons[0].flag, 'FLAG-001');
    assert.match(result.reasons[0].detail, /FLAG-001/);
  });
});

// ─── 5. Emit path: FORGE_BLOCKED when false ───────────────────────────────

suite('emitCompletionPromise — blocked wire form', () => {
  test('when gates false, output contains FORGE_BLOCKED and reasons JSON but NOT FORGE_COMPLETE', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    seedFrontier(forgeDir, 'demo', ['T001', 'T002']);
    // Mixed failure: one task not done + one open flag. The emit path
    // must surface both in the reasons payload.
    const reg = { tasks: {}, last_updated: new Date().toISOString() };
    reg.tasks['T001'] = { status: 'DONE', completed_at: 'x', commit: 'a' };
    reg.tasks['T002'] = { status: 'pending', completed_at: null, commit: null };
    writeTaskRegistry(forgeDir, reg);
    writeOpenFlag(forgeDir, 'FLAG-042', 'T002');

    const { emission, result } = emitCompletionPromise(forgeDir, {});
    assert.strictEqual(result.complete, false);

    // Wire form: FORGE_BLOCKED, not FORGE_COMPLETE.
    assert.match(emission, /<promise>FORGE_BLOCKED<\/promise>/);
    assert.ok(
      !emission.includes('<promise>FORGE_COMPLETE</promise>'),
      'must not emit COMPLETE when any gate fails'
    );

    // Inline reasons JSON — parseable and contains both failing gates.
    const jsonLine = emission.split('\n').find(l => l.startsWith('{'));
    assert.ok(jsonLine, 'emission must contain an inline JSON payload');
    const parsed = JSON.parse(jsonLine);
    assert.ok(Array.isArray(parsed.reasons), 'reasons must be an array');
    const gateKinds = parsed.reasons.map(r => r.gate);
    assert.ok(gateKinds.includes('tasks'), 'tasks failure must be represented');
    assert.ok(gateKinds.includes('flags'), 'flags failure must be represented');

    // CLI parity: same output via `completion-emit`, exit 3.
    const emitCli = runCompletionEmitCli(forgeDir);
    assert.strictEqual(emitCli.exit, 3);
    assert.match(emitCli.stdout, /<promise>FORGE_BLOCKED<\/promise>/);
    assert.ok(!emitCli.stdout.includes('FORGE_COMPLETE'));
    const cliJsonLine = emitCli.stdout.split('\n').find(l => l.startsWith('{'));
    assert.ok(cliJsonLine, 'CLI emission must contain an inline JSON payload');
    assert.ok(JSON.parse(cliJsonLine).reasons.length >= 2);
  });
});

runTests();
