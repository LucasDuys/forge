// tests/visual-verifier-readiness.test.cjs -- Wave 4 T002 / R002
//
// Covers the deterministic browser-readiness recipe that replaces the
// brittle networkidle/500-ms fallback in the visual verifier:
//
//   1. awaitVisualReady happy path: stub bridge returns { ok: true }.
//   2. Fonts stage failure: stub returns { ok: false, stage: 'fonts' }.
//   3. Animations stage failure surface as `stage: 'animations'`.
//   4. Paint stage failure surface as `stage: 'paint'`.
//   5. Overall timeout when bridge never resolves -- structured reject.
//   6. Script ordering: fonts -> animations -> rAF (asserted by inspecting
//      the script string passed to the bridge).
//   7. Style tag id matches the documented hook (`forge-visual-disable-anim`).
//   8. Bridge throw is captured as a structured rejection, never bubbles raw.
//   9. evaluateFn missing -> rejects without hanging.
//  10. runVisualVerifier integration: readiness timeout marks the AC
//      `blocked` with detail `readiness_timeout: <stage>` and the next AC
//      still runs (the run is not poisoned).
//  11. runVisualVerifier integration: when readiness succeeds the
//      screenshot bridge is invoked exactly once per AC, and ACs pass.
//  12. runVisualVerifier integration: with no `evaluateBridge` opt the
//      verifier is unchanged (regression guard for the 16 pre-existing
//      visual-verifier tests + the 7 CRLF tests).
//
// Conventions follow tests/visual-verifier.test.cjs and tests/_helper.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const { awaitVisualReady, runVisualVerifier } = tools;

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SPEC = path.resolve(
  REPO_ROOT,
  'mock-projects/blurry-graph/.forge/specs/001-readable-graph.md'
);

// Tiny helper: capture the script string the bridge is called with.
function makeCaptureBridge(returnValue) {
  const captured = { calls: 0, lastScript: null, scripts: [] };
  const fn = async (script) => {
    captured.calls++;
    captured.lastScript = script;
    captured.scripts.push(script);
    if (typeof returnValue === 'function') return returnValue(script);
    return returnValue;
  };
  return { fn, captured };
}

// ─── 1. Happy path ───────────────────────────────────────────────────────

suite('awaitVisualReady — happy path', () => {
  test('all three stages resolve, helper resolves with { ready: true }', async () => {
    const { fn, captured } = makeCaptureBridge({ ok: true });
    const out = await awaitVisualReady(fn, 1000);
    assert.deepStrictEqual(out, { ready: true });
    assert.strictEqual(captured.calls, 1, 'bridge called exactly once');
    assert.ok(typeof captured.lastScript === 'string' && captured.lastScript.length > 0,
      'script string passed to bridge');
  });

  test('omitted timeoutMs uses 3000-ms default and does not throw on quick resolve', async () => {
    const { fn } = makeCaptureBridge({ ok: true });
    const out = await awaitVisualReady(fn);
    assert.deepStrictEqual(out, { ready: true });
  });
});

// ─── 2-4. Stage rejections ───────────────────────────────────────────────

suite('awaitVisualReady — stage rejections', () => {
  test('fonts stage failure -> { reason: readiness_timeout, stage: fonts }', async () => {
    const { fn } = makeCaptureBridge({ ok: false, stage: 'fonts', error: 'mock-fonts' });
    let caught = null;
    try { await awaitVisualReady(fn, 500); } catch (e) { caught = e; }
    assert.ok(caught, 'must reject');
    assert.strictEqual(caught.reason, 'readiness_timeout');
    assert.strictEqual(caught.stage, 'fonts');
  });

  test('animations stage failure -> stage: animations', async () => {
    const { fn } = makeCaptureBridge({ ok: false, stage: 'animations', error: 'css-fail' });
    let caught = null;
    try { await awaitVisualReady(fn, 500); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.stage, 'animations');
  });

  test('paint stage failure -> stage: paint', async () => {
    const { fn } = makeCaptureBridge({ ok: false, stage: 'paint' });
    let caught = null;
    try { await awaitVisualReady(fn, 500); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.stage, 'paint');
  });
});

// ─── 5. Overall timeout ──────────────────────────────────────────────────

suite('awaitVisualReady — overall timeout', () => {
  test('bridge never resolves -> rejects with stage: overall after timeoutMs', async () => {
    const t0 = Date.now();
    let caught = null;
    try {
      await awaitVisualReady(() => new Promise(() => {}), 50);
    } catch (e) { caught = e; }
    const dt = Date.now() - t0;
    assert.ok(caught, 'must reject');
    assert.strictEqual(caught.reason, 'readiness_timeout');
    assert.strictEqual(caught.stage, 'overall');
    assert.ok(dt >= 40 && dt < 1000, 'rejects close to the configured timeout, got ' + dt + 'ms');
  });
});

// ─── 6. Script ordering ──────────────────────────────────────────────────

suite('awaitVisualReady — script ordering', () => {
  test('animation-disable injection happens before the rAF wait', async () => {
    const { fn, captured } = makeCaptureBridge({ ok: true });
    await awaitVisualReady(fn, 500);
    const s = captured.lastScript;
    assert.ok(s, 'script captured');
    const fontsIdx = s.indexOf('document.fonts.ready');
    const styleIdx = s.indexOf('forge-visual-disable-anim');
    const rafIdx = s.indexOf('requestAnimationFrame');
    assert.ok(fontsIdx >= 0, 'fonts.ready in script');
    assert.ok(styleIdx >= 0, 'style id in script');
    assert.ok(rafIdx >= 0, 'rAF in script');
    assert.ok(fontsIdx < styleIdx, 'fonts must come before style injection');
    assert.ok(styleIdx < rafIdx, 'style injection must come before rAF');
  });

  test('script disables transition, animation, and caret-color globally', async () => {
    const { fn, captured } = makeCaptureBridge({ ok: true });
    await awaitVisualReady(fn, 500);
    const s = captured.lastScript;
    assert.ok(/transition:\s*none\s*!important/.test(s), 'transition:none present');
    assert.ok(/animation:\s*none\s*!important/.test(s), 'animation:none present');
    assert.ok(/caret-color:\s*transparent\s*!important/.test(s), 'caret-color:transparent present');
    assert.ok(/\*,\s*\*::before,\s*\*::after/.test(s), 'universal selector present');
  });
});

// ─── 7. Bridge robustness ────────────────────────────────────────────────

suite('awaitVisualReady — bridge robustness', () => {
  test('bridge that throws synchronously rejects with structured shape', async () => {
    const fn = () => { throw new Error('sync-boom'); };
    let caught = null;
    try { await awaitVisualReady(fn, 200); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.reason, 'readiness_timeout');
    // Synchronous throw maps to stage 'unknown' (we never reached the
    // browser).
    assert.strictEqual(caught.stage, 'unknown');
  });

  test('non-function evaluateFn rejects, never hangs', async () => {
    let caught = null;
    try { await awaitVisualReady(null, 200); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.reason, 'readiness_timeout');
    assert.strictEqual(caught.stage, 'unknown');
  });

  test('bridge resolving to undefined rejects (no_result)', async () => {
    const { fn } = makeCaptureBridge(undefined);
    let caught = null;
    try { await awaitVisualReady(fn, 200); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.stage, 'unknown');
  });
});

// ─── 8-10. runVisualVerifier integration ─────────────────────────────────

function seedVerifierWorkspace() {
  const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });
  fs.writeFileSync(
    path.join(forgeDir, 'capabilities.json'),
    JSON.stringify({
      mcp_servers: { 'mcp__playwright': { command: 'stub' } },
      sandbox: { browser: true, spawn: true, network: true }
    })
  );
  const specDir = path.join(projectDir, '.forge', 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, '001-readable-graph.md');
  fs.copyFileSync(MOCK_SPEC, specPath);
  return { forgeDir, projectDir, specPath };
}

suite('runVisualVerifier — readiness wiring', () => {
  test('readiness timeout blocks one AC; subsequent ACs continue', async () => {
    const { forgeDir, specPath } = seedVerifierWorkspace();
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

    // Bridge returns a fonts-stage failure on the FIRST call only,
    // then ok on the rest. This proves the loop continues past the
    // first blocked AC instead of poisoning the run.
    let evalCalls = 0;
    const evaluateBridge = async () => {
      evalCalls++;
      if (evalCalls === 1) return { ok: false, stage: 'fonts', error: 'mock' };
      return { ok: true };
    };

    const screenshotCalls = [];
    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T002',
      specId: '001-readable-graph',
      recordBaselines: true,
      evaluateBridge,
      readinessTimeoutMs: 200,
      takeScreenshot: async (ac) => {
        screenshotCalls.push(ac.acId);
        return { pngBuffer: fakePng };
      }
    });

    // 4 ACs in the mock spec. First is blocked (no screenshot taken),
    // remaining 3 take screenshots and pass via record-baseline mode.
    assert.strictEqual(result.acs.length, 4);
    assert.strictEqual(result.acs[0].status, 'blocked');
    assert.match(result.acs[0].detail || '', /^readiness_timeout: fonts$/);
    assert.strictEqual(result.acs[1].status, 'pass');
    assert.strictEqual(result.acs[2].status, 'pass');
    assert.strictEqual(result.acs[3].status, 'pass');
    assert.strictEqual(screenshotCalls.length, 3,
      'screenshot bridge called only for ACs that passed readiness');
    // Overall status is `blocked` because at least one AC is blocked
    // and none failed -- documented overall-status logic in
    // runVisualVerifier.
    assert.strictEqual(result.status, 'blocked');
  });

  test('readiness success -> screenshot bridge runs once per AC and ACs pass', async () => {
    const { forgeDir, specPath } = seedVerifierWorkspace();
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

    let evalCalls = 0;
    let shotCalls = 0;
    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T002',
      specId: '001-readable-graph',
      recordBaselines: true,
      evaluateBridge: async () => { evalCalls++; return { ok: true }; },
      takeScreenshot: async () => { shotCalls++; return { pngBuffer: fakePng }; }
    });

    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.acs.length, 4);
    for (const ac of result.acs) {
      assert.strictEqual(ac.status, 'pass');
    }
    assert.strictEqual(evalCalls, 4, 'readiness bridge called once per AC');
    assert.strictEqual(shotCalls, 4, 'screenshot bridge called once per AC');
  });

  test('no evaluateBridge opt -> verifier behavior unchanged (regression guard)', async () => {
    const { forgeDir, specPath } = seedVerifierWorkspace();
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    let shotCalls = 0;
    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T002-NOBRIDGE',
      specId: '001-readable-graph',
      recordBaselines: true,
      // evaluateBridge intentionally omitted.
      takeScreenshot: async () => { shotCalls++; return { pngBuffer: fakePng }; }
    });
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(shotCalls, 4);
    for (const ac of result.acs) assert.strictEqual(ac.status, 'pass');
  });
});

runTests();
