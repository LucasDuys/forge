// tests/status-tokens.test.cjs -- T004 / R004
//
// Focused tests for the additive top-level `tokens` block on the headless
// status JSON, the schema_version 1 -> 2 bump, the v1-ledger zero-fill path,
// the FORGE_TOKEN_OPT=0 short-circuit, the perf budget, and JSON validity.

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { queryHeadlessState, buildTokensBlock, HEADLESS_STATUS_SCHEMA_VERSION } = tools;

// The 17 v1 fields of the headless query. Listed verbatim so a regression
// (rename, removal, type change) trips this snapshot before merging.
const V1_FIELDS = Object.freeze([
  'schema_version',
  'queried_at',
  'phase',
  'spec_domain',
  'tier',
  'autonomy',
  'depth',
  'current_task',
  'completed_tasks',
  'remaining_tasks',
  'token_budget_used',
  'token_budget_remaining',
  'tool_count',
  'last_error',
  'lock_status',
  'last_heartbeat',
  'active_checkpoints',
]);

function writeLedger(forgeDir, body) {
  fs.writeFileSync(path.join(forgeDir, 'token-ledger.json'), JSON.stringify(body, null, 2));
}

function v2LedgerWithSession(extra) {
  return Object.assign({
    schema_version: 2,
    total: 0,
    iterations: 0,
    per_spec: {},
    last_transcript_tokens: 0,
    tasks: {},
    usage_actual: {
      tasks: {},
      session: {
        input: 1234,
        output: 567,
        cache_read: 89,
        cache_write: 12,
        buckets: {
          instructions: 100,
          tool_definitions: 200,
          tool_results: 300,
          repo_reads: 400,
          prose: 500,
        },
        source: 'transcript',
      },
    },
  }, extra || {});
}

suite('status tokens block — shape and constants', () => {
  test('HEADLESS_STATUS_SCHEMA_VERSION exported as 2 (post-T004 bump)', () => {
    assert.strictEqual(HEADLESS_STATUS_SCHEMA_VERSION, 2);
  });

  test('queryHeadlessState exposes top-level tokens key', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    assert.ok('tokens' in snap, 'tokens key missing from headless snapshot');
    assert.strictEqual(typeof snap.tokens, 'object');
    assert.notStrictEqual(snap.tokens, null);
  });

  test('top-level schema_version === 2 in headless snapshot', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    assert.strictEqual(snap.schema_version, 2);
  });

  test('tokens block carries inner schema_version: 2', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    assert.strictEqual(snap.tokens.schema_version, 2);
  });

  test('all 17 v1 fields preserved alongside additive tokens key', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    for (const f of V1_FIELDS) {
      assert.ok(f in snap, `v1 field missing: ${f}`);
    }
    // 17 v1 + 1 additive (tokens) = 18 top-level keys.
    assert.strictEqual(Object.keys(snap).length, 18, 'unexpected top-level key count');
  });

  test('tokens.actual has the four documented numeric fields', () => {
    const { forgeDir } = makeTempForgeDir();
    const t = queryHeadlessState(forgeDir).tokens;
    for (const k of ['input', 'output', 'cache_read', 'cache_write']) {
      assert.ok(k in t.actual, `actual.${k} missing`);
      assert.strictEqual(typeof t.actual[k], 'number');
    }
  });

  test('tokens.buckets has the five bucket keys', () => {
    const { forgeDir } = makeTempForgeDir();
    const t = queryHeadlessState(forgeDir).tokens;
    for (const k of ['instructions', 'tool_definitions', 'tool_results', 'repo_reads', 'prose']) {
      assert.ok(k in t.buckets, `buckets.${k} missing`);
      assert.strictEqual(typeof t.buckets[k], 'number');
    }
  });

  test('tokens.cache.{hits, misses, savings_estimate_tokens} all 0 in wave 1 (stubs)', () => {
    const { forgeDir } = makeTempForgeDir();
    // Even with a v2 ledger that has session data, cache fields stay 0 in
    // Wave 1 — Wave 2 / R005 wires real cache accounting.
    writeLedger(forgeDir, v2LedgerWithSession());
    const t = queryHeadlessState(forgeDir).tokens;
    assert.strictEqual(t.cache.hits, 0);
    assert.strictEqual(t.cache.misses, 0);
    assert.strictEqual(t.cache.savings_estimate_tokens, 0);
  });

  test('tokens.source is one of "transcript" | "estimate"', () => {
    const { forgeDir } = makeTempForgeDir();
    const src = queryHeadlessState(forgeDir).tokens.source;
    assert.ok(src === 'transcript' || src === 'estimate', 'unexpected source: ' + src);
  });
});

suite('status tokens block — v1 ledger zero-fill', () => {
  test('v1 ledger (no usage_actual block) -> zeroed actual + source: "estimate"', () => {
    const { forgeDir } = makeTempForgeDir();
    // V1 shape: no schema_version, no usage_actual.
    writeLedger(forgeDir, { total: 5000, iterations: 12, per_spec: { auth: 5000 }, tasks: {} });
    const t = queryHeadlessState(forgeDir).tokens;
    assert.strictEqual(t.source, 'estimate');
    assert.strictEqual(t.actual.input, 0);
    assert.strictEqual(t.actual.output, 0);
    assert.strictEqual(t.actual.cache_read, 0);
    assert.strictEqual(t.actual.cache_write, 0);
    for (const k of Object.keys(t.buckets)) {
      assert.strictEqual(t.buckets[k], 0, `bucket ${k} should be zero on v1 ledger`);
    }
  });

  test('no ledger file at all -> zeroed actual + source: "estimate"', () => {
    const { forgeDir } = makeTempForgeDir();
    const t = queryHeadlessState(forgeDir).tokens;
    assert.strictEqual(t.source, 'estimate');
    assert.strictEqual(t.actual.input, 0);
  });

  test('v2 ledger with full session data -> hydrated values + source: "transcript"', () => {
    const { forgeDir } = makeTempForgeDir();
    writeLedger(forgeDir, v2LedgerWithSession());
    const t = queryHeadlessState(forgeDir).tokens;
    assert.strictEqual(t.source, 'transcript');
    assert.strictEqual(t.actual.input, 1234);
    assert.strictEqual(t.actual.output, 567);
    assert.strictEqual(t.actual.cache_read, 89);
    assert.strictEqual(t.actual.cache_write, 12);
    assert.strictEqual(t.buckets.instructions, 100);
    assert.strictEqual(t.buckets.tool_definitions, 200);
    assert.strictEqual(t.buckets.tool_results, 300);
    assert.strictEqual(t.buckets.repo_reads, 400);
    assert.strictEqual(t.buckets.prose, 500);
  });

  test('v2 ledger with session.source !== "transcript" -> source coerces to "estimate"', () => {
    const { forgeDir } = makeTempForgeDir();
    const led = v2LedgerWithSession();
    led.usage_actual.session.source = null;
    writeLedger(forgeDir, led);
    assert.strictEqual(queryHeadlessState(forgeDir).tokens.source, 'estimate');
  });

  test('corrupt ledger does not throw -> defensive zero-fill', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, 'token-ledger.json'), '{not valid json');
    let snap;
    assert.doesNotThrow(() => { snap = queryHeadlessState(forgeDir); });
    assert.strictEqual(snap.tokens.source, 'estimate');
    assert.strictEqual(snap.tokens.actual.input, 0);
  });
});

suite('status tokens block — FORGE_TOKEN_OPT=0', () => {
  test('opt-out: tokens block still emitted but actual+buckets zeroed, schema_version still 2', () => {
    const { forgeDir } = makeTempForgeDir();
    // Seed a fully-populated v2 ledger so a non-opt-out call would hydrate.
    writeLedger(forgeDir, v2LedgerWithSession());
    const prev = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const snap = queryHeadlessState(forgeDir);
      assert.strictEqual(snap.schema_version, 2, 'schema_version still bumps under opt-out');
      assert.ok('tokens' in snap, 'tokens block still emitted under opt-out');
      assert.strictEqual(snap.tokens.schema_version, 2);
      assert.strictEqual(snap.tokens.source, 'estimate');
      assert.strictEqual(snap.tokens.actual.input, 0);
      assert.strictEqual(snap.tokens.actual.output, 0);
      assert.strictEqual(snap.tokens.actual.cache_read, 0);
      assert.strictEqual(snap.tokens.actual.cache_write, 0);
      for (const k of Object.keys(snap.tokens.buckets)) {
        assert.strictEqual(snap.tokens.buckets[k], 0, `bucket ${k} zero under opt-out`);
      }
    } finally {
      if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prev;
    }
  });
});

suite('status tokens block — JSON validity and consumer compat', () => {
  test('snapshot round-trips cleanly through JSON.parse(JSON.stringify(...))', () => {
    const { forgeDir } = makeTempForgeDir();
    writeLedger(forgeDir, v2LedgerWithSession());
    const snap = queryHeadlessState(forgeDir);
    const round = JSON.parse(JSON.stringify(snap));
    assert.deepStrictEqual(round, snap);
  });

  test('consumer expecting schema_version === 2 reads the bumped value correctly', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    // Simulate a consumer guarding on the version before reading tokens.*.
    const versionOk = (snap.schema_version === 2);
    assert.ok(versionOk, 'schema_version should equal 2 (number) post-T004 bump');
    if (versionOk) {
      assert.strictEqual(typeof snap.tokens, 'object');
    }
  });

  test('v1-only consumer reading the original 9 fields keeps working', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    // Original T011 nine fields, per references/headless-status-schema.md.
    const original9 = [
      'phase', 'current_task', 'completed_tasks', 'remaining_tasks',
      'token_budget_used', 'token_budget_remaining',
      'last_error', 'lock_status', 'active_checkpoints',
    ];
    for (const f of original9) {
      assert.ok(f in snap, `original field ${f} missing — back-compat broken`);
    }
  });
});

suite('status tokens block — perf budget < 5ms on 1000-task ledger', () => {
  test('queryHeadlessState completes in under 5ms on synthetic 1000-task v2 ledger', () => {
    const { forgeDir } = makeTempForgeDir();
    const led = v2LedgerWithSession();
    led.tasks = {};
    led.usage_actual.tasks = {};
    for (let i = 0; i < 1000; i++) {
      const id = 'T' + String(i).padStart(4, '0');
      led.tasks[id] = { tokens_used: 100, model: 'sonnet', depth: 'standard' };
      led.usage_actual.tasks[id] = {
        input: 10, output: 5, cache_read: 1, cache_write: 0,
        buckets: { instructions: 1, tool_definitions: 1, tool_results: 1, repo_reads: 1, prose: 1 },
        source: 'transcript',
      };
    }
    writeLedger(forgeDir, led);

    // Warm-up to avoid JIT/fs-cache noise on the timed calls.
    for (let i = 0; i < 5; i++) queryHeadlessState(forgeDir);

    // Take the best of many samples — we measure steady-state perf, not
    // worst-case OS contention. Under the parallel test runner on Windows,
    // single-sample timings can spike due to AV scans / disk contention even
    // when the in-process work is well under budget. Best-of-N filters that.
    const N = 25;
    const samples = [];
    for (let i = 0; i < N; i++) {
      const start = process.hrtime.bigint();
      const snap = queryHeadlessState(forgeDir);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      samples.push(ms);
      assert.ok(snap && snap.tokens, 'snapshot must contain tokens block');
    }
    const best = Math.min(...samples);
    assert.ok(
      best < 5,
      `perf: best of ${N} samples was ${best.toFixed(3)}ms (>5ms budget). samples=${samples.map(s => s.toFixed(2)).join(',')}`
    );
  });
});

suite('status tokens block — buildTokensBlock direct API', () => {
  test('buildTokensBlock exported and returns canonical shape on missing forgeDir', () => {
    assert.strictEqual(typeof buildTokensBlock, 'function');
    // Pass a nonexistent path — should still return the canonical shape, not throw.
    const block = buildTokensBlock('/nonexistent/path/that/does/not/exist');
    assert.strictEqual(block.schema_version, 2);
    assert.strictEqual(block.source, 'estimate');
    assert.strictEqual(block.actual.input, 0);
    assert.strictEqual(block.cache.hits, 0);
  });
});

runTests();
