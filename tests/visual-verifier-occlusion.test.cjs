// tests/visual-verifier-occlusion.test.cjs -- Wave 4 T003 / R003
//
// Covers the opt-in occlusion probe that catches "DOM present but
// covered by something else" failures missed by isVisible() and the
// vision-LLM compare:
//
//   1. verifyVisible -- visible (top === el)
//   2. verifyVisible -- visible via el.contains(top) (clicking a child)
//   3. verifyVisible -- occluded (different topmost element)
//   4. verifyVisible -- offscreen, negative coords
//   5. verifyVisible -- offscreen, beyond viewport
//   6. verifyVisible -- not_found (selector matches nothing)
//   7. verifyVisible -- not_found (elementFromPoint returns null)
//   8. verifyVisible -- bridge throw is captured (no raw bubble), returns
//      not_found.
//   9. verifyVisible -- non-function evaluateFn returns not_found.
//  10. verifyVisible -- script ordering: querySelector -> rect -> viewport
//      check -> elementFromPoint -> contains.
//  11. parseVisualAcs -- recognises occluded_check=true and selector="…".
//  12. parseVisualAcs -- defaults occludedCheck:false, selector:null when
//      tokens are absent.
//  13. parseVisualAcs -- single-quoted selector also accepted.
//  14. parseVisualAcs -- no regression on the 4 mock-spec ACs (all carry
//      occludedCheck:false, selector:null).
//  15. runVisualVerifier integration -- AC with `occluded_check=true` and
//      an "occluded" stub probe -> AC fail with detail starting `occluded:`,
//      other ACs continue.
//  16. runVisualVerifier integration -- AC WITHOUT `occluded_check` ->
//      verifyVisible NOT called (no elementFromPoint script ever sent).
//
// Conventions follow tests/visual-verifier-readiness.test.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const { verifyVisible, parseVisualAcs, runVisualVerifier } = tools;

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SPEC = path.resolve(
  REPO_ROOT,
  'mock-projects/blurry-graph/.forge/specs/001-readable-graph.md'
);

// Tiny helper mirroring readiness tests: capture each script the bridge
// receives and serve a canned response (or call a function).
function makeCaptureBridge(returnValue) {
  const captured = { calls: 0, scripts: [] };
  const fn = async (script) => {
    captured.calls++;
    captured.scripts.push(script);
    if (typeof returnValue === 'function') return returnValue(script);
    return returnValue;
  };
  return { fn, captured };
}

// ─── 1-2. Visible branches ───────────────────────────────────────────────

suite('verifyVisible — visible branches', () => {
  test('top === el -> { visible: true }', async () => {
    const { fn } = makeCaptureBridge({ visible: true });
    const out = await verifyVisible(fn, '#mybtn');
    assert.deepStrictEqual(out, { visible: true });
  });

  test('el.contains(top) (click on child of target) -> { visible: true }', async () => {
    // Browser-side script is responsible for the contains() short-circuit;
    // at the helper level we just trust the bridge's returned shape.
    const { fn } = makeCaptureBridge({ visible: true });
    const out = await verifyVisible(fn, '.parent');
    assert.deepStrictEqual(out, { visible: true });
  });
});

// ─── 3. Occluded branch ──────────────────────────────────────────────────

suite('verifyVisible — occluded', () => {
  test('different topmost element -> { visible: false, occludedBy: "<head>" }', async () => {
    const occHtml = '<div class="modal-overlay">Cookie banner ...</div>';
    const { fn } = makeCaptureBridge({ visible: false, occludedBy: occHtml });
    const out = await verifyVisible(fn, '#cta');
    assert.strictEqual(out.visible, false);
    assert.strictEqual(out.occludedBy, occHtml);
    assert.strictEqual(out.reason, undefined,
      'occluded result has occludedBy, not reason');
  });
});

// ─── 4-5. Offscreen branches ─────────────────────────────────────────────

suite('verifyVisible — offscreen', () => {
  test('negative coords -> { visible: false, reason: "offscreen" }', async () => {
    const { fn } = makeCaptureBridge({ visible: false, reason: 'offscreen' });
    const out = await verifyVisible(fn, '.scrolled-up');
    assert.deepStrictEqual(out, { visible: false, reason: 'offscreen' });
  });

  test('beyond viewport -> { visible: false, reason: "offscreen" }', async () => {
    const { fn } = makeCaptureBridge({ visible: false, reason: 'offscreen' });
    const out = await verifyVisible(fn, '.below-fold');
    assert.deepStrictEqual(out, { visible: false, reason: 'offscreen' });
  });
});

// ─── 6-7. Not-found branches ─────────────────────────────────────────────

suite('verifyVisible — not_found', () => {
  test('selector matches nothing -> { visible: false, reason: "not_found" }', async () => {
    const { fn } = makeCaptureBridge({ visible: false, reason: 'not_found' });
    const out = await verifyVisible(fn, '#never-exists');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
  });

  test('elementFromPoint returns null -> { visible: false, reason: "not_found" }', async () => {
    // The browser-side script collapses both querySelector === null AND
    // elementFromPoint === null into the same not_found shape; from the
    // Node side they're indistinguishable, which matches the documented
    // contract.
    const { fn } = makeCaptureBridge({ visible: false, reason: 'not_found' });
    const out = await verifyVisible(fn, '.weird-iframe-target');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
  });
});

// ─── 8-9. Bridge robustness ──────────────────────────────────────────────

suite('verifyVisible — bridge robustness', () => {
  test('bridge throws -> returns { visible: false, reason: "not_found" } (no raw bubble)', async () => {
    const fn = () => { throw new Error('boom'); };
    const out = await verifyVisible(fn, '#x');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
  });

  test('non-function evaluateFn -> not_found, never calls anything', async () => {
    const out = await verifyVisible(null, '#x');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
  });

  test('empty selector -> not_found without invoking bridge', async () => {
    let calls = 0;
    const fn = async () => { calls++; return { visible: true }; };
    const out = await verifyVisible(fn, '');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
    assert.strictEqual(calls, 0, 'bridge must not be invoked for empty selector');
  });

  test('bridge resolving to undefined -> not_found', async () => {
    const { fn } = makeCaptureBridge(undefined);
    const out = await verifyVisible(fn, '#x');
    assert.deepStrictEqual(out, { visible: false, reason: 'not_found' });
  });
});

// ─── 10. Script ordering and selector-escape safety ──────────────────────

suite('verifyVisible — script ordering', () => {
  test('script contains querySelector, getBoundingClientRect, elementFromPoint, contains', async () => {
    const { fn, captured } = makeCaptureBridge({ visible: true });
    await verifyVisible(fn, '#mybtn');
    const s = captured.scripts[0];
    assert.ok(s, 'script captured');
    const qs = s.indexOf('querySelector');
    const rect = s.indexOf('getBoundingClientRect');
    const vp = s.indexOf('innerWidth');
    const efp = s.indexOf('elementFromPoint');
    const contains = s.indexOf('.contains(');
    assert.ok(qs >= 0, 'querySelector in script');
    assert.ok(rect >= 0, 'getBoundingClientRect in script');
    assert.ok(vp >= 0, 'innerWidth/innerHeight in script');
    assert.ok(efp >= 0, 'elementFromPoint in script');
    assert.ok(contains >= 0, 'contains() check in script');
    assert.ok(qs < rect, 'querySelector must come before getBoundingClientRect');
    assert.ok(rect < vp, 'rect must come before viewport bounds check');
    assert.ok(vp < efp, 'viewport check must come before elementFromPoint');
    assert.ok(efp < contains, 'elementFromPoint must come before contains() check');
  });

  test('selector with quotes is JSON-escaped (no source injection)', async () => {
    const { fn, captured } = makeCaptureBridge({ visible: true });
    // Pathological selector with a closing quote and a semicolon. If the
    // helper just string-concatenated the selector this would break the
    // script syntax (or worse).
    await verifyVisible(fn, 'a"; alert(1); //');
    const s = captured.scripts[0];
    // The selector is embedded via JSON.stringify -> the literal substring
    // `"a\"; alert(1); //"` must appear in the script.
    assert.ok(
      s.indexOf('"a\\"; alert(1); //"') >= 0,
      'selector must be JSON-escaped inside the script string'
    );
  });
});

// ─── 11-13. parseVisualAcs token recognition ─────────────────────────────

suite('parseVisualAcs — occluded_check + selector tokens', () => {
  test('recognises occluded_check=true and selector="#id"', () => {
    const { projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Occluded probe',
      '',
      '- [ ] [visual] path=/cta occluded_check=true selector="#mybtn" checks=["visible"]',
      ''
    ].join('\n'));
    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 1);
    assert.strictEqual(acs[0].occludedCheck, true);
    assert.strictEqual(acs[0].selector, '#mybtn');
  });

  test('defaults to occludedCheck:false, selector:null when tokens absent', () => {
    const { projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Plain visual',
      '',
      '- [ ] [visual] path=/ checks=["render"]',
      ''
    ].join('\n'));
    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 1);
    assert.strictEqual(acs[0].occludedCheck, false);
    assert.strictEqual(acs[0].selector, null);
  });

  test('occluded_check=false is parsed as boolean false (not the string "false")', () => {
    const { projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Explicit false',
      '',
      '- [ ] [visual] path=/ occluded_check=false selector="#x" checks=["a"]',
      ''
    ].join('\n'));
    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 1);
    assert.strictEqual(acs[0].occludedCheck, false);
    // Selector is still captured even when occluded_check is explicit false;
    // a future structural verifier could still use it.
    assert.strictEqual(acs[0].selector, '#x');
  });

  test('single-quoted selector is also accepted', () => {
    const { projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Single-quote',
      '',
      "- [ ] [visual] path=/ occluded_check=true selector='.cta-button' checks=[\"a\"]",
      ''
    ].join('\n'));
    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 1);
    assert.strictEqual(acs[0].occludedCheck, true);
    assert.strictEqual(acs[0].selector, '.cta-button');
  });
});

// ─── 14. Mock-spec regression guard ──────────────────────────────────────

suite('parseVisualAcs — mock spec carries new fields with defaults', () => {
  test('all 4 mock-spec ACs report occludedCheck:false, selector:null', () => {
    assert.ok(fs.existsSync(MOCK_SPEC), 'mock spec must exist');
    const acs = parseVisualAcs(MOCK_SPEC);
    assert.strictEqual(acs.length, 4, '4 visual ACs in the mock spec (regression)');
    for (const ac of acs) {
      assert.strictEqual(ac.occludedCheck, false,
        ac.acId + ' must default occludedCheck to false');
      assert.strictEqual(ac.selector, null,
        ac.acId + ' must default selector to null');
    }
  });
});

// ─── 15-16. runVisualVerifier integration ────────────────────────────────

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
  return { forgeDir, projectDir, specDir };
}

suite('runVisualVerifier — occlusion wiring', () => {
  test('AC with occluded_check=true + occluded probe -> AC fail; other ACs continue', async () => {
    const { forgeDir, specDir } = seedVerifierWorkspace();
    const specPath = path.join(specDir, 'spec.md');
    // Two ACs: first opts into the occlusion probe; second is plain visual.
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Probe',
      '',
      '- [ ] [visual] path=/cta occluded_check=true selector="#cta" checks=["visible"]',
      '- [ ] [visual] path=/dashboard checks=["renders"]',
      ''
    ].join('\n'));

    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

    // The bridge must distinguish readiness scripts from probe scripts.
    // Readiness scripts contain `forge-visual-disable-anim`; probe scripts
    // contain `elementFromPoint`. We return ok-readiness for the former
    // and an occluded result for the latter on the FIRST AC, then a
    // visible result for any subsequent probe. Since the second AC has no
    // probe, only the first AC ever calls elementFromPoint.
    const evalLog = { readiness: 0, probe: 0 };
    const evaluateBridge = async (script) => {
      if (typeof script === 'string' && script.indexOf('forge-visual-disable-anim') >= 0) {
        evalLog.readiness++;
        return { ok: true };
      }
      if (typeof script === 'string' && script.indexOf('elementFromPoint') >= 0) {
        evalLog.probe++;
        return {
          visible: false,
          occludedBy: '<div class="cookie-banner">Accept</div>'
        };
      }
      // Should never happen.
      return null;
    };

    const screenshotCalls = [];
    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T003',
      specId: 'spec',
      recordBaselines: true,
      evaluateBridge,
      takeScreenshot: async (ac) => {
        screenshotCalls.push(ac.acId);
        return { pngBuffer: fakePng };
      }
    });

    assert.strictEqual(result.acs.length, 2);
    // First AC: occluded -> fail with detail starting "occluded:".
    assert.strictEqual(result.acs[0].status, 'fail');
    assert.ok(
      typeof result.acs[0].detail === 'string' && result.acs[0].detail.indexOf('occluded:') === 0,
      'detail must start with "occluded:" -- got: ' + result.acs[0].detail
    );
    // Second AC: no probe, normal flow records baseline -> pass.
    assert.strictEqual(result.acs[1].status, 'pass');
    // Probe was called once (only AC1), readiness was called twice (both ACs).
    assert.strictEqual(evalLog.probe, 1, 'probe runs only for opt-in AC');
    assert.strictEqual(evalLog.readiness, 2, 'readiness runs for every AC');
    // Screenshot bridge skipped for AC1 (failed at probe), invoked for AC2.
    assert.deepStrictEqual(screenshotCalls, ['R001.AC2']);
    // Overall status: any fail wins.
    assert.strictEqual(result.status, 'fail');
  });

  test('AC without occluded_check -> verifyVisible never called', async () => {
    const { forgeDir, specDir } = seedVerifierWorkspace();
    const specPath = path.join(specDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Plain visual ACs',
      '',
      '- [ ] [visual] path=/ checks=["render"]',
      '- [ ] [visual] path=/dashboard checks=["render"]',
      ''
    ].join('\n'));

    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const allScripts = [];
    const evaluateBridge = async (script) => {
      allScripts.push(String(script));
      return { ok: true };
    };

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T003-NOPROBE',
      specId: 'spec',
      recordBaselines: true,
      evaluateBridge,
      takeScreenshot: async () => ({ pngBuffer: fakePng })
    });

    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.acs.length, 2);
    for (const ac of result.acs) assert.strictEqual(ac.status, 'pass');
    // Critical: no script string should reference elementFromPoint.
    for (const s of allScripts) {
      assert.ok(s.indexOf('elementFromPoint') === -1,
        'verifyVisible must not be called when occluded_check is absent');
    }
    // We expect exactly one readiness script per AC -- no extra probe.
    assert.strictEqual(allScripts.length, 2, 'one evaluateBridge call per AC (readiness only)');
  });

  test('occluded_check=true but no selector -> probe is skipped (defensive)', async () => {
    const { forgeDir, specDir } = seedVerifierWorkspace();
    const specPath = path.join(specDir, 'spec.md');
    // occluded_check is on but selector is missing -> nothing to probe.
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Half-configured probe',
      '',
      '- [ ] [visual] path=/ occluded_check=true checks=["render"]',
      ''
    ].join('\n'));

    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const allScripts = [];
    const evaluateBridge = async (script) => {
      allScripts.push(String(script));
      return { ok: true };
    };

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T003-NOSEL',
      specId: 'spec',
      recordBaselines: true,
      evaluateBridge,
      takeScreenshot: async () => ({ pngBuffer: fakePng })
    });

    assert.strictEqual(result.status, 'pass', 'no selector -> no probe -> normal pass path');
    assert.strictEqual(result.acs[0].status, 'pass');
    for (const s of allScripts) {
      assert.ok(s.indexOf('elementFromPoint') === -1,
        'no selector means probe is skipped');
    }
  });

  test('occlusion probe with reason="offscreen" -> detail "occluded: offscreen"', async () => {
    const { forgeDir, specDir } = seedVerifierWorkspace();
    const specPath = path.join(specDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Offscreen probe',
      '',
      '- [ ] [visual] path=/ occluded_check=true selector="#hero" checks=["render"]',
      ''
    ].join('\n'));

    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const evaluateBridge = async (script) => {
      if (typeof script === 'string' && script.indexOf('forge-visual-disable-anim') >= 0) {
        return { ok: true };
      }
      return { visible: false, reason: 'offscreen' };
    };

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'WAVE4-T003-OFFSCR',
      specId: 'spec',
      recordBaselines: true,
      evaluateBridge,
      takeScreenshot: async () => ({ pngBuffer: fakePng })
    });

    assert.strictEqual(result.acs[0].status, 'fail');
    assert.strictEqual(result.acs[0].detail, 'occluded: offscreen');
    assert.strictEqual(result.status, 'fail');
  });
});

runTests();
