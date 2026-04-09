// tests/budget.test.cjs -- per-task token budget ledger (T006, R001)

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const {
  registerTask,
  recordTaskTokens,
  checkTaskBudget,
  resolveTaskBudget,
  budgetStatusReport,
  readLedger,
  writeLedgerAtomic,
  DEFAULT_CONFIG
} = tools;

suite('resolveTaskBudget', () => {
  test('returns quick depth ceiling from defaults', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(resolveTaskBudget(forgeDir, 'quick'), DEFAULT_CONFIG.per_task_budget.quick);
  });

  test('returns standard depth ceiling from defaults', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(resolveTaskBudget(forgeDir, 'standard'), DEFAULT_CONFIG.per_task_budget.standard);
  });

  test('returns thorough depth ceiling from defaults', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(resolveTaskBudget(forgeDir, 'thorough'), DEFAULT_CONFIG.per_task_budget.thorough);
  });

  test('honors user override from config.json', () => {
    const { forgeDir } = makeTempForgeDir({
      config: { per_task_budget: { standard: 7777 } }
    });
    assert.strictEqual(resolveTaskBudget(forgeDir, 'standard'), 7777);
  });
});

suite('registerTask', () => {
  test('creates a task entry with depth + budget snapshot', () => {
    const { forgeDir } = makeTempForgeDir();
    const entry = registerTask('T100', 'standard', forgeDir);
    assert.strictEqual(entry.depth, 'standard');
    assert.strictEqual(entry.tokens, 0);
    assert.strictEqual(entry.budget, DEFAULT_CONFIG.per_task_budget.standard);
    assert.ok(entry.started_at);
    assert.ok(entry.last_update);
  });

  test('idempotent on re-registration: preserves token count', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T101', 'standard', forgeDir);
    recordTaskTokens('T101', 1234, forgeDir);
    const refreshed = registerTask('T101', 'thorough', forgeDir);
    assert.strictEqual(refreshed.tokens, 1234);
    assert.strictEqual(refreshed.depth, 'thorough');
  });

  test('throws on missing taskId', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(() => registerTask(null, 'quick', forgeDir), /taskId required/);
  });
});

suite('recordTaskTokens', () => {
  test('increments token counter', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T200', 'quick', forgeDir);
    recordTaskTokens('T200', 100, forgeDir);
    recordTaskTokens('T200', 250, forgeDir);
    const status = checkTaskBudget('T200', forgeDir);
    assert.strictEqual(status.used, 350);
  });

  test('auto-registers unknown task using standard depth', () => {
    const { forgeDir } = makeTempForgeDir();
    const entry = recordTaskTokens('T201_unknown', 500, forgeDir);
    assert.ok(entry);
    assert.strictEqual(entry.depth, 'standard');
    assert.strictEqual(entry.tokens, 500);
  });

  test('treats non-numeric tokens as 0', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T202', 'quick', forgeDir);
    recordTaskTokens('T202', 'banana', forgeDir);
    assert.strictEqual(checkTaskBudget('T202', forgeDir).used, 0);
  });
});

suite('checkTaskBudget', () => {
  test('returns stable shape for unknown task', () => {
    const { forgeDir } = makeTempForgeDir();
    const status = checkTaskBudget('T_does_not_exist', forgeDir);
    assert.strictEqual(status.registered, false);
    assert.strictEqual(status.used, 0);
    assert.ok(status.budget > 0);
    assert.strictEqual(status.remaining, status.budget);
  });

  test('zero tokens reports 0% used', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T300', 'standard', forgeDir);
    const status = checkTaskBudget('T300', forgeDir);
    assert.strictEqual(status.used, 0);
    assert.strictEqual(status.percentage, 0);
    assert.strictEqual(status.remaining, status.budget);
  });

  test('exactly at budget reports 100% and 0 remaining', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T301', 'quick', forgeDir);
    const budget = resolveTaskBudget(forgeDir, 'quick');
    recordTaskTokens('T301', budget, forgeDir);
    const status = checkTaskBudget('T301', forgeDir);
    assert.strictEqual(status.used, budget);
    assert.strictEqual(status.remaining, 0);
    assert.strictEqual(status.percentage, 100);
  });

  test('over budget clamps remaining to 0 and reports >100%', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T302', 'quick', forgeDir);
    const budget = resolveTaskBudget(forgeDir, 'quick');
    recordTaskTokens('T302', budget * 2, forgeDir);
    const status = checkTaskBudget('T302', forgeDir);
    assert.strictEqual(status.remaining, 0);
    assert.ok(status.percentage >= 100);
  });
});

suite('legacy ledger migration', () => {
  test('readLedger backfills tasks map on legacy flat ledger', () => {
    const { forgeDir } = makeTempForgeDir();
    // Write legacy ledger shape (no `tasks` key)
    fs.writeFileSync(
      path.join(forgeDir, 'token-ledger.json'),
      JSON.stringify({ total: 1000, iterations: 3, per_spec: { auth: 1000 } })
    );
    const ledger = readLedger(forgeDir);
    assert.deepStrictEqual(ledger.tasks, {});
    assert.strictEqual(ledger.total, 1000);
    assert.strictEqual(ledger.iterations, 3);
    assert.strictEqual(ledger.last_transcript_tokens, 0);
  });

  test('readLedger handles missing file as empty', () => {
    const { forgeDir } = makeTempForgeDir();
    const ledger = readLedger(forgeDir);
    assert.strictEqual(ledger.total, 0);
    assert.deepStrictEqual(ledger.tasks, {});
  });

  test('readLedger handles corrupt JSON as empty', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, 'token-ledger.json'), '{not json');
    const ledger = readLedger(forgeDir);
    assert.strictEqual(ledger.total, 0);
  });
});

suite('budgetStatusReport', () => {
  test('produces session block + tasks array', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T400', 'quick', forgeDir);
    registerTask('T401', 'standard', forgeDir);
    recordTaskTokens('T400', 200, forgeDir);
    const report = budgetStatusReport(forgeDir);
    assert.ok(Array.isArray(report.tasks));
    assert.strictEqual(report.tasks.length, 2);
    assert.ok(report.totals);
    assert.ok(typeof report.totals.used === 'number');
    assert.ok(report.session);
    assert.ok('session_budget_tokens' in report.session);
    assert.ok('iteration' in report.session);
    assert.ok('max_iterations' in report.session);
  });

  test('scoped to single task when taskId given', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T410', 'quick', forgeDir);
    registerTask('T411', 'quick', forgeDir);
    const report = budgetStatusReport(forgeDir, 'T410');
    assert.strictEqual(report.tasks.length, 1);
    assert.strictEqual(report.tasks[0].task_id, 'T410');
    assert.ok(report.session);
  });

  test('json roundtrips cleanly', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T420', 'standard', forgeDir);
    const report = budgetStatusReport(forgeDir);
    const roundtrip = JSON.parse(JSON.stringify(report));
    assert.deepStrictEqual(roundtrip, report);
  });
});

runTests();
