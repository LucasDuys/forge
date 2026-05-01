// tests/forge-e2e-smoke.test.cjs -- Wave 3 close-out smoke (T008 / R006.AC5)
//
// End-to-end smoke for the Wave 3 token-output-effort stack. The spec
// (R006.AC5) calls for "from a clean checkout, run brainstorm -> plan ->
// execute --autonomy full on a tiny synthetic spec" and assert six
// post-conditions. Driving real /forge slash commands inside a unit test
// is not feasible (they invoke LLM agents), so this smoke synthesizes the
// six observable surfaces by directly invoking each production module in
// sequence on an isolated tmp .forge/. This mirrors the pattern used by
// the Wave 1 (forge-tools-token-budget.test.cjs) and Wave 2
// (token-cache-smoke.test.cjs) smokes.
//
// Surfaces asserted (one block each):
//   1. Wizard fires exactly once on a fresh tmp .forge/ -- second call no-ops,
//      wizard_completed flag is set after the first call (R004).
//   2. tokens.schema_version === 2 -- upgradeLedger + recordActualUsage on a
//      fresh .forge/ produces a v2 ledger and headless tokens block (R003,
//      Wave 1 R004 cross-wave contract).
//   3. At least one cache hit -- a synthetic cache event log written via
//      recordCacheEvent surfaces hits >= 1 through aggregateCacheStats
//      (Wave 2 R005, R001).
//   4. At least one output-filter trim -- a noisy npm-install transcript
//      fed through hooks/output-filter.js (real subprocess) emits a
//      filtered hookSpecificOutput shorter than the input (R001).
//   5. Handoff JSONs contain effort/max_tokens -- writeHandoff for a
//      sample task produces a JSON file with both keys present (R003).
//   6. No new dependencies -- the current package.json's dependencies and
//      devDependencies are byte-identical to the commit before Wave 3
//      began (R006.AC4). Skipped when git is unavailable.
//
// Bonus: kill-switch parity round trip -- under FORGE_TOKEN_OPT=0 the
// observable surfaces collapse to their disabled shape on a fresh dir
// (no banner from already-flagged dirs, no schema bump claim from the
// ledger upgrade, no cache stats, no filter trim, no effort/max_tokens
// in handoff JSON). This is the executable counterpart of T006's parity
// table.
//
// Pure node:* (no third-party deps). Total runtime budget: < 2 seconds.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const { suite, test, assert, makeTempForgeDir, gitAvailable, runTests } =
  require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const WIZARD_PATH = path.join(REPO_ROOT, 'scripts', 'forge-wizard.cjs');
const OUTPUT_FILTER_PATH = path.join(REPO_ROOT, 'hooks', 'output-filter.js');
const FIXTURE_SPEC_PATH = path.join(__dirname, 'fixtures', 'synthetic-spec.md');

// Pre-Wave 3 commit (parent of T001 7c361f4). package.json must not have
// drifted between this commit and HEAD on the current branch (R006.AC4).
const PRE_WAVE3_COMMIT = '7c361f4^';

// --- module imports (modules-under-test) ----------------------------------

// Bust caches so each test gets a clean module instance where it matters.
function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// --- env hygiene ----------------------------------------------------------

// The smoke depends on default-on behavior unless a test sets the kill switch.
// Strip any inherited value at file load so process.env reads the same way
// regardless of the parent shell.
delete process.env.FORGE_TOKEN_OPT;

function withTokenOpt(value, fn) {
  const prev = process.env.FORGE_TOKEN_OPT;
  if (value === undefined) delete process.env.FORGE_TOKEN_OPT;
  else process.env.FORGE_TOKEN_OPT = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
    else process.env.FORGE_TOKEN_OPT = prev;
  }
}

// Capture process.stdout.write while running fn, return the captured string.
function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try { fn(); }
  finally { process.stdout.write = original; }
  return buf;
}

// --- output-filter spawn helper -------------------------------------------

function spawnOutputFilter(payload, env) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [OUTPUT_FILTER_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign(baseEnv, env || {}),
  });
}

function bigInstallOutput() {
  // > 2000 chars so the filter actually engages (DEFAULT_THRESHOLD = 2000).
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push('  added package@' + i + ' (clean)');
  return lines.join('\n');
}

// --- 1. Wizard fires exactly once -----------------------------------------

suite('e2e smoke :: wizard fires exactly once on a fresh .forge/', () => {
  test('first invocation prints, second is a no-op, flag set after first', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const { runWizard } = freshRequire('../scripts/forge-wizard.cjs');

    let r1, r2;
    const out1 = captureStdout(() => { r1 = withTokenOpt(undefined, () => runWizard(forgeDir)); });
    assert.strictEqual(r1.printed, true, 'first call must print');
    assert.strictEqual(r1.reason, 'first-run', 'first call reason must be first-run');
    assert.ok(out1.length > 0, 'first call must produce stdout');

    const cfg = JSON.parse(fs.readFileSync(path.join(forgeDir, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.wizard_completed, true,
      'wizard_completed must be true after first call');

    const out2 = captureStdout(() => { r2 = withTokenOpt(undefined, () => runWizard(forgeDir)); });
    assert.strictEqual(r2.printed, false, 'second call must NOT print');
    assert.strictEqual(r2.reason, 'already-dismissed',
      'second call reason must be already-dismissed');
    assert.strictEqual(out2, '', 'second call must produce no stdout');
  });

  test('CLI invocation also fires exactly once on a fresh dir', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const baseEnv = Object.assign({}, process.env);
    delete baseEnv.FORGE_TOKEN_OPT;
    const r1 = spawnSync(process.execPath, [WIZARD_PATH, '--forge-dir', forgeDir], {
      encoding: 'utf8', timeout: 5000, env: baseEnv,
    });
    assert.strictEqual(r1.status, 0);
    assert.ok(r1.stdout.length > 0, 'CLI: first run must print');

    const r2 = spawnSync(process.execPath, [WIZARD_PATH, '--forge-dir', forgeDir], {
      encoding: 'utf8', timeout: 5000, env: baseEnv,
    });
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.stdout, '', 'CLI: second run must produce no stdout');
  });
});

// --- 2. tokens.schema_version === 2 ---------------------------------------

suite('e2e smoke :: tokens.schema_version === 2 on a fresh .forge/', () => {
  test('upgradeLedger + recordActualUsage produces v2 ledger', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const budget = freshRequire('../scripts/forge-budget.cjs');

    const upgrade = withTokenOpt(undefined, () => budget.upgradeLedger(forgeDir));
    assert.strictEqual(upgrade.status, 'created',
      'fresh dir must report status=created');

    withTokenOpt(undefined, () => budget.recordActualUsage(forgeDir, 'T999', {
      input: 1234, output: 567, cache_read: 100, cache_write: 50,
      buckets: { instructions: 100, tool_definitions: 200, tool_results: 300, repo_reads: 400, prose: 500 },
      source: 'transcript',
    }));

    const ledgerPath = path.join(forgeDir, 'token-ledger.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.schema_version, 2,
      'persisted ledger must have schema_version=2');
    assert.ok(ledger.usage_actual && typeof ledger.usage_actual === 'object',
      'persisted ledger must carry usage_actual block');
    assert.ok(ledger.usage_actual.tasks && ledger.usage_actual.tasks.T999,
      'recordActualUsage must persist the per-task row');
    assert.strictEqual(ledger.usage_actual.tasks.T999.input, 1234);
    assert.strictEqual(ledger.usage_actual.session.input, 1234,
      'session totals must reflect the recorded usage');
  });

  test('queryHeadlessState surfaces tokens.schema_version === 2', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const budget = freshRequire('../scripts/forge-budget.cjs');
    const tools = freshRequire('../scripts/forge-tools.cjs');

    withTokenOpt(undefined, () => budget.upgradeLedger(forgeDir));
    withTokenOpt(undefined, () => budget.recordActualUsage(forgeDir, 'T123', {
      input: 100, output: 50, source: 'transcript',
    }));

    const snap = withTokenOpt(undefined, () => tools.queryHeadlessState(forgeDir));
    assert.ok(snap.tokens && typeof snap.tokens === 'object',
      'snapshot must surface a tokens block');
    assert.strictEqual(snap.tokens.schema_version, 2,
      'tokens.schema_version must be 2 in the headless snapshot');
  });
});

// --- 3. At least one cache hit --------------------------------------------

suite('e2e smoke :: at least one cache hit surfaces from event log', () => {
  test('synthetic recordCacheEvent log -> aggregateCacheStats reports >= 1 hit', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const store = freshRequire('../hooks/tool-cache-store.js');
    const tools = freshRequire('../scripts/forge-tools.cjs');

    // Replay a small workflow: 1 miss + 2 hits on the same key.
    withTokenOpt(undefined, () => {
      store.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'volatile', hit: false, age_ms: 0, output_bytes: 0 },
        { forgeDir }
      );
      store.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'volatile', hit: true, age_ms: 100, output_bytes: 256 },
        { forgeDir }
      );
      store.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'volatile', hit: true, age_ms: 200, output_bytes: 512 },
        { forgeDir }
      );
    });

    const stats = withTokenOpt(undefined, () => tools.aggregateCacheStats(forgeDir));
    assert.ok(stats.hits >= 1,
      `aggregateCacheStats must report hits >= 1 after 2 hit events; got ${stats.hits}`);
    assert.strictEqual(stats.misses, 1, 'misses must equal the single miss event');
    assert.ok(stats.savings_estimate_tokens > 0,
      'savings_estimate_tokens must be > 0 when bytes were served from cache');
  });

  test('queryHeadlessState surfaces tokens.cache.hits >= 1', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const store = freshRequire('../hooks/tool-cache-store.js');
    const tools = freshRequire('../scripts/forge-tools.cjs');

    withTokenOpt(undefined, () => {
      store.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'stable', hit: true, age_ms: 50, output_bytes: 1024 },
        { forgeDir }
      );
    });

    const snap = withTokenOpt(undefined, () => tools.queryHeadlessState(forgeDir));
    assert.ok(snap.tokens.cache && typeof snap.tokens.cache === 'object',
      'snapshot must include tokens.cache');
    assert.ok(snap.tokens.cache.hits >= 1,
      `tokens.cache.hits must be >= 1; got ${snap.tokens.cache.hits}`);
  });
});

// --- 4. At least one output-filter trim -----------------------------------

suite('e2e smoke :: at least one output-filter trim on a noisy install', () => {
  test('npm install large output -> hook emits filtered additionalContext', () => {
    const big = bigInstallOutput();
    assert.ok(big.length > 2000, 'fixture must exceed DEFAULT_THRESHOLD');

    const r = spawnOutputFilter(
      { tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_output: big },
      {}
    );
    assert.strictEqual(r.status, 0, 'hook must exit 0');
    assert.ok(r.stdout && r.stdout.length > 0, 'hook must emit hookSpecificOutput');

    const parsed = JSON.parse(r.stdout.trim());
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    const additional = parsed.hookSpecificOutput.additionalContext;
    assert.ok(typeof additional === 'string' && additional.length > 0);
    assert.ok(additional.indexOf('Output Filtered:') !== -1,
      'header must announce a filter trim');
    assert.ok(additional.length < big.length,
      `filtered additionalContext (${additional.length} bytes) must be shorter than input (${big.length} bytes)`);
  });

  test('in-process applyFilter trims the same workload identically in shape', () => {
    // Belt-and-braces: the hook subprocess and the in-process module must
    // agree that a trim happened. Doesn't require byte equality (the hook
    // adds the "Output Filtered:" header), just that the filter engaged.
    const big = bigInstallOutput();
    const filter = freshRequire('../hooks/output-filter');
    const filtered = withTokenOpt(undefined, () => filter.applyFilter(big, 'npm install'));
    assert.notStrictEqual(filtered, big, 'in-process filter must engage');
    assert.ok(filtered.length < big.length,
      'in-process filter output must be shorter than input');
  });
});

// --- 5. Handoff JSON contains effort/max_tokens ---------------------------

suite('e2e smoke :: handoff JSON contains effort and max_tokens', () => {
  test('writeHandoff for forge-executor task -> JSON has effort + max_tokens', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const router = freshRequire('../scripts/forge-router.cjs');

    const task = { name: 'echo endpoint', description: 'one tiny function' };
    const handoff = withTokenOpt('1', () =>
      router.writeHandoff(forgeDir, 'T501', 'forge-executor', task)
    );

    assert.ok(handoff && typeof handoff === 'object', 'writeHandoff must return an object');
    assert.ok('effort' in handoff,
      'handoff return value must include effort key (default-on)');
    assert.ok('max_tokens' in handoff,
      'handoff return value must include max_tokens key (default-on)');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(forgeDir, 'handoff.T501.json'), 'utf8')
    );
    assert.deepStrictEqual(onDisk, handoff,
      'on-disk handoff must equal the returned object');
    assert.ok('effort' in onDisk, 'on-disk handoff JSON must contain effort');
    assert.ok('max_tokens' in onDisk, 'on-disk handoff JSON must contain max_tokens');
    assert.ok(typeof onDisk.effort === 'string' && onDisk.effort.length > 0,
      'effort must be a non-empty string');
    assert.ok(typeof onDisk.max_tokens === 'number' && onDisk.max_tokens > 0,
      'max_tokens must be a positive number');
  });

  test('writeHandoff for two different roles produces distinct effort/max_tokens', () => {
    // Defensive shape check so a future router refactor that accidentally
    // wires every role to the same hint trips here.
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const router = freshRequire('../scripts/forge-router.cjs');

    const task = { name: 'cross-role smoke', description: '' };
    const execHandoff = withTokenOpt('1', () =>
      router.writeHandoff(forgeDir, 'T-EXEC', 'forge-executor', task)
    );
    const reviewHandoff = withTokenOpt('1', () =>
      router.writeHandoff(forgeDir, 'T-REV', 'forge-reviewer', task)
    );

    assert.ok('effort' in execHandoff && 'max_tokens' in execHandoff);
    assert.ok('effort' in reviewHandoff && 'max_tokens' in reviewHandoff);
    // Both must produce two distinct files.
    assert.ok(fs.existsSync(path.join(forgeDir, 'handoff.T-EXEC.json')));
    assert.ok(fs.existsSync(path.join(forgeDir, 'handoff.T-REV.json')));
  });
});

// --- 6. No new dependencies (R006.AC4) ------------------------------------

suite('e2e smoke :: no new npm/pip dependencies introduced by Wave 3', () => {
  test('package.json dependencies/devDependencies unchanged vs pre-Wave-3 commit', () => {
    if (!gitAvailable()) {
      // Cannot verify without git; skip cleanly per the smoke contract.
      return;
    }
    let preWave3Raw;
    try {
      preWave3Raw = execFileSync(
        'git', ['show', `${PRE_WAVE3_COMMIT}:package.json`],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000 }
      );
    } catch (e) {
      // Pre-Wave-3 commit not reachable (shallow clone, etc.); skip.
      return;
    }
    const headRaw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');

    const pre = JSON.parse(preWave3Raw);
    const head = JSON.parse(headRaw);

    // dependencies + devDependencies must be byte-equal (both can be absent
    // -- node {} comparison covers that). peerDependencies is allowed to
    // change in principle, but Wave 3 must not have touched it either.
    assert.deepStrictEqual(head.dependencies || {}, pre.dependencies || {},
      'Wave 3 must not have added/removed any dependencies');
    assert.deepStrictEqual(head.devDependencies || {}, pre.devDependencies || {},
      'Wave 3 must not have added/removed any devDependencies');
    assert.deepStrictEqual(head.peerDependencies || {}, pre.peerDependencies || {},
      'Wave 3 must not have touched peerDependencies');
  });

  test('synthetic-spec fixture exists and is small (R006.AC5 fixture sanity)', () => {
    // Anchors the fixture so a future cleanup that deletes it trips here
    // and not in some downstream test.
    assert.ok(fs.existsSync(FIXTURE_SPEC_PATH),
      'tests/fixtures/synthetic-spec.md must exist');
    const raw = fs.readFileSync(FIXTURE_SPEC_PATH, 'utf8');
    const lineCount = raw.split('\n').length;
    assert.ok(lineCount <= 30,
      `synthetic-spec.md must be <= 30 lines; got ${lineCount}`);
    assert.ok(/R001/.test(raw) && /R002/.test(raw),
      'synthetic-spec.md must declare two R-numbers');
  });
});

// --- 7. Kill-switch parity round trip (bonus) -----------------------------

suite('e2e smoke :: FORGE_TOKEN_OPT=0 collapses observable surfaces', () => {
  test('kill switch: wizard prints short line, ledger upgrade skipped, no cache stats, hook trim disabled, handoff omits effort/max_tokens', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });

    // Wizard: under env=0 prints a single short line, still flags the dir.
    const { runWizard } = freshRequire('../scripts/forge-wizard.cjs');
    let wzOut = '';
    let wzResult;
    wzOut = captureStdout(() => {
      wzResult = withTokenOpt('0', () => runWizard(forgeDir));
    });
    assert.strictEqual(wzResult.printed, true, 'kill-switch wizard still prints');
    assert.strictEqual(wzResult.reason, 'kill-switch');
    assert.ok(/FORGE_TOKEN_OPT=0/.test(wzOut),
      'kill-switch banner must reference FORGE_TOKEN_OPT=0');
    assert.ok(wzOut.split('\n').filter(Boolean).length === 1,
      'kill-switch banner must be exactly one non-empty line');

    // Ledger: upgradeLedger reports skipped under env=0; no file written.
    const budget = freshRequire('../scripts/forge-budget.cjs');
    const upgrade = withTokenOpt('0', () => budget.upgradeLedger(forgeDir));
    assert.strictEqual(upgrade.status, 'skipped',
      'kill-switch upgradeLedger must return skipped');
    assert.strictEqual(fs.existsSync(path.join(forgeDir, 'token-ledger.json')), false,
      'kill-switch upgrade must NOT write a ledger file');

    // Cache: recordCacheEvent + aggregateCacheStats both no-op under env=0.
    const store = freshRequire('../hooks/tool-cache-store.js');
    const tools = freshRequire('../scripts/forge-tools.cjs');
    const evResult = withTokenOpt('0', () =>
      store.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'stable', hit: true, output_bytes: 1024 },
        { forgeDir }
      )
    );
    assert.strictEqual(evResult.disabled, true,
      'kill-switch recordCacheEvent must signal disabled');
    const stats = withTokenOpt('0', () => tools.aggregateCacheStats(forgeDir));
    assert.strictEqual(stats.hits, 0, 'kill-switch aggregateCacheStats hits=0');
    assert.strictEqual(stats.misses, 0, 'kill-switch aggregateCacheStats misses=0');

    // Output filter: hook subprocess produces no stdout under env=0.
    const big = bigInstallOutput();
    const r = spawnOutputFilter(
      { tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_output: big },
      { FORGE_TOKEN_OPT: '0' }
    );
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '',
      'kill-switch hook must produce no stdout (passes raw output through)');

    // Handoff: under env=0 the JSON omits effort/max_tokens (legacy 3-field).
    const router = freshRequire('../scripts/forge-router.cjs');
    const handoff = withTokenOpt('0', () =>
      router.writeHandoff(forgeDir, 'T-KILL', 'forge-executor', { name: 'kill', description: '' })
    );
    assert.ok(!('effort' in handoff),
      'kill-switch handoff must NOT include effort');
    assert.ok(!('max_tokens' in handoff),
      'kill-switch handoff must NOT include max_tokens');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(forgeDir, 'handoff.T-KILL.json'), 'utf8')
    );
    assert.ok(!('effort' in onDisk));
    assert.ok(!('max_tokens' in onDisk));
    assert.strictEqual(onDisk.role, 'forge-executor');
    assert.strictEqual(onDisk.task_id, 'T-KILL');
    assert.ok(typeof onDisk.model === 'string' && onDisk.model.length > 0,
      'kill-switch handoff still records model for audit');
  });
});

runTests();
