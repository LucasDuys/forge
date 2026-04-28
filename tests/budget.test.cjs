// tests/budget.test.cjs -- per-task token budget ledger (T006, R001)

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');
const budget = require('../scripts/forge-budget.cjs');

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

// === T003 / R003 -- token-ledger v2 schema integration ====================

suite('ledger v2 schema (T003 / R003)', () => {
  test('writeLedgerAtomic stamps schema_version=2 on every write', () => {
    const { forgeDir } = makeTempForgeDir();
    registerTask('T_v2_a', 'standard', forgeDir);
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, 'token-ledger.json'), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
  });

  test('v1 ledger auto-upgrades on next write via registerTask', () => {
    const { forgeDir } = makeTempForgeDir();
    // Seed a v1 ledger (no schema_version field).
    fs.writeFileSync(
      path.join(forgeDir, 'token-ledger.json'),
      JSON.stringify({ total: 999, iterations: 3, per_spec: { auth: 999 }, tasks: {} })
    );
    registerTask('T_v2_b', 'quick', forgeDir);
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, 'token-ledger.json'), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
    // v1 fields preserved verbatim.
    assert.strictEqual(onDisk.total, 999);
    assert.strictEqual(onDisk.iterations, 3);
    assert.strictEqual(onDisk.per_spec.auth, 999);
    // New task lives in tasks{} as before.
    assert.ok(onDisk.tasks.T_v2_b);
  });

  test('dual-write integrity: estimate AND actual fields land in same ledger', () => {
    const { forgeDir } = makeTempForgeDir();
    // Estimate path (existing v1 behavior).
    registerTask('T_v2_c', 'standard', forgeDir);
    recordTaskTokens('T_v2_c', 1234, forgeDir);
    // Actual path (new v2 behavior).
    budget.recordActualUsage(forgeDir, 'T_v2_c', {
      input: 10000, output: 500, cache_read: 2000, cache_write: 100,
      buckets: { instructions: 4000, tool_definitions: 1500, tool_results: 1500,
                 repo_reads: 3000, prose: 0 },
      source: 'transcript',
    });

    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, 'token-ledger.json'), 'utf8'));
    // Estimate (v1) shape: tokens counter for the budget gate.
    assert.strictEqual(onDisk.tasks.T_v2_c.tokens, 1234);
    assert.strictEqual(onDisk.tasks.T_v2_c.depth, 'standard');
    // Actual (v2) shape: full input/output/cache breakdown + 5 buckets.
    const actual = onDisk.usage_actual.tasks.T_v2_c;
    assert.strictEqual(actual.input, 10000);
    assert.strictEqual(actual.output, 500);
    assert.strictEqual(actual.cache_read, 2000);
    assert.strictEqual(actual.cache_write, 100);
    assert.strictEqual(actual.source, 'transcript');
    assert.strictEqual(actual.buckets.instructions, 4000);
    assert.strictEqual(actual.buckets.tool_definitions, 1500);
    assert.strictEqual(actual.buckets.tool_results, 1500);
    assert.strictEqual(actual.buckets.repo_reads, 3000);
    assert.strictEqual(actual.buckets.prose, 0);
  });

  test('bucket field names match T002 classifyTokens output exactly', () => {
    // Pull the canonical bucket key list from forge-budget; compare against
    // an actual classifyTokens() invocation. Identity must hold so writers
    // and readers can never disagree on field names.
    const tokenBucket = require('../scripts/forge-token-bucket.cjs');
    const out = tokenBucket.classifyTokens({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      system: 'x'
    });
    const fromClassifier = Object.keys(out).filter(k => k !== 'skipped').sort();
    const fromBudget = budget.BUCKET_KEYS.slice().sort();
    assert.deepStrictEqual(fromClassifier, fromBudget,
      'BUCKET_KEYS in forge-budget must match classifyTokens output keys');
  });

  test('regression: hard 100% gate still triggers after v1->v2 migration', () => {
    // CRITICAL: The 80%/100% per-task budget gate is the single most important
    // existing behavior in forge-budget/forge-tools. After T003 lands, the
    // computation MUST be byte-identical: tokens / budget * 100, with the
    // existing rounding. New schema fields cannot influence the gate.
    const { forgeDir } = makeTempForgeDir();

    // Seed a v1 ledger with a task at exactly 100% of its budget.
    const quickBudget = resolveTaskBudget(forgeDir, 'quick');
    fs.writeFileSync(
      path.join(forgeDir, 'token-ledger.json'),
      JSON.stringify({
        total: quickBudget,
        iterations: 1,
        per_spec: {},
        tasks: {
          T_gate: { tokens: quickBudget, depth: 'quick', budget: quickBudget,
                    started_at: '2026-04-28T00:00:00Z', last_update: '2026-04-28T00:00:00Z' }
        }
      })
    );

    // checkTaskBudget reads the v1 ledger and computes the gate. After T003
    // it migrates the in-memory shape but the percentage MUST equal 100.
    const status = checkTaskBudget('T_gate', forgeDir);
    assert.strictEqual(status.used, quickBudget);
    assert.strictEqual(status.budget, quickBudget);
    assert.strictEqual(status.remaining, 0);
    assert.strictEqual(status.percentage, 100,
      'hard 100% gate must report exactly 100% on a v1 ledger at budget');

    // Drive an explicit upgrade and re-check; the gate must still report 100%.
    budget.upgradeLedger(forgeDir);
    const post = checkTaskBudget('T_gate', forgeDir);
    assert.strictEqual(post.percentage, 100,
      'hard 100% gate must still report 100% AFTER explicit migration');
    assert.strictEqual(post.used, quickBudget);
    assert.strictEqual(post.budget, quickBudget);
  });

  test('regression: 80% warning threshold also unchanged after migration', () => {
    const { forgeDir } = makeTempForgeDir();
    const standardBudget = resolveTaskBudget(forgeDir, 'standard');
    const eightyPct = Math.floor(standardBudget * 0.8);
    fs.writeFileSync(
      path.join(forgeDir, 'token-ledger.json'),
      JSON.stringify({
        total: eightyPct, iterations: 1, per_spec: {},
        tasks: { T_warn: { tokens: eightyPct, depth: 'standard', budget: standardBudget } }
      })
    );
    budget.upgradeLedger(forgeDir);
    const status = checkTaskBudget('T_warn', forgeDir);
    // 80% bucket: used should be in the [80, 100) range used by record-task-tokens.
    assert.ok(status.percentage >= 79.9 && status.percentage < 100,
      `expected ~80%, got ${status.percentage}`);
  });
});

runTests();
