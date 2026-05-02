// tests/forge-token-opt-parity.test.cjs
//
// Wave 3 R005 / T006 -- end-to-end FORGE_TOKEN_OPT=0 parity contract.
//
// This file is the master rollback contract for the THREE-WAVE token
// reduction stack. Wave 2's parity test (tests/tool-cache-kill-switch.test.cjs)
// already covers the cache surface (legacy v1 patterns + flat 120s TTL +
// no mtime keying + no HEAD pinning + no stats log + default-on bias).
// We do NOT duplicate that coverage here -- we reference it.
//
// What THIS file proves under FORGE_TOKEN_OPT=0:
//   1. Router: selectModel returns the legacy 3-field shape
//      `{ model, reasoning, cost_weight }` -- NO `effort`, NO `max_tokens`.
//      buildModelAdvisory still works (calls selectModel internally).
//   2. Handoff: writeHandoff omits `effort` and `max_tokens` from the JSON
//      file it emits at .forge/handoff.<task>.json (legacy-equivalent shape:
//      `{ model, role, task_id }`).
//   3. Output filter: hooks/output-filter.js bypasses every filter class.
//      applyFilter returns the input unchanged. Spawned hook process exits
//      silently with no stdout (so no PostToolUse rewrite leaks downstream).
//   4. Wizard: prints EXACTLY one line ("Forge: ... features disabled"),
//      sets wizard_completed=true, and second invocation is a no-op.
//   5. Budget ledger: upgradeLedger returns {status:"skipped"};
//      recordActualUsage returns {ok:true,status:"skipped",reason:"opt_out"}.
//      No `usage_actual.*` keys are persisted to disk.
//
// Spec mapping:
//   R005.AC1 -- entire token-reduction stack disables under env=0
//   R005.AC2 -- this file IS the harness; passes the assertions above
//
// Style: mirrors tests/tool-cache-kill-switch.test.cjs (env toggling pattern,
// isolated tmp dirs via _helper.cjs, hook spawned as a child process for the
// stdin/stdout contract).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

// Clear inherited FORGE_TOKEN_OPT before requiring modules under test so the
// in-process default-on baseline is the unset case. Each test that needs the
// kill switch sets it in beforeEach and restores in afterEach.
const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const router = require('../scripts/forge-router.cjs');
const budget = require('../scripts/forge-budget.cjs');
const wizard = require('../scripts/forge-wizard.cjs');
const outputFilter = require('../hooks/output-filter.js');

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

// --- shared env-toggle helpers --------------------------------------------

function setKillSwitch() {
  process.env.FORGE_TOKEN_OPT = '0';
}

function clearKillSwitch() {
  delete process.env.FORGE_TOKEN_OPT;
  // Also reset the router's effort-policy cache so cross-test config files
  // do not leak via the memoized override map.
  if (typeof router._resetEffortPolicyCache === 'function') {
    router._resetEffortPolicyCache();
  }
}

// --- spawn the output-filter hook with stdin -------------------------------

function spawnOutputFilterHook(payload, env, cwd) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'output-filter.js');
  // Strip inherited FORGE_TOKEN_OPT so each test gets the exact env it asked
  // for. Mirrors the pattern in tool-cache-kill-switch.test.cjs.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign(baseEnv, env || {}),
  });
}

// --- shared classification fixture (executor / score-ish) ------------------

function makeClassification(score, tier) {
  // selectModel reads .tier.name and .score; supply a minimal viable shape.
  return {
    tier: { name: tier || 'sonnet' },
    score: typeof score === 'number' ? score : 5,
    reasoning: 'parity-fixture score=' + score,
  };
}

// =========================================================================
// R005.AC2 (a) -- Router: 3-field shape under kill switch
// =========================================================================

suite('R005 router selectModel -- 3-field shape under kill switch', () => {

  // Each test owns its env toggle; afterEach restores cleanly.
  function setup() { setKillSwitch(); }
  function teardown() { clearKillSwitch(); }

  test('forge-executor low-score returns {model, reasoning, cost_weight} only', () => {
    setup();
    try {
      const result = router.selectModel(
        'forge-executor',
        makeClassification(2, 'haiku'),
        null,
        { model_routing: { enabled: true } }
      );
      const keys = Object.keys(result).sort();
      assert.deepStrictEqual(keys, ['cost_weight', 'model', 'reasoning'],
        'kill switch must produce exactly 3 keys (no effort, no max_tokens)');
      assert.strictEqual('effort' in result, false, 'no effort key');
      assert.strictEqual('max_tokens' in result, false, 'no max_tokens key');
      assert.strictEqual(typeof result.model, 'string');
      assert.strictEqual(typeof result.cost_weight, 'number');
    } finally { teardown(); }
  });

  test('forge-executor high-score returns 3-field shape (no high-bucket effort leak)', () => {
    setup();
    try {
      const result = router.selectModel(
        'forge-executor',
        makeClassification(12, 'opus'),
        null,
        { model_routing: { enabled: true } }
      );
      assert.strictEqual('effort' in result, false);
      assert.strictEqual('max_tokens' in result, false);
      assert.deepStrictEqual(Object.keys(result).sort(), ['cost_weight', 'model', 'reasoning']);
    } finally { teardown(); }
  });

  test('forge-speccer (high-effort role) still returns 3-field shape', () => {
    // Spec policy: speccer is effort:high, max_tokens:16000. Under kill switch
    // those fields must be absent regardless of role tier.
    setup();
    try {
      const result = router.selectModel(
        'forge-speccer',
        makeClassification(8, 'sonnet'),
        null,
        { model_routing: { enabled: true } }
      );
      assert.strictEqual('effort' in result, false,
        'kill switch overrides per-role effort policy');
      assert.strictEqual('max_tokens' in result, false);
    } finally { teardown(); }
  });

  test('forge-researcher (low-effort role) still returns 3-field shape', () => {
    setup();
    try {
      const result = router.selectModel(
        'forge-researcher',
        makeClassification(2, 'haiku'),
        null,
        { model_routing: { enabled: true } }
      );
      assert.strictEqual('effort' in result, false);
      assert.strictEqual('max_tokens' in result, false);
    } finally { teardown(); }
  });

  test('routing fully disabled under kill switch returns 3-field legacy shape', () => {
    // routing.enabled === false branch goes through _buildLegacyResult, which
    // also has its own FORGE_TOKEN_OPT=0 short-circuit.
    setup();
    try {
      const result = router.selectModel(
        'forge-executor',
        makeClassification(5, 'sonnet'),
        null,
        { model_routing: { enabled: false } }
      );
      assert.strictEqual('effort' in result, false);
      assert.strictEqual('max_tokens' in result, false);
      assert.strictEqual(typeof result.model, 'string');
    } finally { teardown(); }
  });

  test('default-on contrast: env unset returns 5-field shape with effort/max_tokens', () => {
    // Sanity: same inputs, env unset -> wave-3 ON -> effort + max_tokens present.
    clearKillSwitch();
    const result = router.selectModel(
      'forge-executor',
      makeClassification(2, 'haiku'),
      null,
      { model_routing: { enabled: true } }
    );
    assert.strictEqual('effort' in result, true,
      'wave-3 ON must include effort');
    assert.strictEqual('max_tokens' in result, true,
      'wave-3 ON must include max_tokens');
    assert.strictEqual(typeof result.effort, 'string');
    assert.strictEqual(typeof result.max_tokens, 'number');
  });

  test('buildModelAdvisory under kill switch returns the same shape as before R002', () => {
    // buildModelAdvisory reads result.model and works either way; the fact
    // that it does not break under the kill switch is the contract.
    setup();
    try {
      const advisory = router.buildModelAdvisory(
        { name: 'add registration endpoint', description: 'POST /auth/register' },
        'forge-executor',
        { model_routing: { enabled: true } },
        null
      );
      assert.ok(advisory && typeof advisory === 'object');
      assert.strictEqual(typeof advisory.model, 'string');
      assert.ok(advisory.classification);
      assert.ok(typeof advisory.advisory === 'string' && advisory.advisory.length > 0);
    } finally { teardown(); }
  });
});

// =========================================================================
// R005.AC2 (b) -- Handoff: JSON omits effort/max_tokens under kill switch
// =========================================================================

suite('R005 router writeHandoff -- legacy-shape JSON under kill switch', () => {

  test('writeHandoff(env=0) writes {model, role, task_id} ONLY -- no effort, no max_tokens', () => {
    const { forgeDir } = makeTempForgeDir();
    setKillSwitch();
    try {
      const handoff = router.writeHandoff(
        forgeDir,
        'T-PARITY-1',
        'forge-executor',
        { tier: { name: 'haiku' }, score: 2, reasoning: 'fixture' }
      );

      // Returned in-memory object
      const returnedKeys = Object.keys(handoff).sort();
      assert.deepStrictEqual(returnedKeys, ['model', 'role', 'task_id'],
        'returned handoff must have exactly 3 keys under kill switch');
      assert.strictEqual('effort' in handoff, false);
      assert.strictEqual('max_tokens' in handoff, false);
      assert.strictEqual(handoff.role, 'forge-executor');
      assert.strictEqual(handoff.task_id, 'T-PARITY-1');
      assert.strictEqual(typeof handoff.model, 'string');

      // On-disk file
      const handoffPath = path.join(forgeDir, 'handoff.T-PARITY-1.json');
      assert.ok(fs.existsSync(handoffPath), 'handoff JSON file must be written');
      const onDisk = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
      const onDiskKeys = Object.keys(onDisk).sort();
      assert.deepStrictEqual(onDiskKeys, ['model', 'role', 'task_id'],
        'on-disk JSON must also have exactly 3 keys');
      assert.strictEqual('effort' in onDisk, false);
      assert.strictEqual('max_tokens' in onDisk, false);
    } finally {
      clearKillSwitch();
    }
  });

  test('writeHandoff default-on contrast: env unset writes 5-field JSON', () => {
    const { forgeDir } = makeTempForgeDir();
    clearKillSwitch();

    const handoff = router.writeHandoff(
      forgeDir,
      'T-PARITY-2',
      'forge-executor',
      { tier: { name: 'haiku' }, score: 2, reasoning: 'fixture' }
    );

    assert.strictEqual('effort' in handoff, true,
      'wave-3 ON must include effort in handoff');
    assert.strictEqual('max_tokens' in handoff, true,
      'wave-3 ON must include max_tokens in handoff');

    const onDisk = JSON.parse(fs.readFileSync(
      path.join(forgeDir, 'handoff.T-PARITY-2.json'), 'utf8'));
    assert.strictEqual('effort' in onDisk, true);
    assert.strictEqual('max_tokens' in onDisk, true);
  });
});

// =========================================================================
// R005.AC2 (c) -- Output filter: bypass branch returns input unchanged
// =========================================================================

suite('R005 output-filter -- kill switch bypasses every filter class', () => {

  // applyFilter directly: in-process check that the bypass branch returns
  // the input verbatim regardless of which class would otherwise match.

  test('applyFilter(env=0) returns input unchanged for npm install (>2000 chars)', () => {
    setKillSwitch();
    try {
      // Build a >2000-char install output; without kill switch this WOULD
      // be filtered into a head/tail summary.
      const lines = [];
      lines.push('npm install starting');
      for (let i = 0; i < 200; i++) {
        lines.push('added package-' + i + '@1.0.0');
      }
      lines.push('added 200 packages');
      const big = lines.join('\n');
      assert.ok(big.length > 2000, 'fixture sanity: input must exceed threshold');

      const out = outputFilter.applyFilter(big, 'npm install');
      assert.strictEqual(out, big,
        'kill switch must return input identically (no install-filter rewrite)');
    } finally { clearKillSwitch(); }
  });

  test('applyFilter(env=0) returns input unchanged for git diff (>2000 chars)', () => {
    setKillSwitch();
    try {
      const lines = ['diff --git a/file.txt b/file.txt'];
      for (let i = 0; i < 500; i++) lines.push('+ added line ' + i);
      const big = lines.join('\n');
      assert.ok(big.length > 2000);

      const out = outputFilter.applyFilter(big, 'git diff HEAD');
      assert.strictEqual(out, big,
        'kill switch must return input identically (no diff-filter rewrite)');
    } finally { clearKillSwitch(); }
  });

  test('applyFilter(env=0) returns input unchanged for find dump (>2000 chars)', () => {
    setKillSwitch();
    try {
      const lines = [];
      for (let i = 0; i < 200; i++) lines.push('./path/to/file-' + i + '.js');
      const big = lines.join('\n');
      assert.ok(big.length > 2000);

      const out = outputFilter.applyFilter(big, 'find . -name "*.js"');
      assert.strictEqual(out, big);
    } finally { clearKillSwitch(); }
  });

  test('applyFilter default-on contrast: env unset DOES rewrite npm install >2000 chars', () => {
    clearKillSwitch();
    const lines = ['npm install starting'];
    for (let i = 0; i < 200; i++) lines.push('added package-' + i + '@1.0.0');
    lines.push('added 200 packages');
    const big = lines.join('\n');
    assert.ok(big.length > 2000);

    const out = outputFilter.applyFilter(big, 'npm install');
    assert.notStrictEqual(out, big,
      'wave-3 ON must rewrite (sanity for the bypass-vs-rewrite contrast)');
    assert.ok(out.length < big.length,
      'wave-3 ON output must be smaller than input');
  });

  test('hook spawn: env=0 produces NO stdout for a normally-filtered npm install', () => {
    // Spawn the hook process with stdin payload. Under kill switch, applyFilter
    // returns input unchanged, so the hook's `if (filtered === toolOutput)`
    // branch fires and the process exits 0 with empty stdout. The PostToolUse
    // contract is: empty stdout = no rewrite injected into context.
    const lines = ['npm install starting'];
    for (let i = 0; i < 200; i++) lines.push('added package-' + i + '@1.0.0');
    lines.push('added 200 packages');
    const big = lines.join('\n');

    const r = spawnOutputFilterHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_output: big,
      },
      { FORGE_TOKEN_OPT: '0' }
    );
    assert.strictEqual(r.status, 0, 'hook must exit 0 under kill switch');
    assert.strictEqual((r.stdout || '').trim(), '',
      'hook must produce no stdout under kill switch (no rewrite)');
  });

  test('hook spawn default-on contrast: env unset produces stdout rewrite for same input', () => {
    const lines = ['npm install starting'];
    for (let i = 0; i < 200; i++) lines.push('added package-' + i + '@1.0.0');
    lines.push('added 200 packages');
    const big = lines.join('\n');

    const r = spawnOutputFilterHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_output: big,
      },
      {} // env unset
    );
    assert.strictEqual(r.status, 0);
    assert.ok((r.stdout || '').length > 0,
      'wave-3 ON must produce a hookSpecificOutput rewrite for >2000-char npm install');
    // Sanity: the stdout is JSON containing the rewrite.
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.hookSpecificOutput);
    assert.ok(parsed.hookSpecificOutput.additionalContext);
    assert.ok(/Output Filtered/.test(parsed.hookSpecificOutput.additionalContext));
  });
});

// =========================================================================
// R005.AC2 (d) -- Wizard: prints disabled-line, sets flag, no re-fire
// =========================================================================

suite('R005 wizard -- kill-switch disabled-line and idempotence', () => {

  test('first invocation under kill switch prints exactly one line and sets flag', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    // No state.md present -> _isTuiActive returns false. config.json starts
    // at {}, so wizard_completed is absent -> not yet dismissed.

    setKillSwitch();
    // Capture stdout via a write-shim. process.stdout is a singleton; replace
    // the .write method for the duration of the call.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = function (chunk) {
      captured += chunk;
      return true;
    };
    let result;
    try {
      result = wizard.runWizard(forgeDir);
    } finally {
      process.stdout.write = origWrite;
      clearKillSwitch();
    }

    assert.deepStrictEqual(result, { printed: true, reason: 'kill-switch' },
      'kill-switch path must report printed=true, reason=kill-switch');

    // Disabled-line content + length contract.
    assert.strictEqual(typeof captured, 'string');
    assert.ok(captured.length > 0, 'must print something');
    // Must end with exactly one newline.
    assert.strictEqual(captured[captured.length - 1], '\n',
      'captured output must end in newline');
    // Splitting on '\n' yields ['<the line>', ''] -> body has exactly 1 line.
    const lines = captured.split('\n');
    assert.strictEqual(lines.length, 2,
      'captured output must be exactly one line + trailing newline');
    assert.strictEqual(lines[1], '', 'second split element is the empty tail');
    assert.ok(/disabled/i.test(lines[0]),
      'kill-switch line must mention "disabled": ' + JSON.stringify(lines[0]));
    assert.ok(/FORGE_TOKEN_OPT/.test(lines[0]),
      'kill-switch line should reference FORGE_TOKEN_OPT for the user');

    // Flag must be persisted so the next invocation is a no-op.
    const cfgPath = path.join(forgeDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.wizard_completed, true,
      'kill-switch path must set wizard_completed=true');
  });

  test('second invocation under kill switch is a no-op (already-dismissed)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    // Pre-dismiss by writing the flag manually (simulating prior fire).
    fs.writeFileSync(
      path.join(forgeDir, 'config.json'),
      JSON.stringify({ wizard_completed: true })
    );

    setKillSwitch();
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = function (chunk) {
      captured += chunk;
      return true;
    };
    let result;
    try {
      result = wizard.runWizard(forgeDir);
    } finally {
      process.stdout.write = origWrite;
      clearKillSwitch();
    }

    assert.deepStrictEqual(result, { printed: false, reason: 'already-dismissed' },
      'second invocation must report printed=false, reason=already-dismissed');
    assert.strictEqual(captured, '',
      'second invocation must not print anything (kill-switch must not re-fire)');
  });
});

// =========================================================================
// R005.AC2 (e) -- Budget ledger: stays v1-shape under kill switch
// =========================================================================

suite('R005 budget ledger -- no usage_actual.* keys persisted under kill switch', () => {

  test('upgradeLedger(env=0) returns {status:"skipped"} and writes nothing', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');
    assert.strictEqual(fs.existsSync(ledgerPath), false,
      'no token-ledger.json before the call');

    setKillSwitch();
    try {
      const r = budget.upgradeLedger(forgeDir);
      assert.strictEqual(r.status, 'skipped',
        'kill switch must skip migration entirely');
      assert.strictEqual(r.was_v1, false);
      assert.strictEqual(r.was_corrupted, false);
    } finally { clearKillSwitch(); }

    // Critical: no file must be created when the migration is skipped.
    assert.strictEqual(fs.existsSync(ledgerPath), false,
      'kill-switch upgradeLedger must NOT create the ledger file');
  });

  test('upgradeLedger(env=0) on existing v1 ledger preserves v1 shape (no usage_actual on disk)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');

    // Seed an authentic v1 file (no schema_version, no usage_actual).
    const v1Snapshot = {
      total: 12345,
      iterations: 3,
      per_spec: { 'spec-foo': 5000 },
      last_transcript_tokens: 800,
      tasks: { 'T001': { tokens: 2000 } },
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(v1Snapshot, null, 2));
    const beforeText = fs.readFileSync(ledgerPath, 'utf8');

    setKillSwitch();
    try {
      const r = budget.upgradeLedger(forgeDir);
      assert.strictEqual(r.status, 'skipped',
        'kill switch must skip migration on a v1 file');
    } finally { clearKillSwitch(); }

    // The on-disk file must be byte-identical (no migration happened).
    const afterText = fs.readFileSync(ledgerPath, 'utf8');
    assert.strictEqual(afterText, beforeText,
      'kill switch must NOT rewrite an existing v1 ledger');

    // Defensive parse: confirm no usage_actual key snuck in.
    const onDisk = JSON.parse(afterText);
    assert.strictEqual('schema_version' in onDisk, false,
      'no schema_version key may appear on disk');
    assert.strictEqual('usage_actual' in onDisk, false,
      'no usage_actual key may appear on disk');
  });

  test('recordActualUsage(env=0) returns {status:"skipped",reason:"opt_out"} and writes nothing', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');

    setKillSwitch();
    try {
      const r = budget.recordActualUsage(forgeDir, 'T-PARITY-3', {
        input: 100,
        output: 50,
        cache_read: 10,
        cache_write: 5,
        buckets: {
          instructions: 30, tool_definitions: 20, tool_results: 25,
          repo_reads: 10, prose: 15,
        },
        source: 'transcript',
      });
      assert.deepStrictEqual(r, { ok: true, status: 'skipped', reason: 'opt_out' },
        'kill switch must short-circuit recordActualUsage');
    } finally { clearKillSwitch(); }

    assert.strictEqual(fs.existsSync(ledgerPath), false,
      'kill-switch recordActualUsage must NOT create the ledger file');
  });

  test('default-on contrast: recordActualUsage with env unset DOES write usage_actual', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    clearKillSwitch();

    const r = budget.recordActualUsage(forgeDir, 'T-PARITY-4', {
      input: 100, output: 50, cache_read: 10, cache_write: 5,
      buckets: {
        instructions: 30, tool_definitions: 20, tool_results: 25,
        repo_reads: 10, prose: 15,
      },
      source: 'transcript',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'written',
      'wave-1 ON must write to the ledger');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(forgeDir, 'token-ledger.json'), 'utf8'));
    assert.strictEqual(onDisk.schema_version, 2,
      'wave-1 ON must persist schema_version=2');
    assert.ok(onDisk.usage_actual, 'usage_actual block must exist on disk');
    assert.ok(onDisk.usage_actual.tasks['T-PARITY-4'],
      'usage_actual.tasks.<id> must be populated');
  });
});

// =========================================================================
// R005.AC1 -- behavioral parity end-to-end (one test that touches all 4 surfaces)
// =========================================================================

suite('R005 behavioral parity end-to-end', () => {
  test('full surface check under FORGE_TOKEN_OPT=0', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });

    setKillSwitch();
    const origWrite = process.stdout.write.bind(process.stdout);
    let wizardCaptured = '';
    process.stdout.write = function (chunk) {
      wizardCaptured += chunk;
      return true;
    };
    try {
      // 1. Router selectModel -> 3-field shape.
      const sel = router.selectModel(
        'forge-executor',
        makeClassification(2, 'haiku'),
        null,
        { model_routing: { enabled: true } }
      );
      assert.strictEqual('effort' in sel, false, 'no effort under env=0');
      assert.strictEqual('max_tokens' in sel, false, 'no max_tokens under env=0');

      // 2. Router writeHandoff -> 3-field on-disk JSON.
      const handoff = router.writeHandoff(
        forgeDir, 'T-E2E', 'forge-executor',
        { tier: { name: 'haiku' }, score: 2, reasoning: 'fixture' }
      );
      assert.deepStrictEqual(Object.keys(handoff).sort(),
        ['model', 'role', 'task_id']);
      const onDisk = JSON.parse(fs.readFileSync(
        path.join(forgeDir, 'handoff.T-E2E.json'), 'utf8'));
      assert.deepStrictEqual(Object.keys(onDisk).sort(),
        ['model', 'role', 'task_id']);

      // 3. Output-filter applyFilter -> input returned unchanged.
      const lines = ['diff --git a/x b/x'];
      for (let i = 0; i < 500; i++) lines.push('+ added line ' + i);
      const big = lines.join('\n');
      const filtered = outputFilter.applyFilter(big, 'git diff HEAD');
      assert.strictEqual(filtered, big, 'output-filter bypassed under env=0');

      // 4. Wizard prints exactly one disabled line and sets the flag.
      const wResult = wizard.runWizard(forgeDir);
      assert.strictEqual(wResult.printed, true);
      assert.strictEqual(wResult.reason, 'kill-switch');
      const wLines = wizardCaptured.split('\n');
      assert.strictEqual(wLines.length, 2,
        'wizard prints exactly one line under env=0');
      assert.ok(/disabled/i.test(wLines[0]));

      // 5. Budget upgradeLedger + recordActualUsage are skipped, no
      //    usage_actual.* keys land on disk.
      const upR = budget.upgradeLedger(forgeDir);
      assert.strictEqual(upR.status, 'skipped');
      const recR = budget.recordActualUsage(forgeDir, 'T-E2E', {
        input: 1, output: 1, cache_read: 0, cache_write: 0,
        buckets: { instructions: 0, tool_definitions: 0, tool_results: 0,
                   repo_reads: 0, prose: 0 },
        source: 'estimate',
      });
      assert.strictEqual(recR.status, 'skipped');
      assert.strictEqual(
        fs.existsSync(path.join(forgeDir, 'token-ledger.json')),
        false,
        'no token-ledger.json may exist under env=0 after parity flow');
    } finally {
      process.stdout.write = origWrite;
      clearKillSwitch();
    }
  });
});

// Restore the original env var on test runner exit so we never leak state to
// downstream test files in run-tests.cjs's serial executor.
process.on('exit', _restoreOpt);

runTests();
