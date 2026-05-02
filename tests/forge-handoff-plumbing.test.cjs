// tests/forge-handoff-plumbing.test.cjs
//
// Wave 3 R003: command-layer plumbing for router hints + handoff JSON writer.
//
// Covers:
//   - writeHandoff produces the documented JSON shape
//     ({ model, effort, max_tokens, role, task_id }) for every role.
//   - File path is .forge/handoff.{taskId}.json (NOT a subdirectory).
//   - Idempotence: two writes on the same task overwrite cleanly.
//   - FORGE_TOKEN_OPT=0 kill switch -> handoff file is still written for
//     audit, but effort/max_tokens are omitted (legacy 3-field-equivalent
//     shape: { model, role, task_id }).
//   - Tolerates a missing forgeDir (mkdir -p semantics) and a malformed
//     classification (falls back to classifyTask on a stub).
//   - Return value matches what was written to disk so the orchestrator
//     can pass it straight to Agent's `model` parameter.
//
// Uses the shared tests/_helper.cjs framework so the run-tests.cjs runner
// counts these tests in the per-suite total.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const router = require('../scripts/forge-router.cjs');

// Run fn() with FORGE_TOKEN_OPT pinned to a known value, then restore.
// Tests must not leak env state across cases.
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

// Reset the router's effort-policy override cache between cases that
// touch on-disk config files. Without this, a temp .forge/config.json
// from a prior test could shadow the current one.
function resetCache() {
  router._resetEffortPolicyCache();
}

// Read the handoff JSON file written by writeHandoff. Returns null if
// the file does not exist (lets tests assert presence/absence cleanly).
function readHandoff(forgeDir, taskId) {
  const p = path.join(forgeDir, `handoff.${taskId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

suite('writeHandoff: shape and per-role hints', () => {
  test('forge-executor low-score task -> medium/6000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const task = { name: 'add small endpoint', description: 'single file' };
      const result = router.writeHandoff(forgeDir, 'T100', 'forge-executor', task);
      // Return value matches written file
      const onDisk = readHandoff(forgeDir, 'T100');
      assert.deepStrictEqual(onDisk, result);
      // Required fields present
      assert.strictEqual(onDisk.role, 'forge-executor');
      assert.strictEqual(onDisk.task_id, 'T100');
      assert.ok(typeof onDisk.model === 'string');
      assert.ok(['low', 'medium', 'high'].includes(onDisk.effort));
      assert.ok(typeof onDisk.max_tokens === 'number');
    });
  });

  test('forge-speccer -> high/16000 regardless of task', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const task = { name: 'spec idea', description: 'short' };
      const handoff = router.writeHandoff(forgeDir, 'T101', 'forge-speccer', task);
      assert.strictEqual(handoff.effort, 'high');
      assert.strictEqual(handoff.max_tokens, 16000);
      assert.strictEqual(handoff.role, 'forge-speccer');
    });
  });

  test('forge-planner -> high/12000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T102', 'forge-planner', { name: 'plan it' });
      assert.strictEqual(handoff.effort, 'high');
      assert.strictEqual(handoff.max_tokens, 12000);
    });
  });

  test('forge-reviewer -> high/12000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T103', 'forge-reviewer', { name: 'review it' });
      assert.strictEqual(handoff.effort, 'high');
      assert.strictEqual(handoff.max_tokens, 12000);
    });
  });

  test('forge-verifier -> high/12000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T104', 'forge-verifier', { name: 'verify it' });
      assert.strictEqual(handoff.effort, 'high');
      assert.strictEqual(handoff.max_tokens, 12000);
    });
  });

  test('forge-researcher -> low/4000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T105', 'forge-researcher', { name: 'lookup' });
      assert.strictEqual(handoff.effort, 'low');
      assert.strictEqual(handoff.max_tokens, 4000);
    });
  });

  test('forge-complexity -> low/2000', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T106', 'forge-complexity', { name: 'classify' });
      assert.strictEqual(handoff.effort, 'low');
      assert.strictEqual(handoff.max_tokens, 2000);
    });
  });
});

suite('writeHandoff: file path and shape contract', () => {
  test('writes to .forge/handoff.{taskId}.json (no subdirectory)', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      router.writeHandoff(forgeDir, 'T200', 'forge-executor', { name: 'task' });
      const expected = path.join(forgeDir, 'handoff.T200.json');
      assert.ok(fs.existsSync(expected), `expected ${expected} to exist`);
      // Confirm it is a flat file, not under a handoff/ subdirectory
      assert.strictEqual(fs.statSync(expected).isFile(), true);
      assert.strictEqual(fs.existsSync(path.join(forgeDir, 'handoff')), false);
    });
  });

  test('handoff JSON has exactly the documented keys (5-field shape)', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      router.writeHandoff(forgeDir, 'T201', 'forge-planner', { name: 'plan' });
      const onDisk = readHandoff(forgeDir, 'T201');
      const keys = Object.keys(onDisk).sort();
      assert.deepStrictEqual(
        keys,
        ['effort', 'max_tokens', 'model', 'role', 'task_id'],
        'handoff JSON should have exactly { model, effort, max_tokens, role, task_id }'
      );
    });
  });

  test('idempotent: writing the same task twice overwrites cleanly', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const first = router.writeHandoff(forgeDir, 'T202', 'forge-executor', { name: 'first' });
      const second = router.writeHandoff(forgeDir, 'T202', 'forge-executor', { name: 'first' });
      assert.deepStrictEqual(first, second);
      // Only one handoff file for this taskId
      const entries = fs.readdirSync(forgeDir).filter((n) => n.startsWith('handoff.T202.'));
      assert.strictEqual(entries.length, 1);
    });
  });

  test('different tasks produce different files (no cross-contamination)', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      router.writeHandoff(forgeDir, 'T203', 'forge-executor', { name: 'a' });
      router.writeHandoff(forgeDir, 'T204', 'forge-speccer',  { name: 'b' });
      const a = readHandoff(forgeDir, 'T203');
      const b = readHandoff(forgeDir, 'T204');
      assert.strictEqual(a.role, 'forge-executor');
      assert.strictEqual(b.role, 'forge-speccer');
      assert.strictEqual(a.task_id, 'T203');
      assert.strictEqual(b.task_id, 'T204');
      assert.notStrictEqual(a.max_tokens, b.max_tokens);
    });
  });

  test('return value equals what was written to disk', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const ret = router.writeHandoff(forgeDir, 'T205', 'forge-reviewer', { name: 'r' });
      const onDisk = readHandoff(forgeDir, 'T205');
      assert.deepStrictEqual(ret, onDisk);
    });
  });
});

suite('writeHandoff: FORGE_TOKEN_OPT=0 kill switch', () => {
  test('kill switch -> file is written but effort/max_tokens omitted', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('0', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T300', 'forge-executor', { name: 'whatever' });
      const onDisk = readHandoff(forgeDir, 'T300');
      assert.ok(onDisk, 'file still written under kill switch (auditability)');
      assert.deepStrictEqual(onDisk, handoff);
      assert.ok('model' in onDisk);
      assert.strictEqual(onDisk.role, 'forge-executor');
      assert.strictEqual(onDisk.task_id, 'T300');
      assert.strictEqual('effort' in onDisk, false, 'effort omitted under FORGE_TOKEN_OPT=0');
      assert.strictEqual('max_tokens' in onDisk, false, 'max_tokens omitted under FORGE_TOKEN_OPT=0');
      // Exactly the 3 documented legacy-equivalent keys
      const keys = Object.keys(onDisk).sort();
      assert.deepStrictEqual(keys, ['model', 'role', 'task_id']);
    });
  });

  test('kill switch is honored across all roles', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('0', () => {
      resetCache();
      const roles = ['forge-executor', 'forge-speccer', 'forge-planner', 'forge-reviewer', 'forge-verifier', 'forge-researcher', 'forge-complexity'];
      for (let i = 0; i < roles.length; i++) {
        const taskId = 'T31' + i;
        const handoff = router.writeHandoff(forgeDir, taskId, roles[i], { name: 'x' });
        assert.strictEqual('effort' in handoff, false, `role ${roles[i]} leaked effort under kill switch`);
        assert.strictEqual('max_tokens' in handoff, false, `role ${roles[i]} leaked max_tokens under kill switch`);
      }
    });
  });

  test('kill switch off (unset) -> 5-field shape with effort and max_tokens', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt(undefined, () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T320', 'forge-executor', { name: 'task' });
      assert.ok('effort' in handoff);
      assert.ok('max_tokens' in handoff);
    });
  });
});

suite('writeHandoff: classification flexibility', () => {
  test('accepts a task object and classifies it internally', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const task = { name: 'add registration endpoint', description: 'POST /auth/register' };
      const handoff = router.writeHandoff(forgeDir, 'T400', 'forge-executor', task);
      assert.ok(typeof handoff.max_tokens === 'number');
      assert.ok(handoff.max_tokens > 0);
    });
  });

  test('accepts a pre-classified object directly', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      // classifyTask-style object: must have .tier and .score
      const cls = router.classifyTask({ name: 'big migration architecture refactor', description: 'cross repo' });
      const handoff = router.writeHandoff(forgeDir, 'T401', 'forge-executor', cls);
      // High-score executor task should land in the high bucket
      assert.strictEqual(handoff.effort, 'high');
      assert.strictEqual(handoff.max_tokens, 14000);
    });
  });

  test('null/undefined complexity falls back to a stub classification', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T402', 'forge-researcher', null);
      // Researcher is flat (low/4000) so the stub shouldn't matter
      assert.strictEqual(handoff.effort, 'low');
      assert.strictEqual(handoff.max_tokens, 4000);
    });
  });
});

suite('writeHandoff: edge cases and tolerances', () => {
  test('creates forgeDir if it does not yet exist (mkdir -p)', () => {
    const { projectDir } = makeTempForgeDir();
    // Point at a NEW subdir that does not exist yet
    const newForgeDir = path.join(projectDir, '.forge-fresh');
    assert.strictEqual(fs.existsSync(newForgeDir), false, 'preconditon: dir does not exist');
    withTokenOpt('1', () => {
      resetCache();
      router.writeHandoff(newForgeDir, 'T500', 'forge-executor', { name: 't' });
      assert.ok(fs.existsSync(newForgeDir), 'writeHandoff created the missing directory');
      assert.ok(fs.existsSync(path.join(newForgeDir, 'handoff.T500.json')));
    });
  });

  test('rejects non-string forgeDir', () => {
    withTokenOpt('1', () => {
      resetCache();
      assert.throws(() => router.writeHandoff(null, 'T600', 'forge-executor', { name: 't' }),
        /forgeDir must be a non-empty string/);
      assert.throws(() => router.writeHandoff('', 'T600', 'forge-executor', { name: 't' }),
        /forgeDir must be a non-empty string/);
    });
  });

  test('rejects non-string taskId', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      assert.throws(() => router.writeHandoff(forgeDir, '', 'forge-executor', { name: 't' }),
        /taskId must be a non-empty string/);
      assert.throws(() => router.writeHandoff(forgeDir, null, 'forge-executor', { name: 't' }),
        /taskId must be a non-empty string/);
    });
  });

  test('rejects non-string role', () => {
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      assert.throws(() => router.writeHandoff(forgeDir, 'T700', '', { name: 't' }),
        /role must be a non-empty string/);
      assert.throws(() => router.writeHandoff(forgeDir, 'T700', null, { name: 't' }),
        /role must be a non-empty string/);
    });
  });

  test('integration: dispatch a mock agent flow across all 7 roles', () => {
    // R003.AC5 — assert handoff JSON files are written with the expected
    // effort/max_tokens values for every role we hand off to.
    const { forgeDir } = makeTempForgeDir();
    withTokenOpt('1', () => {
      resetCache();
      const dispatchPlan = [
        { taskId: 'T801', role: 'forge-speccer',    expEffort: 'high',   expTokens: 16000 },
        { taskId: 'T802', role: 'forge-planner',    expEffort: 'high',   expTokens: 12000 },
        { taskId: 'T803', role: 'forge-executor',   expEffort: 'medium', expTokensRange: [6000, 14000] },
        { taskId: 'T804', role: 'forge-reviewer',   expEffort: 'high',   expTokens: 12000 },
        { taskId: 'T805', role: 'forge-verifier',   expEffort: 'high',   expTokens: 12000 },
        { taskId: 'T806', role: 'forge-researcher', expEffort: 'low',    expTokens: 4000  },
        { taskId: 'T807', role: 'forge-complexity', expEffort: 'low',    expTokens: 2000  },
      ];
      // Mock dispatch loop: the orchestrator calls writeHandoff before each
      // Agent invocation. We don't actually invoke an agent — we just check
      // the file the orchestrator would have written.
      for (const step of dispatchPlan) {
        const ret = router.writeHandoff(forgeDir, step.taskId, step.role, { name: 'mock task' });
        const onDisk = readHandoff(forgeDir, step.taskId);
        assert.deepStrictEqual(ret, onDisk, `${step.role}: return value matches file`);
        assert.strictEqual(onDisk.effort, step.expEffort, `${step.role}: effort matches policy`);
        if (step.expTokens !== undefined) {
          assert.strictEqual(onDisk.max_tokens, step.expTokens, `${step.role}: max_tokens matches policy`);
        } else if (step.expTokensRange) {
          const [lo, hi] = step.expTokensRange;
          assert.ok(onDisk.max_tokens >= lo && onDisk.max_tokens <= hi,
            `${step.role}: max_tokens ${onDisk.max_tokens} in [${lo},${hi}]`);
        }
      }
      // All 7 handoff files should exist concurrently — they don't overwrite
      // each other since taskIds differ.
      const written = fs.readdirSync(forgeDir).filter((n) => /^handoff\.T80\d\.json$/.test(n));
      assert.strictEqual(written.length, 7, 'one handoff file per dispatched role');
    });
  });

  test('integration: respects on-disk effort_policy override from .forge/config.json', () => {
    const { forgeDir } = makeTempForgeDir({
      config: {
        model_routing: {
          enabled: true,
          effort_policy: {
            'forge-executor': { effort: 'high', max_tokens: 99999 },
          },
        },
      },
    });
    withTokenOpt('1', () => {
      resetCache();
      const handoff = router.writeHandoff(forgeDir, 'T900', 'forge-executor', { name: 'small task' });
      assert.strictEqual(handoff.effort, 'high', 'override beats baked-in medium');
      assert.strictEqual(handoff.max_tokens, 99999, 'override max_tokens applied');
    });
  });
});

runTests();
