// tests/mock-e2e-fix-run.test.cjs -- T023 / spec-mock-and-visual-verify R003
//
// Contract test for the end-to-end executor run that fixes all three
// intentional regressions in the blurry-graph mock (halo, zoom-out,
// empty synthesis). This is the harness-level assertion: given the
// post-fix mock code and a STUBBED Playwright MCP (no real browser
// launch), the visual verifier reports pass for every AC of the mock
// spec and the completion gate clears.
//
// The actual browser-driven verification is out of scope here and lives
// in T025's demo.sh. That script captures before/after PNGs against a
// live dev server; this test instead swaps the screenshot + vision
// bridges for deterministic stubs so the contract can run in CI without
// a browser.
//
// Assertions:
//   1. parseVisualAcs on the mock spec returns the 4 visual ACs from
//      T015 (R001: 1 AC, R002: 2 ACs, R003: 1 AC).
//   2. The fix has landed: src/config.ts has all regression flags false.
//   3. Running runVisualVerifier with stubbed pass-returning bridges
//      results in status=pass on every visual AC and the 3 R-level
//      requirements are all pass (grouped by requirementId).
//   4. After seeding a completion-gates.json that mirrors the verifier
//      output (pass for all 4 visual ACs + pass for the structural
//      [structural] ACs from the mock spec) plus a done task entry,
//      checkCompletionGates returns complete:true.
//   5. Negative control: if one visual AC returns fail (simulating the
//      pre-fix state) the gate correctly returns complete:false.

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const {
  parseVisualAcs,
  runVisualVerifier,
  checkCompletionGates,
  writeTaskRegistry
} = tools;

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_ROOT = path.resolve(REPO_ROOT, 'mock-projects/blurry-graph');
const MOCK_SPEC = path.resolve(MOCK_ROOT, '.forge/specs/001-readable-graph.md');
const MOCK_CONFIG = path.resolve(MOCK_ROOT, 'src/config.ts');
const MOCK_APP = path.resolve(MOCK_ROOT, 'src/App.tsx');

// Deterministic fake PNG bytes -- only the magic number matters for the
// stubs; the verifier writes the baseline and the vision bridge never
// decodes it.
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xAA, 0xBB]);

// ─── 1. Mock spec still carries the 4 visual ACs (regression guard) ──────

suite('mock E2E fix run — spec shape', () => {
  test('parseVisualAcs on mock spec returns 4 visual ACs across R001/R002/R003', () => {
    assert.ok(fs.existsSync(MOCK_SPEC), 'mock spec must exist at ' + MOCK_SPEC);
    const acs = parseVisualAcs(MOCK_SPEC);
    assert.strictEqual(acs.length, 4);

    const byR = {};
    for (const ac of acs) (byR[ac.requirementId] = byR[ac.requirementId] || []).push(ac);
    assert.strictEqual(byR.R001 && byR.R001.length, 1);
    assert.strictEqual(byR.R002 && byR.R002.length, 2);
    assert.strictEqual(byR.R003 && byR.R003.length, 1);
  });
});

// ─── 2. Fix landed: all four flags default to false in config.ts ─────────

suite('mock E2E fix run — source-level fix assertion', () => {
  test('src/config.ts declares all regression flags false', () => {
    const src = fs.readFileSync(MOCK_CONFIG, 'utf8');
    // Each flag must appear exactly once with the value `false`. Matching
    // on the `key: false` shape catches accidental reversions where a
    // future commit flips a flag back to true.
    assert.match(src, /\bhalo\s*:\s*false\b/,   'halo must default to false');
    assert.match(src, /\bzoomOut\s*:\s*false\b/, 'zoomOut must default to false');
    assert.match(src, /\bsynthesis\s*:\s*false\b/, 'synthesis must default to false');
    assert.match(src, /\boff\s*:\s*false\b/,    'off must default to false');

    // And for safety: no stray `: true` on any of the regression keys
    // (would indicate the line was appended rather than replaced).
    assert.doesNotMatch(src, /\bhalo\s*:\s*true\b/,   'halo must not also be true');
    assert.doesNotMatch(src, /\bzoomOut\s*:\s*true\b/, 'zoomOut must not also be true');
    assert.doesNotMatch(src, /\bsynthesis\s*:\s*true\b/, 'synthesis must not also be true');
  });

  test('src/App.tsx retains the Agreed/Disputed synthesis derivation', () => {
    const src = fs.readFileSync(MOCK_APP, 'utf8');
    // The synthesis derivation code lives on the healthy branch of the
    // ternary (`synthesisBroken ? null : <>…</>`). The E2E fix relies on
    // this block rendering when the flag is false -- a future refactor
    // that deletes it would silently break R003 without triggering any
    // structural test, so pin the shape here.
    assert.match(src, /<h3>Agreed<\/h3>/,   'Agreed heading must render in the healthy branch');
    assert.match(src, /<h3>Disputed<\/h3>/, 'Disputed heading must render in the healthy branch');
    assert.match(src, /stance\s*===\s*'agreed'/, 'Agreed list must filter by stance=agreed');
    assert.match(src, /stance\s*===\s*'disputed'/, 'Disputed list must filter by stance=disputed');
  });
});

// ─── 3. Stubbed verifier: all 4 visual ACs pass, grouped R pass ──────────

suite('mock E2E fix run — stubbed visual verifier pass', () => {
  test('with pass-returning bridges, every visual AC is pass and every R is pass', async () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });

    // Seed capabilities so the Playwright capability gate opens. In
    // production this comes from /forge:setup-tools; here we fabricate
    // it to exercise the bridge path.
    fs.writeFileSync(
      path.join(forgeDir, 'capabilities.json'),
      JSON.stringify({
        mcp_servers: { 'mcp__playwright': { command: 'stub' } },
        sandbox: { browser: true, spawn: true, network: true }
      })
    );

    // Copy the mock spec into the temp project so spec-id resolves
    // deterministically and no mutation escapes to the real fixture.
    const specDir = path.join(projectDir, '.forge', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, '001-readable-graph.md');
    fs.copyFileSync(MOCK_SPEC, specPath);

    // Stub screenshot bridge: emits a deterministic PNG per AC so the
    // verifier has a non-empty buffer to write as baseline. The acId is
    // folded into the buffer so record-mode writes distinct files per
    // AC (not strictly required for the test to pass, but more faithful
    // to the real bridge where each screenshot differs).
    let screenshotCalls = 0;
    const takeScreenshot = async (ac) => {
      screenshotCalls++;
      // Derive a per-AC hash-like suffix so the recorded baselines
      // differ on disk -- emulates real screenshots being distinct.
      const tag = Buffer.from(ac.acId + ':' + ac.viewport);
      return { pngBuffer: Buffer.concat([FAKE_PNG, tag]) };
    };

    // Stub vision bridge: post-fix state returns pass for every check.
    // Only reached on the compare path; in record mode (first run) the
    // verifier short-circuits to pass without calling this.
    let visionCalls = 0;
    const visionCompare = async () => { visionCalls++; return { status: 'pass', detail: 'stubbed' }; };

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'T023',
      specId: '001-readable-graph',
      recordBaselines: true,
      takeScreenshot,
      visionCompare
    });

    // Exactly 4 ACs, each called the screenshot bridge once.
    assert.strictEqual(screenshotCalls, 4, 'one screenshot per visual AC');
    assert.strictEqual(result.status, 'pass', 'overall status must be pass');
    assert.strictEqual(result.acs.length, 4);

    // Group by requirementId via acId prefix (shape: R<NNN>.AC<n>).
    const byR = {};
    for (const ac of result.acs) {
      const rid = String(ac.acId).split('.')[0];
      (byR[rid] = byR[rid] || []).push(ac);
    }
    assert.ok(byR.R001 && byR.R002 && byR.R003, 'all three Rs represented');

    // Every R passes iff every AC under it passes -- that is the
    // R-level aggregation rule the completion gate uses (any non-pass
    // AC fails the gate, which means its requirement fails too).
    for (const rid of ['R001', 'R002', 'R003']) {
      const allPass = byR[rid].every(a => a.status === 'pass');
      assert.ok(allPass, rid + ' must be pass after fix; got ' + JSON.stringify(byR[rid]));
    }

    // Progress file on disk carries the completion-gate-compatible shape.
    const progPath = path.join(forgeDir, 'progress', 'T023.json');
    assert.ok(fs.existsSync(progPath), 'progress file must be written');
    const prog = JSON.parse(fs.readFileSync(progPath, 'utf8'));
    assert.strictEqual(prog.visual_acs.length, 4);
    for (const ac of prog.visual_acs) assert.strictEqual(ac.status, 'pass');
  });
});

// ─── 4. Completion gate returns complete:true on the fixed mock ──────────

suite('mock E2E fix run — completion gate clears', () => {
  test('with all visual+nonvisual ACs pass and task done, checkCompletionGates returns complete:true', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: true });

    // Task registry: the single mock-fix task is DONE. Gate requires at
    // least one registered task that matches the frontier; we seed it
    // directly since there is no frontier in this temp dir.
    writeTaskRegistry(forgeDir, {
      tasks: {
        'T023-MOCK-FIX': {
          status: 'complete',
          completed_at: new Date().toISOString(),
          commit: 'stub-sha'
        }
      }
    });

    // Authoritative completion-gates.json mirrors what the verifier +
    // structural checker would produce end-to-end on the fixed mock:
    //   - 4 visual ACs (from the spec's [visual] lines) all pass
    //   - 2 structural ACs (R001.AC2 + R003.AC2) all pass
    const gates = {
      visual: [
        { id: 'R001.AC1', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R002.AC1', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R002.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R003.AC1', task_id: 'T023-MOCK-FIX', status: 'pass' }
      ],
      nonvisual: [
        { id: 'R001.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R003.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' }
      ]
    };
    fs.writeFileSync(
      path.join(forgeDir, 'completion-gates.json'),
      JSON.stringify(gates, null, 2)
    );

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, true,
      'gate must clear on the fixed mock; reasons=' + JSON.stringify(result.reasons));
    assert.strictEqual(result.gates.tasks, true,  'tasks gate must pass');
    assert.strictEqual(result.gates.visual, true, 'visual gate must pass');
    assert.strictEqual(result.gates.nonvisual, true, 'nonvisual gate must pass');
    assert.strictEqual(result.gates.flags, true, 'flags gate must pass (no open flags)');
    assert.deepStrictEqual(result.reasons, [], 'no reasons when complete=true');
  });

  test('negative control: a single failing visual AC keeps complete=false', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: true });

    writeTaskRegistry(forgeDir, {
      tasks: {
        'T023-MOCK-FIX': {
          status: 'complete',
          completed_at: new Date().toISOString(),
          commit: 'stub-sha'
        }
      }
    });

    // Simulate the pre-fix state on R001.AC1 (halo overlap still present).
    const gates = {
      visual: [
        { id: 'R001.AC1', task_id: 'T023-MOCK-FIX', status: 'fail',
          detail: 'halo overlaps adjacent nodes' },
        { id: 'R002.AC1', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R002.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R003.AC1', task_id: 'T023-MOCK-FIX', status: 'pass' }
      ],
      nonvisual: [
        { id: 'R001.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' },
        { id: 'R003.AC2', task_id: 'T023-MOCK-FIX', status: 'pass' }
      ]
    };
    fs.writeFileSync(
      path.join(forgeDir, 'completion-gates.json'),
      JSON.stringify(gates, null, 2)
    );

    const result = checkCompletionGates(forgeDir, {});
    assert.strictEqual(result.complete, false,
      'gate must NOT clear when a visual AC fails');
    assert.strictEqual(result.gates.visual, false);
    // Exactly one failing reason, attributed to the visual gate and the
    // specific AC so humans (and the backprop agent) can trace it.
    const visualReasons = result.reasons.filter(r => r.gate === 'visual');
    assert.strictEqual(visualReasons.length, 1);
    assert.strictEqual(visualReasons[0].ac, 'R001.AC1');
    assert.match(visualReasons[0].detail, /halo/i);
  });
});

runTests();
