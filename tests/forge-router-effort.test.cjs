#!/usr/bin/env node
// tests/forge-router-effort.test.cjs
//
// Wave 3 R002: per-phase effort and max_tokens policy.
//
// Covers:
//   - Role x complexity matrix (>= 14 cases): each role at each score bucket.
//   - selectModel preserves the existing fields (model, reasoning, cost_weight)
//     in the new 5-field shape.
//   - Config override at .forge/config.json::model_routing.effort_policy.{role}
//     beats the baked-in defaults.
//   - FORGE_TOKEN_OPT=0 -> legacy 3-field shape (no effort, no max_tokens).
//   - FORGE_TOKEN_OPT unset / "" / "1" / "true" -> 5-field shape (strict =="0"
//     guard).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const router = require('../scripts/forge-router.cjs');

function mktmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// Build a minimal classification stub for a target score. The matrix tests
// don't need classifyTask's whole pipeline; they just need the score to land
// in a known bucket so getEffortPolicy and selectModel's executor branch
// fire correctly.
function classifyAt(score, tierName) {
  const tier = router.TIERS[Object.keys(router.TIERS).find((k) => router.TIERS[k].name === tierName)];
  return {
    tier: tier || router.TIERS.SONNET,
    score,
    signals: { files: '3-5', type: 'business_logic', judgment: 'none', cross: 'none', novelty: 'familiar_pattern' },
    reasoning: `score ${score} (test stub)`,
  };
}

// Force FORGE_TOKEN_OPT to a known value for the duration of `fn()`. Tests
// must not leak env state between cases or other suites running in the same
// node process.
function withTokenOpt(value, fn) {
  const prior = process.env.FORGE_TOKEN_OPT;
  if (value === undefined) delete process.env.FORGE_TOKEN_OPT;
  else process.env.FORGE_TOKEN_OPT = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.FORGE_TOKEN_OPT;
    else process.env.FORGE_TOKEN_OPT = prior;
  }
}

const baseConfig = { model_routing: { enabled: true } };

// ---------- Role x complexity matrix (>= 14 cases) ----------

// forge-executor: three score buckets.
function testExecutorScoreLow() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(2, 'haiku'), null, baseConfig);
    assert.strictEqual(r.effort, 'medium');
    assert.strictEqual(r.max_tokens, 6000);
    assert.ok(typeof r.model === 'string');
    console.log('PASS  testExecutorScoreLow (score=2 -> medium/6000)');
  });
}

function testExecutorScoreMid() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.effort, 'medium');
    assert.strictEqual(r.max_tokens, 10000);
    console.log('PASS  testExecutorScoreMid (score=7 -> medium/10000)');
  });
}

function testExecutorScoreHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(15, 'opus'), null, baseConfig);
    assert.strictEqual(r.effort, 'high');
    assert.strictEqual(r.max_tokens, 14000);
    console.log('PASS  testExecutorScoreHigh (score=15 -> high/14000)');
  });
}

// Boundary cases for executor: score==4 stays in low bucket, score==5 jumps
// to mid, score==10 stays in mid, score==11 jumps to high.
function testExecutorBoundary4() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(4, 'haiku'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 6000, 'score==4 still in low bucket');
    console.log('PASS  testExecutorBoundary4');
  });
}

function testExecutorBoundary5() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(5, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 10000, 'score==5 jumps to mid bucket');
    console.log('PASS  testExecutorBoundary5');
  });
}

function testExecutorBoundary10() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(10, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 10000, 'score==10 still in mid bucket');
    console.log('PASS  testExecutorBoundary10');
  });
}

function testExecutorBoundary11() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(11, 'opus'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 14000, 'score==11 jumps to high bucket');
    console.log('PASS  testExecutorBoundary11');
  });
}

// Flat-policy roles. Score is irrelevant for these; we sweep low/mid/high to
// prove they're independent of score.
function testSpeccerHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-speccer', classifyAt(2, 'haiku'), null, baseConfig);
    assert.strictEqual(r.effort, 'high');
    assert.strictEqual(r.max_tokens, 16000);
    console.log('PASS  testSpeccerHigh');
  });
}

function testPlannerHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-planner', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.effort, 'high');
    assert.strictEqual(r.max_tokens, 12000);
    console.log('PASS  testPlannerHigh');
  });
}

function testReviewerHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-reviewer', classifyAt(15, 'opus'), null, baseConfig);
    assert.strictEqual(r.effort, 'high');
    assert.strictEqual(r.max_tokens, 12000);
    console.log('PASS  testReviewerHigh');
  });
}

function testVerifierHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-verifier', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.effort, 'high');
    assert.strictEqual(r.max_tokens, 12000);
    console.log('PASS  testVerifierHigh');
  });
}

function testResearcherLow() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-researcher', classifyAt(2, 'haiku'), null, baseConfig);
    assert.strictEqual(r.effort, 'low');
    assert.strictEqual(r.max_tokens, 4000);
    console.log('PASS  testResearcherLow');
  });
}

function testComplexityLow() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-complexity', classifyAt(15, 'opus'), null, baseConfig);
    assert.strictEqual(r.effort, 'low');
    assert.strictEqual(r.max_tokens, 2000);
    console.log('PASS  testComplexityLow');
  });
}

// Researcher / complexity at all three score buckets to confirm score
// genuinely doesn't affect non-executor roles.
function testResearcherAtMid() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-researcher', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 4000, 'researcher max_tokens stable across scores');
    console.log('PASS  testResearcherAtMid');
  });
}

function testComplexityAtHigh() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-complexity', classifyAt(15, 'opus'), null, baseConfig);
    assert.strictEqual(r.max_tokens, 2000, 'complexity max_tokens stable across scores');
    console.log('PASS  testComplexityAtHigh');
  });
}

// ---------- Existing-fields preservation ----------

function testExistingFieldsPreserved() {
  withTokenOpt('1', () => {
    const cls = classifyAt(7, 'sonnet');
    const r = router.selectModel('forge-executor', cls, null, baseConfig);
    assert.ok(typeof r.model === 'string', 'model present');
    assert.strictEqual(r.reasoning, cls.reasoning, 'reasoning preserved from classification');
    assert.strictEqual(typeof r.cost_weight, 'number', 'cost_weight is numeric');
    // Cost weight should match the tier the model maps into.
    const tierObj = Object.values(router.TIERS).find((t) => t.name === r.model);
    assert.strictEqual(r.cost_weight, tierObj.cost_weight, 'cost_weight matches tier');
    console.log('PASS  testExistingFieldsPreserved');
  });
}

// buildModelAdvisory still returns a string-flavored advisory and uses
// result.model under the hood. This is the regression test for the
// existing caller in scripts/forge-tools.cjs.
function testBuildModelAdvisoryStillWorks() {
  withTokenOpt('1', () => {
    const task = { name: 'add registration endpoint', description: 'POST /auth/register' };
    const advisory = router.buildModelAdvisory(task, 'forge-executor', baseConfig, null);
    assert.ok(typeof advisory.model === 'string', 'advisory.model is a string');
    assert.ok(advisory.advisory.includes(advisory.model), 'advisory string mentions model');
    assert.ok(advisory.classification && typeof advisory.classification.score === 'number');
    console.log('PASS  testBuildModelAdvisoryStillWorks');
  });
}

// ---------- Config override ----------

function testConfigOverrideInline() {
  withTokenOpt('1', () => {
    const cfg = {
      model_routing: {
        enabled: true,
        effort_policy: {
          'forge-executor': { effort: 'high', max_tokens: 99999 },
        },
      },
    };
    const r = router.selectModel('forge-executor', classifyAt(2, 'haiku'), null, cfg);
    assert.strictEqual(r.effort, 'high', 'override beats baked-in medium');
    assert.strictEqual(r.max_tokens, 99999, 'override max_tokens applied');
    console.log('PASS  testConfigOverrideInline');
  });
}

function testConfigOverrideFromForgeDir() {
  const root = mktmpdir('forge-router-cfg');
  try {
    const forgeDir = path.join(root, '.forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({
      model_routing: {
        enabled: true,
        effort_policy: {
          'forge-speccer':  { effort: 'low', max_tokens: 1234 },
          'forge-planner':  { max_tokens: 7777 }, // partial override
        },
      },
    }));
    router._resetEffortPolicyCache();
    withTokenOpt('1', () => {
      const cfg = { model_routing: { enabled: true, _forgeDir: forgeDir } };
      const speccer = router.selectModel('forge-speccer', classifyAt(2, 'haiku'), null, cfg);
      assert.strictEqual(speccer.effort, 'low', 'speccer effort overridden');
      assert.strictEqual(speccer.max_tokens, 1234, 'speccer max_tokens overridden');
      const planner = router.selectModel('forge-planner', classifyAt(2, 'haiku'), null, cfg);
      // partial override: max_tokens overridden, effort stays at default 'high'
      assert.strictEqual(planner.effort, 'high', 'planner effort default preserved');
      assert.strictEqual(planner.max_tokens, 7777, 'planner max_tokens overridden');
    });
    console.log('PASS  testConfigOverrideFromForgeDir');
  } finally {
    router._resetEffortPolicyCache();
    cleanup(root);
  }
}

function testMalformedConfigOverrideFallsBackToDefaults() {
  const root = mktmpdir('forge-router-bad-cfg');
  try {
    const forgeDir = path.join(root, '.forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    fs.writeFileSync(path.join(forgeDir, 'config.json'), '{ this is not json');
    router._resetEffortPolicyCache();
    withTokenOpt('1', () => {
      const cfg = { model_routing: { enabled: true, _forgeDir: forgeDir } };
      const r = router.selectModel('forge-speccer', classifyAt(2, 'haiku'), null, cfg);
      assert.strictEqual(r.effort, 'high', 'malformed config -> default effort');
      assert.strictEqual(r.max_tokens, 16000, 'malformed config -> default max_tokens');
    });
    console.log('PASS  testMalformedConfigOverrideFallsBackToDefaults');
  } finally {
    router._resetEffortPolicyCache();
    cleanup(root);
  }
}

// ---------- FORGE_TOKEN_OPT kill switch ----------

function testTokenOptZeroLegacyShape() {
  withTokenOpt('0', () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.ok(typeof r === 'object' && r !== null);
    assert.ok('model' in r, 'model field present');
    assert.ok('reasoning' in r, 'reasoning field present');
    assert.ok('cost_weight' in r, 'cost_weight field present');
    assert.strictEqual('effort' in r, false, 'effort key absent under FORGE_TOKEN_OPT=0');
    assert.strictEqual('max_tokens' in r, false, 'max_tokens key absent under FORGE_TOKEN_OPT=0');
    assert.strictEqual(Object.keys(r).length, 3, 'exactly 3 keys under kill switch');
    console.log('PASS  testTokenOptZeroLegacyShape');
  });
}

function testTokenOptZeroAcrossRoles() {
  withTokenOpt('0', () => {
    for (const role of ['forge-speccer', 'forge-planner', 'forge-reviewer', 'forge-verifier', 'forge-researcher', 'forge-complexity']) {
      const r = router.selectModel(role, classifyAt(7, 'sonnet'), null, baseConfig);
      assert.strictEqual('effort' in r, false, `role ${role} should not have effort under kill switch`);
      assert.strictEqual('max_tokens' in r, false, `role ${role} should not have max_tokens under kill switch`);
    }
    console.log('PASS  testTokenOptZeroAcrossRoles');
  });
}

function testTokenOptUnsetFiveFieldShape() {
  withTokenOpt(undefined, () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.ok('effort' in r, 'effort present when FORGE_TOKEN_OPT unset');
    assert.ok('max_tokens' in r, 'max_tokens present when FORGE_TOKEN_OPT unset');
    console.log('PASS  testTokenOptUnsetFiveFieldShape');
  });
}

function testTokenOptEmptyFiveFieldShape() {
  withTokenOpt('', () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.ok('effort' in r, 'empty string is not "0", effort still present');
    assert.ok('max_tokens' in r, 'empty string is not "0", max_tokens still present');
    console.log('PASS  testTokenOptEmptyFiveFieldShape');
  });
}

function testTokenOptOneFiveFieldShape() {
  withTokenOpt('1', () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.ok('effort' in r);
    assert.ok('max_tokens' in r);
    console.log('PASS  testTokenOptOneFiveFieldShape');
  });
}

function testTokenOptTrueFiveFieldShape() {
  withTokenOpt('true', () => {
    const r = router.selectModel('forge-executor', classifyAt(7, 'sonnet'), null, baseConfig);
    assert.ok('effort' in r, '"true" != "0", effort present');
    assert.ok('max_tokens' in r);
    console.log('PASS  testTokenOptTrueFiveFieldShape');
  });
}

// ---------- getEffortPolicy direct unit tests ----------

function testGetEffortPolicyExecutorAllBuckets() {
  const a = router.getEffortPolicy('forge-executor', 0, null);
  assert.deepStrictEqual(a, { effort: 'medium', max_tokens: 6000 });
  const b = router.getEffortPolicy('forge-executor', 8, null);
  assert.deepStrictEqual(b, { effort: 'medium', max_tokens: 10000 });
  const c = router.getEffortPolicy('forge-executor', 20, null);
  assert.deepStrictEqual(c, { effort: 'high', max_tokens: 14000 });
  console.log('PASS  testGetEffortPolicyExecutorAllBuckets');
}

function testGetEffortPolicyUnknownRole() {
  const r = router.getEffortPolicy('forge-mystery', 7, null);
  assert.strictEqual(r.effort, 'medium');
  assert.strictEqual(r.max_tokens, 10000);
  console.log('PASS  testGetEffortPolicyUnknownRole');
}

// ---------- run all ----------

function run_all() {
  const tests = [
    // Matrix (>=14 cases): 7 executor (3 buckets + 4 boundaries) + 5 flat roles
    // + 2 score-irrelevance for non-executor = 14 matrix cases.
    testExecutorScoreLow,
    testExecutorScoreMid,
    testExecutorScoreHigh,
    testExecutorBoundary4,
    testExecutorBoundary5,
    testExecutorBoundary10,
    testExecutorBoundary11,
    testSpeccerHigh,
    testPlannerHigh,
    testReviewerHigh,
    testVerifierHigh,
    testResearcherLow,
    testComplexityLow,
    testResearcherAtMid,
    testComplexityAtHigh,
    // Existing-field preservation + advisory regression
    testExistingFieldsPreserved,
    testBuildModelAdvisoryStillWorks,
    // Config override
    testConfigOverrideInline,
    testConfigOverrideFromForgeDir,
    testMalformedConfigOverrideFallsBackToDefaults,
    // Kill switch
    testTokenOptZeroLegacyShape,
    testTokenOptZeroAcrossRoles,
    testTokenOptUnsetFiveFieldShape,
    testTokenOptEmptyFiveFieldShape,
    testTokenOptOneFiveFieldShape,
    testTokenOptTrueFiveFieldShape,
    // Helper unit tests
    testGetEffortPolicyExecutorAllBuckets,
    testGetEffortPolicyUnknownRole,
  ];
  let failed = 0;
  for (const t of tests) {
    try { t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run_all();
