// tests/token-instrumentation-smoke.test.cjs -- Wave 1 smoke (T006 / R006.AC5)
//
// End-to-end-ish smoke test for the token-instrumentation Wave 1 plumbing.
// Does NOT spawn real Agent dispatches. Instead:
//   1. Build a synthetic minimal forge dir (state.md + frontier + spec)
//   2. Seed a v2 token-ledger.json fixture with non-zero buckets
//   3. Call queryHeadlessState(forgeDir) directly (the function exposed by
//      scripts/forge-tools.cjs) -- this exercises forge-budget.loadLedger,
//      buildTokensBlock, and the headless v2 schema bump end-to-end.
//   4. Assert tokens.schema_version === 2 and tokens.buckets.instructions > 0
//   5. Assert tokens.source === "transcript" when fixture session.source is
//      'transcript'; "estimate" otherwise (incl. v1 ledger and FORGE_TOKEN_OPT=0)
//
// This is the brainstorm -> plan -> status flow's machine-readable surface,
// reduced to the queryHeadlessState() boundary that /forge:status --json hits.

const fs = require('node:fs');
const path = require('node:path');

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const { queryHeadlessState } = require('../scripts/forge-tools.cjs');

const LEDGER_FILE = 'token-ledger.json';

// Build a v2 ledger fixture with a populated session block. `source` defaults
// to 'transcript' so the smoke path covers the post-PostToolUse-hook case.
function makeV2LedgerFixture(opts) {
  opts = opts || {};
  const source = opts.source || 'transcript';
  const buckets = Object.assign({
    instructions: 12500,
    tool_definitions: 8400,
    tool_results: 33000,
    repo_reads: 6200,
    prose: 1100,
  }, opts.buckets || {});
  return {
    schema_version: 2,
    total: 61200,
    iterations: 12,
    per_spec: {},
    tasks: {},
    usage_actual: {
      tasks: {
        T001: {
          input: 14000,
          output: 1200,
          cache_read: 0,
          cache_write: 0,
          buckets: Object.assign({}, buckets),
          source,
        },
      },
      session: {
        input: 14000,
        output: 1200,
        cache_read: 0,
        cache_write: 0,
        buckets,
        source,
      },
    },
  };
}

// V1 ledger fixture (pre-T003): no schema_version, no usage_actual block.
function makeV1LedgerFixture() {
  return {
    total: 0,
    iterations: 0,
    per_spec: {
      'token-instrumentation': { estimated: 56000, actual: 0 },
    },
    estimated_total: 56000,
    last_transcript_tokens: 0,
  };
}

// Seed a minimal frontier + spec inside an existing temp forge dir so the
// smoke test exercises the full /forge:status JSON shape, not just the
// tokens block in isolation.
function seedMinimalSpecAndFrontier(forgeDir) {
  const specsDir = path.join(forgeDir, 'specs');
  const plansDir = path.join(forgeDir, 'plans');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  fs.writeFileSync(
    path.join(specsDir, 'spec-smoke.md'),
    [
      '---',
      'spec: smoke',
      'status: approved',
      '---',
      '',
      '# Smoke Spec',
      '',
      '## R001: Smoke',
      '- [ ] AC1: token ledger surfaces in /forge:status --json',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(plansDir, 'spec-smoke-frontier.md'),
    [
      '---',
      'spec: smoke',
      'tasks: 1',
      '---',
      '',
      '# Frontier: smoke',
      '',
      '## Tier 1',
      '',
      '- T001 -- smoke task (R001) -- 5k tokens',
      '',
    ].join('\n')
  );
}

suite('token-instrumentation Wave 1 smoke (R006.AC5)', () => {
  test('queryHeadlessState surfaces tokens.schema_version === 2 and buckets.instructions > 0 on v2 ledger fixture', () => {
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    const fixture = makeV2LedgerFixture({ source: 'transcript' });
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(fixture, null, 2)
    );

    const snap = queryHeadlessState(forgeDir);

    // Top-level v2 surface, regression-bar style.
    assert.strictEqual(snap.schema_version, 2,
      'top-level headless schema_version must be 2 post-T004');
    assert.ok(snap.tokens && typeof snap.tokens === 'object',
      'tokens block missing from headless snapshot');

    // R006.AC5 -- the load-bearing assertion.
    assert.strictEqual(snap.tokens.schema_version, 2,
      'tokens.schema_version must be 2 on a v2 ledger');
    assert.ok(snap.tokens.buckets.instructions > 0,
      `tokens.buckets.instructions must be > 0 on a populated v2 fixture; got ${snap.tokens.buckets.instructions}`);
  });

  test('source === "transcript" when fixture session.source is "transcript"', () => {
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(makeV2LedgerFixture({ source: 'transcript' }), null, 2)
    );

    const snap = queryHeadlessState(forgeDir);
    assert.strictEqual(snap.tokens.source, 'transcript',
      'tokens.source must echo session.source when set to "transcript"');
  });

  test('source === "estimate" when fixture session.source is "estimate"', () => {
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(makeV2LedgerFixture({ source: 'estimate' }), null, 2)
    );

    const snap = queryHeadlessState(forgeDir);
    assert.strictEqual(snap.tokens.source, 'estimate',
      'tokens.source must echo session.source when set to "estimate"');
    // Buckets still hydrated from session even on estimate source.
    assert.ok(snap.tokens.buckets.instructions > 0,
      'estimate-sourced sessions still report bucket counts');
  });

  test('v1 ledger fixture: source === "estimate" and all bucket fields zero', () => {
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(makeV1LedgerFixture(), null, 2)
    );

    const snap = queryHeadlessState(forgeDir);

    // forge-budget.loadLedger auto-migrates v1 to v2 in-memory; the headless
    // snapshot should report schema_version=2 but with zero-filled buckets
    // and source = "estimate" (no transcript was ever captured).
    assert.strictEqual(snap.tokens.schema_version, 2,
      'tokens.schema_version always 2 post-T003 migration');
    assert.strictEqual(snap.tokens.source, 'estimate',
      'v1-migrated ledger reports source=estimate (no captured session)');

    const b = snap.tokens.buckets;
    assert.strictEqual(b.instructions, 0, 'instructions must be 0 on v1');
    assert.strictEqual(b.tool_definitions, 0, 'tool_definitions must be 0 on v1');
    assert.strictEqual(b.tool_results, 0, 'tool_results must be 0 on v1');
    assert.strictEqual(b.repo_reads, 0, 'repo_reads must be 0 on v1');
    assert.strictEqual(b.prose, 0, 'prose must be 0 on v1');

    const a = snap.tokens.actual;
    assert.strictEqual(a.input, 0);
    assert.strictEqual(a.output, 0);
    assert.strictEqual(a.cache_read, 0);
    assert.strictEqual(a.cache_write, 0);
  });

  test('FORGE_TOKEN_OPT=0 env override: source === "estimate" and zero-filled even with v2 fixture on disk', () => {
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(makeV2LedgerFixture({ source: 'transcript' }), null, 2)
    );

    const prev = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const snap = queryHeadlessState(forgeDir);
      assert.strictEqual(snap.tokens.schema_version, 2,
        'schema_version still bumps under FORGE_TOKEN_OPT=0 (code-version)');
      assert.strictEqual(snap.tokens.source, 'estimate',
        'FORGE_TOKEN_OPT=0 reverts to estimate regardless of disk state');
      assert.strictEqual(snap.tokens.buckets.instructions, 0);
      assert.strictEqual(snap.tokens.buckets.tool_definitions, 0);
      assert.strictEqual(snap.tokens.actual.input, 0);
    } finally {
      if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prev;
    }
  });

  test('headless snapshot remains shape-compatible across the v1 -> v2 bump', () => {
    // R004 regression bar: every v1 top-level field is still present after
    // the bump. The smoke test reaffirms this end-to-end with a populated
    // ledger so the assertions cover the hot path, not just an empty dir.
    const V1_FIELDS = [
      'schema_version', 'queried_at', 'phase', 'spec_domain', 'tier',
      'autonomy', 'depth', 'current_task', 'completed_tasks',
      'remaining_tasks', 'token_budget_used', 'token_budget_remaining',
      'tool_count', 'last_error', 'lock_status', 'last_heartbeat',
      'active_checkpoints',
    ];
    const { forgeDir } = makeTempForgeDir();
    seedMinimalSpecAndFrontier(forgeDir);
    fs.writeFileSync(
      path.join(forgeDir, LEDGER_FILE),
      JSON.stringify(makeV2LedgerFixture(), null, 2)
    );

    const snap = queryHeadlessState(forgeDir);
    for (const f of V1_FIELDS) {
      assert.ok(f in snap, `v1 top-level field missing on populated v2 ledger: ${f}`);
    }
    assert.ok('tokens' in snap, 'tokens block missing on populated v2 ledger');
  });
});

runTests();
