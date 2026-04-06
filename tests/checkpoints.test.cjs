// tests/checkpoints.test.cjs -- checkpoint store (T009)

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const {
  writeCheckpoint,
  readCheckpoint,
  updateCheckpoint,
  listCheckpoints,
  deleteCheckpoint
} = tools;

function baseCp(taskId) {
  return {
    task_name: 'sample task',
    spec_domain: 'auth',
    current_step: 'implementation_started',
    next_step: 'tests_written',
    artifacts_produced: ['src/a.js'],
    context_bundle: { spec_section: 'R001' },
    depth: 'standard',
    token_usage: 100
  };
}

suite('writeCheckpoint + readCheckpoint', () => {
  test('round-trips a normalized checkpoint', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'T001', baseCp('T001'));
    const cp = readCheckpoint(forgeDir, 'T001');
    assert.ok(cp);
    assert.strictEqual(cp.task_id, 'T001');
    assert.strictEqual(cp.current_step, 'implementation_started');
    assert.strictEqual(cp.next_step, 'tests_written');
    assert.deepStrictEqual(cp.artifacts_produced, ['src/a.js']);
    assert.strictEqual(cp.context_bundle.spec_section, 'R001');
  });

  test('readCheckpoint returns null on missing file', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(readCheckpoint(forgeDir, 'T_missing'), null);
  });

  test('writeCheckpoint rejects invalid current_step', () => {
    const { forgeDir } = makeTempForgeDir();
    const bad = Object.assign({}, baseCp('T002'), { current_step: 'bogus_step' });
    assert.throws(() => writeCheckpoint(forgeDir, 'T002', bad), /invalid current_step/);
  });

  test('writeCheckpoint rejects missing required field', () => {
    const { forgeDir } = makeTempForgeDir();
    const bad = Object.assign({}, baseCp('T003'));
    delete bad.current_step;
    assert.throws(() => writeCheckpoint(forgeDir, 'T003', bad), /missing required field/);
  });
});

suite('updateCheckpoint', () => {
  test('deep-merges context_bundle (preserves prior keys)', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'T010', baseCp('T010'));
    updateCheckpoint(forgeDir, 'T010', {
      current_step: 'tests_written',
      next_step: 'tests_passing',
      context_bundle: { dependency_artifacts: ['T005'] }
    });
    const cp = readCheckpoint(forgeDir, 'T010');
    assert.strictEqual(cp.context_bundle.spec_section, 'R001');
    assert.deepStrictEqual(cp.context_bundle.dependency_artifacts, ['T005']);
  });

  test('appends to error_log instead of replacing', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('T011'), { error_log: ['first error'] });
    writeCheckpoint(forgeDir, 'T011', cp);
    updateCheckpoint(forgeDir, 'T011', {
      current_step: 'tests_written',
      next_step: 'tests_passing',
      error_log: ['second error']
    });
    const out = readCheckpoint(forgeDir, 'T011');
    assert.deepStrictEqual(out.error_log, ['first error', 'second error']);
  });

  test('unions artifacts_produced (no duplicates, preserves order)', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'T012', baseCp('T012'));
    updateCheckpoint(forgeDir, 'T012', {
      current_step: 'tests_written',
      next_step: 'tests_passing',
      artifacts_produced: ['src/a.js', 'src/b.js']
    });
    const out = readCheckpoint(forgeDir, 'T012');
    assert.deepStrictEqual(out.artifacts_produced, ['src/a.js', 'src/b.js']);
  });

  test('throws when updating missing checkpoint', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(
      () => updateCheckpoint(forgeDir, 'T_nope', { current_step: 'complete', next_step: 'complete' }),
      /cannot update missing checkpoint/
    );
  });
});

suite('listCheckpoints', () => {
  test('returns empty array when no progress dir', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.deepStrictEqual(listCheckpoints(forgeDir), []);
  });

  test('sorts by last_updated descending', async () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'T100', baseCp('T100'));
    // Tiny spin so the second write has a later timestamp
    const until = Date.now() + 10;
    while (Date.now() < until) { /* spin */ }
    writeCheckpoint(forgeDir, 'T101', baseCp('T101'));
    const list = listCheckpoints(forgeDir);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].task_id, 'T101');
    assert.strictEqual(list[1].task_id, 'T100');
  });
});

suite('deleteCheckpoint', () => {
  test('removes a written checkpoint', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'T200', baseCp('T200'));
    const r = deleteCheckpoint(forgeDir, 'T200');
    assert.strictEqual(r.deleted, true);
    assert.strictEqual(readCheckpoint(forgeDir, 'T200'), null);
  });

  test('idempotent on missing file (returns deleted: false)', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = deleteCheckpoint(forgeDir, 'T_nope');
    assert.strictEqual(r.deleted, false);
  });
});

suite('writeCheckpoint caveman integration (T029, R013)', () => {
  test('context_bundle string values are caveman-formatted', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('TC1'), {
      context_bundle: {
        spec_section: 'R001',
        notes: 'I just really finished the implementation of the endpoint.'
      }
    });
    writeCheckpoint(forgeDir, 'TC1', cp);
    const out = readCheckpoint(forgeDir, 'TC1');
    assert.strictEqual(out.context_bundle.spec_section, 'R001');
    assert.doesNotMatch(out.context_bundle.notes, /\bjust\b/);
    assert.doesNotMatch(out.context_bundle.notes, /\breally\b/);
  });

  test('error_log msg fields are caveman-formatted', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('TC2'), {
      error_log: [
        { ts: '2025-01-01T00:00:00Z', msg: 'The build really failed due to a missing dependency.' }
      ]
    });
    writeCheckpoint(forgeDir, 'TC2', cp);
    const out = readCheckpoint(forgeDir, 'TC2');
    assert.doesNotMatch(out.error_log[0].msg, /\breally\b/);
    assert.doesNotMatch(out.error_log[0].msg, /\bdue to\b/);
    assert.strictEqual(out.error_log[0].ts, '2025-01-01T00:00:00Z');
  });

  test('error_log string entries are caveman-formatted', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('TC3'), {
      error_log: ['I just really hit an error in the parser.']
    });
    writeCheckpoint(forgeDir, 'TC3', cp);
    const out = readCheckpoint(forgeDir, 'TC3');
    assert.doesNotMatch(out.error_log[0], /\bjust\b/);
    assert.doesNotMatch(out.error_log[0], /\breally\b/);
  });

  test('skipCavemanFormat=true preserves verbose context_bundle', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('TC4'), {
      context_bundle: { notes: 'I just really finished the work.' }
    });
    writeCheckpoint(forgeDir, 'TC4', cp, { skipCavemanFormat: true });
    const out = readCheckpoint(forgeDir, 'TC4');
    assert.match(out.context_bundle.notes, /just really finished the work/);
  });

  test('structured fields (task_id, current_step, timestamps) untouched', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'TC5', baseCp('TC5'));
    const out = readCheckpoint(forgeDir, 'TC5');
    assert.strictEqual(out.task_id, 'TC5');
    assert.strictEqual(out.current_step, 'implementation_started');
    assert.match(out.started_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('reader handles verbose legacy checkpoint (backward compatible)', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = Object.assign({}, baseCp('TC6'), {
      context_bundle: { notes: 'The really verbose legacy text just sits here.' }
    });
    writeCheckpoint(forgeDir, 'TC6', cp, { skipCavemanFormat: true });
    const out = readCheckpoint(forgeDir, 'TC6');
    assert.ok(out);
    assert.match(out.context_bundle.notes, /verbose legacy/);
  });

  test('updateCheckpoint propagates skipCavemanFormat option', () => {
    const { forgeDir } = makeTempForgeDir();
    writeCheckpoint(forgeDir, 'TC7', baseCp('TC7'));
    updateCheckpoint(forgeDir, 'TC7', {
      current_step: 'tests_written',
      next_step: 'tests_passing',
      context_bundle: { notes: 'I just really finished the work.' }
    }, { skipCavemanFormat: true });
    const out = readCheckpoint(forgeDir, 'TC7');
    assert.match(out.context_bundle.notes, /just really finished/);
  });
});

runTests();
