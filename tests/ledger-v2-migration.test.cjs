// tests/ledger-v2-migration.test.cjs -- T003 / R003 token-ledger v2 migration
//
// Focused tests on:
//   - v1 -> v2 migration (all v1 fields preserved, new fields added)
//   - idempotency (running upgrade twice has same effect as once)
//   - corrupted JSON read -> fresh v2 stub, no throw, stderr warning
//   - failure-isolated dual-write (actual path failure doesn't block)
//   - FORGE_TOKEN_OPT=0 -> migration skipped, no actual writes

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const budget = require('../scripts/forge-budget.cjs');

const {
  loadLedger,
  upgradeLedger,
  recordActualUsage,
  BUCKET_KEYS,
  LEDGER_FILENAME,
} = budget;

// Capture and silence stderr writes inside a callback so test output stays
// clean and we can assert on the message that would have been printed.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, enc, cb) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    if (typeof enc === 'function') cb = enc;
    if (cb) cb();
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { fn(); }
  finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

// === loadLedger ============================================================

suite('loadLedger', () => {
  test('returns shape-stable empty ledger when file missing', () => {
    const { forgeDir } = makeTempForgeDir();
    const { ledger, was_v1, was_corrupted } = loadLedger(forgeDir);
    assert.strictEqual(was_v1, false);
    assert.strictEqual(was_corrupted, false);
    assert.strictEqual(ledger.schema_version, 2);
    assert.strictEqual(ledger.total, 0);
    assert.strictEqual(ledger.iterations, 0);
    assert.deepStrictEqual(ledger.per_spec, {});
    assert.deepStrictEqual(ledger.tasks, {});
    assert.deepStrictEqual(ledger.usage_actual.tasks, {});
    assert.strictEqual(ledger.usage_actual.session.input, 0);
    assert.strictEqual(ledger.usage_actual.session.source, null);
    for (const k of BUCKET_KEYS) {
      assert.strictEqual(ledger.usage_actual.session.buckets[k], 0);
    }
  });

  test('detects v1 ledger (no schema_version field)', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILENAME),
      JSON.stringify({
        total: 12345,
        iterations: 7,
        per_spec: { auth: 12345 },
        last_transcript_tokens: 999,
        tasks: { T001: { tokens: 500, depth: 'standard', budget: 20000 } },
      })
    );
    const { ledger, was_v1, was_corrupted } = loadLedger(forgeDir);
    assert.strictEqual(was_v1, true);
    assert.strictEqual(was_corrupted, false);
    // schema_version synthesized in memory only.
    assert.strictEqual(ledger.schema_version, 2);
    // v1 data preserved.
    assert.strictEqual(ledger.total, 12345);
    assert.strictEqual(ledger.iterations, 7);
    assert.strictEqual(ledger.per_spec.auth, 12345);
    assert.strictEqual(ledger.last_transcript_tokens, 999);
    assert.strictEqual(ledger.tasks.T001.tokens, 500);
    // usage_actual stub present.
    assert.deepStrictEqual(ledger.usage_actual.tasks, {});
  });

  test('does NOT mutate disk on read of v1 file', () => {
    const { forgeDir } = makeTempForgeDir();
    const ledgerPath = path.join(forgeDir, LEDGER_FILENAME);
    const v1 = { total: 1, iterations: 1, per_spec: {}, tasks: {} };
    fs.writeFileSync(ledgerPath, JSON.stringify(v1));
    loadLedger(forgeDir);
    const onDisk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(typeof onDisk.schema_version, 'undefined',
      'loadLedger must not write to disk');
  });

  test('recognizes already-v2 ledger', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILENAME),
      JSON.stringify({
        schema_version: 2,
        total: 10, iterations: 2, per_spec: {}, tasks: {},
        usage_actual: {
          tasks: {},
          session: { input: 0, output: 0, cache_read: 0, cache_write: 0,
                     buckets: { instructions:0, tool_definitions:0, tool_results:0,
                                repo_reads:0, prose:0 }, source: null }
        }
      })
    );
    const { was_v1, was_corrupted } = loadLedger(forgeDir);
    assert.strictEqual(was_v1, false);
    assert.strictEqual(was_corrupted, false);
  });

  test('handles corrupt JSON: returns fresh stub, marks corrupted, emits stderr warning', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME), '{ this is not json');
    let result;
    const stderr = captureStderr(() => { result = loadLedger(forgeDir); });
    assert.strictEqual(result.was_corrupted, true);
    assert.strictEqual(result.was_v1, false);
    assert.strictEqual(result.ledger.schema_version, 2);
    assert.strictEqual(result.ledger.total, 0);
    assert.deepStrictEqual(result.ledger.usage_actual.tasks, {});
    assert.ok(stderr.includes('corrupt'),
      `expected stderr to mention 'corrupt', got: ${JSON.stringify(stderr)}`);
  });

  test('handles array-shaped JSON (not an object) as corrupt', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME), '[1,2,3]');
    let result;
    captureStderr(() => { result = loadLedger(forgeDir); });
    assert.strictEqual(result.was_corrupted, true);
    assert.strictEqual(result.ledger.schema_version, 2);
  });
});

// === upgradeLedger =========================================================

suite('upgradeLedger', () => {
  test('migrates v1 ledger to v2, preserving every v1 field', () => {
    const { forgeDir } = makeTempForgeDir();
    const v1 = {
      total: 50000,
      iterations: 12,
      avg_per_iteration: 4166,
      per_spec: { auth: 30000, payments: 20000 },
      last_transcript_tokens: 4200,
      tasks: {
        T001: { tokens: 1000, depth: 'quick', budget: 8000 },
        T002: { tokens: 2500, depth: 'standard', budget: 20000 },
      },
    };
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME), JSON.stringify(v1));

    const result = upgradeLedger(forgeDir);
    assert.strictEqual(result.status, 'upgraded');
    assert.strictEqual(result.was_v1, true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
    assert.strictEqual(onDisk.total, 50000);
    assert.strictEqual(onDisk.iterations, 12);
    assert.strictEqual(onDisk.avg_per_iteration, 4166);
    assert.deepStrictEqual(onDisk.per_spec, { auth: 30000, payments: 20000 });
    assert.strictEqual(onDisk.last_transcript_tokens, 4200);
    assert.strictEqual(onDisk.tasks.T001.tokens, 1000);
    assert.strictEqual(onDisk.tasks.T002.tokens, 2500);
    assert.deepStrictEqual(onDisk.usage_actual.tasks, {});
    assert.strictEqual(onDisk.usage_actual.session.source, null);
  });

  test('is a no-op on an already-v2 ledger', () => {
    const { forgeDir } = makeTempForgeDir();
    upgradeLedger(forgeDir); // creates fresh v2
    const before = fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8');
    const beforeMtime = fs.statSync(path.join(forgeDir, LEDGER_FILENAME)).mtimeMs;

    const result = upgradeLedger(forgeDir);
    assert.strictEqual(result.status, 'no-op');

    const after = fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8');
    assert.strictEqual(after, before, 'no-op upgrade must not change file contents');
    void beforeMtime;
  });

  test('idempotent: upgrade twice == upgrade once', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME),
      JSON.stringify({ total: 100, iterations: 1, per_spec: {}, tasks: {} }));
    const r1 = upgradeLedger(forgeDir);
    const after1 = fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8');
    const r2 = upgradeLedger(forgeDir);
    const after2 = fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8');
    assert.strictEqual(r1.status, 'upgraded');
    assert.strictEqual(r2.status, 'no-op');
    assert.strictEqual(after1, after2, 'second upgrade must not modify file');
  });

  test('creates fresh v2 ledger when file does not exist', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(fs.existsSync(path.join(forgeDir, LEDGER_FILENAME)), false);
    const result = upgradeLedger(forgeDir);
    assert.strictEqual(result.status, 'created');
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
  });

  test('replaces corrupt ledger with fresh v2 stub (status=recovered)', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME), 'not even close to json');
    let result;
    captureStderr(() => { result = upgradeLedger(forgeDir); });
    assert.strictEqual(result.status, 'recovered');
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
    assert.strictEqual(onDisk.total, 0);
  });

  test('FORGE_TOKEN_OPT=0 short-circuits migration', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, LEDGER_FILENAME),
      JSON.stringify({ total: 9, iterations: 1, per_spec: {}, tasks: {} }));
    let result;
    withEnv('FORGE_TOKEN_OPT', '0', () => {
      result = upgradeLedger(forgeDir);
    });
    assert.strictEqual(result.status, 'skipped');
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(typeof onDisk.schema_version, 'undefined',
      'opt-out must leave the v1 file untouched');
  });
});

// === recordActualUsage =====================================================

suite('recordActualUsage', () => {
  test('writes a task row with all four token fields and 5 buckets', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = recordActualUsage(forgeDir, 'T100', {
      input: 1000, output: 200, cache_read: 50, cache_write: 25,
      buckets: { instructions: 100, tool_definitions: 200, tool_results: 300,
                 repo_reads: 400, prose: 0 },
      source: 'transcript',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'written');
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2);
    const row = onDisk.usage_actual.tasks.T100;
    assert.strictEqual(row.input, 1000);
    assert.strictEqual(row.output, 200);
    assert.strictEqual(row.cache_read, 50);
    assert.strictEqual(row.cache_write, 25);
    assert.strictEqual(row.source, 'transcript');
    // EXACT bucket field names per R003 + T002 contract.
    for (const k of BUCKET_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(row.buckets, k),
        `bucket ${k} missing`);
    }
    assert.strictEqual(row.buckets.instructions, 100);
    assert.strictEqual(row.buckets.tool_definitions, 200);
    assert.strictEqual(row.buckets.tool_results, 300);
    assert.strictEqual(row.buckets.repo_reads, 400);
    assert.strictEqual(row.buckets.prose, 0);
    // Session totals match the single task row.
    assert.strictEqual(onDisk.usage_actual.session.input, 1000);
    assert.strictEqual(onDisk.usage_actual.session.source, 'transcript');
  });

  test('accumulates repeat writes for same task', () => {
    const { forgeDir } = makeTempForgeDir();
    recordActualUsage(forgeDir, 'T200', {
      input: 100, output: 10, cache_read: 0, cache_write: 0,
      buckets: { instructions: 50, tool_definitions: 0, tool_results: 0,
                 repo_reads: 50, prose: 0 },
      source: 'estimate',
    });
    recordActualUsage(forgeDir, 'T200', {
      input: 200, output: 20, cache_read: 5, cache_write: 0,
      buckets: { instructions: 100, tool_definitions: 0, tool_results: 0,
                 repo_reads: 100, prose: 0 },
      source: 'transcript',
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    const row = onDisk.usage_actual.tasks.T200;
    assert.strictEqual(row.input, 300);
    assert.strictEqual(row.output, 30);
    assert.strictEqual(row.cache_read, 5);
    assert.strictEqual(row.buckets.instructions, 150);
    assert.strictEqual(row.buckets.repo_reads, 150);
    // "transcript" wins over "estimate" once we've ever seen a transcript.
    assert.strictEqual(row.source, 'transcript');
  });

  test('aggregates session across multiple tasks', () => {
    const { forgeDir } = makeTempForgeDir();
    recordActualUsage(forgeDir, 'T300', {
      input: 100, output: 10, buckets: { instructions: 100, tool_definitions: 0,
        tool_results: 0, repo_reads: 0, prose: 0 }, source: 'estimate' });
    recordActualUsage(forgeDir, 'T301', {
      input: 200, output: 20, buckets: { instructions: 0, tool_definitions: 200,
        tool_results: 0, repo_reads: 0, prose: 0 }, source: 'estimate' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    assert.strictEqual(onDisk.usage_actual.session.input, 300);
    assert.strictEqual(onDisk.usage_actual.session.output, 30);
    assert.strictEqual(onDisk.usage_actual.session.buckets.instructions, 100);
    assert.strictEqual(onDisk.usage_actual.session.buckets.tool_definitions, 200);
    assert.strictEqual(onDisk.usage_actual.session.source, 'estimate');
  });

  test('FORGE_TOKEN_OPT=0 -> recordActualUsage is a no-op (skipped)', () => {
    const { forgeDir } = makeTempForgeDir();
    let result;
    withEnv('FORGE_TOKEN_OPT', '0', () => {
      result = recordActualUsage(forgeDir, 'T400', {
        input: 999, output: 99, buckets: { instructions: 999, tool_definitions: 0,
          tool_results: 0, repo_reads: 0, prose: 0 }, source: 'transcript' });
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'skipped');
    // No ledger file should have been written by the actual-write path.
    assert.strictEqual(fs.existsSync(path.join(forgeDir, LEDGER_FILENAME)), false,
      'opt-out must not write the ledger');
  });

  test('failure isolation: write error returns failed without throwing', () => {
    const { forgeDir } = makeTempForgeDir();
    // Make the ledger path point at a FILE that already exists where we want
    // a directory -- writing temp file inside .forge/ will succeed, but we
    // can simulate failure by stubbing fs.renameSync. Use a guard.
    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated disk full'); };
    let result;
    captureStderr(() => {
      result = recordActualUsage(forgeDir, 'T500', {
        input: 1, output: 1, buckets: { instructions: 1, tool_definitions: 0,
          tool_results: 0, repo_reads: 0, prose: 0 }, source: 'estimate' });
    });
    fs.renameSync = realRename;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'failed');
    // Critically: it returned, did not throw.
  });

  test('rejects missing taskId without throwing', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = recordActualUsage(forgeDir, '', { input: 1, output: 0 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.reason, 'missing_task_id');
  });

  test('coerces non-numeric token fields to 0 (defensive parse)', () => {
    const { forgeDir } = makeTempForgeDir();
    recordActualUsage(forgeDir, 'T600', {
      input: 'banana', output: null, cache_read: undefined,
      buckets: { instructions: 'oops', tool_definitions: 5,
                 tool_results: NaN, repo_reads: 'x', prose: 7 },
      source: 'estimate',
    });
    const onDisk = JSON.parse(fs.readFileSync(path.join(forgeDir, LEDGER_FILENAME), 'utf8'));
    const row = onDisk.usage_actual.tasks.T600;
    assert.strictEqual(row.input, 0);
    assert.strictEqual(row.output, 0);
    assert.strictEqual(row.cache_read, 0);
    assert.strictEqual(row.buckets.instructions, 0);
    assert.strictEqual(row.buckets.tool_definitions, 5);
    assert.strictEqual(row.buckets.tool_results, 0);
    assert.strictEqual(row.buckets.repo_reads, 0);
    assert.strictEqual(row.buckets.prose, 7);
  });
});

// === Dual-write isolation contract =========================================

suite('dual-write isolation (estimate path independent of actual path)', () => {
  test('estimate write succeeds even if actual-write fails (failure isolated)', () => {
    const { forgeDir } = makeTempForgeDir();
    const tools = require('../scripts/forge-tools.cjs');
    // 1) Estimate path (v1 behavior) lands first and successfully.
    tools.registerTask('T700', 'standard', forgeDir);
    tools.recordTaskTokens('T700', 5000, forgeDir);

    // Snapshot the on-disk ledger; this is what the estimate path produced.
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');
    const beforeFail = fs.readFileSync(ledgerPath, 'utf8');
    const beforeJson = JSON.parse(beforeFail);
    assert.strictEqual(beforeJson.tasks.T700.tokens, 5000);

    // 2) Actual-write fails (simulated disk full). Failure must be swallowed
    //    and the previously-written estimate state must remain on disk.
    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated disk full'); };
    let result;
    captureStderr(() => {
      result = recordActualUsage(forgeDir, 'T700', {
        input: 100, output: 10, buckets: { instructions: 100, tool_definitions: 0,
          tool_results: 0, repo_reads: 0, prose: 0 }, source: 'estimate' });
    });
    fs.renameSync = realRename;
    assert.strictEqual(result.ok, false, 'recordActualUsage must report failure');
    assert.strictEqual(result.status, 'failed');

    // Estimate-path data is intact -- the on-disk ledger is byte-identical
    // to what the estimate path wrote before the actual-write failure.
    const afterFail = fs.readFileSync(ledgerPath, 'utf8');
    assert.strictEqual(afterFail, beforeFail,
      'on-disk ledger must be untouched when the actual-write path fails');
    const status = tools.checkTaskBudget('T700', forgeDir);
    assert.strictEqual(status.used, 5000);
    assert.strictEqual(status.registered, true);
  });
});

runTests();
