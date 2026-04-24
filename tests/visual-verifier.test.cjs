// tests/visual-verifier.test.cjs -- T020 / R007
//
// Covers the visual verifier plumbing:
//   1. parseVisualAcs extracts every [visual] AC from the mock spec with
//      correct requirementId / acId / path / viewport / checks fields.
//   2. runVisualVerifier writes `visual_acs` to a per-task progress file
//      when all bridges succeed (pass path, record mode).
//   3. runVisualVerifier reports `blocked` with detail "playwright_unavailable"
//      when FORGE_DISABLE_PLAYWRIGHT=1 (env-forced degradation).
//   4. runVisualVerifier reports `blocked` with detail "browser_cap_disabled"
//      when capabilities.sandbox.browser === false.
//   5. baseline file path matches the schema
//      .forge/baselines/<spec-id>/<requirementId>-<acId>.png
//   6. visual-verify parse CLI round-trips the parsed AC list to stdout.
//   7. No Playwright MCP calls are made here -- integration is T023's job.
//
// These are unit tests: screenshot bridges are stubbed, vision compare
// is stubbed, no browser is launched.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const {
  parseVisualAcs,
  checkVisualCapabilities,
  baselinePath,
  writeVisualProgress,
  runVisualVerifier
} = tools;

const FORGE_TOOLS_CLI = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SPEC = path.resolve(
  REPO_ROOT,
  'mock-projects/blurry-graph/.forge/specs/001-readable-graph.md'
);

// ─── 1. parseVisualAcs on the mock spec ───────────────────────────────────

suite('parseVisualAcs — mock spec extraction', () => {
  test('extracts every [visual] AC from the blurry-graph mock spec', () => {
    assert.ok(fs.existsSync(MOCK_SPEC), 'mock spec must exist: ' + MOCK_SPEC);
    const acs = parseVisualAcs(MOCK_SPEC);

    // Mock spec declares: R001 (1 visual), R002 (2 visual), R003 (1 visual).
    // Total = 4 visual ACs across 3 requirements.
    assert.strictEqual(acs.length, 4, 'expected 4 [visual] ACs');

    // Group by requirement id for easier assertions.
    const byR = {};
    for (const ac of acs) {
      (byR[ac.requirementId] = byR[ac.requirementId] || []).push(ac);
    }

    // R001: 1 visual AC, viewport 1280x800, 3 checks.
    assert.ok(byR.R001, 'R001 must have at least one visual AC');
    assert.strictEqual(byR.R001.length, 1);
    assert.strictEqual(byR.R001[0].acId, 'R001.AC1');
    assert.strictEqual(byR.R001[0].path, '/');
    assert.strictEqual(byR.R001[0].viewport, '1280x800');
    assert.strictEqual(byR.R001[0].checks.length, 3);
    assert.match(byR.R001[0].checks[0], /readable/i);

    // R002: 2 visual ACs across two viewports (1280x800 + 1920x1080).
    assert.ok(byR.R002, 'R002 must have visual ACs');
    assert.strictEqual(byR.R002.length, 2);
    const viewports = byR.R002.map(ac => ac.viewport).sort();
    assert.deepStrictEqual(viewports, ['1280x800', '1920x1080']);

    // R003: 1 visual AC, no viewport token -> defaults to 1280x800.
    assert.ok(byR.R003, 'R003 must have a visual AC');
    assert.strictEqual(byR.R003.length, 1);
    assert.strictEqual(byR.R003[0].viewport, '1280x800');
    assert.strictEqual(byR.R003[0].checks.length, 3);
  });

  test('unchecked and checked boxes both qualify', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---',
      'domain: test',
      '---',
      '',
      '### R001: Whatever',
      '',
      '- [ ] [visual] path=/a viewport=800x600 checks=["alpha"]',
      '- [x] [visual] path=/b checks=["beta"]',
      '- [X] [visual] path=/c checks=["gamma"]',
      ''
    ].join('\n'));

    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 3);
    assert.deepStrictEqual(acs.map(a => a.path), ['/a', '/b', '/c']);
    assert.deepStrictEqual(acs.map(a => a.acId), ['R001.AC1', 'R001.AC2', 'R001.AC3']);
  });

  test('malformed visual ACs without path= are skipped', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, [
      '---', 'domain: test', '---', '',
      '### R001: Test', '',
      '- [ ] [visual] viewport=800x600 checks=["no-path"]',   // bad: no path=
      '- [ ] [visual] path=/ok checks=["ok"]',
      '- [ ] no visual marker at all',
      ''
    ].join('\n'));
    const acs = parseVisualAcs(specPath);
    assert.strictEqual(acs.length, 1);
    assert.strictEqual(acs[0].path, '/ok');
  });

  test('missing file returns empty array, never throws', () => {
    const out = parseVisualAcs('/nonexistent/spec/path/spec.md');
    assert.deepStrictEqual(out, []);
  });
});

// ─── 2. runVisualVerifier happy path: writes visual_acs when all pass ────

suite('runVisualVerifier — pass path writes progress', () => {
  test('with stub bridges, every AC passes and progress file carries visual_acs', async () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });

    // Seed capabilities so the Playwright gate opens.
    fs.writeFileSync(
      path.join(forgeDir, 'capabilities.json'),
      JSON.stringify({
        mcp_servers: { 'mcp__playwright': { command: 'stub' } },
        sandbox: { browser: true, spawn: true, network: true }
      })
    );

    // Copy the mock spec into the temp project so we get deterministic
    // spec-id (basename without .md).
    const specDir = path.join(projectDir, '.forge', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, '001-readable-graph.md');
    fs.copyFileSync(MOCK_SPEC, specPath);

    // Fake PNG buffer -- content doesn't matter for record mode.
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'T020',
      specId: '001-readable-graph',
      recordBaselines: true,          // record mode -> first-run pass
      takeScreenshot: async () => ({ pngBuffer: fakePng }),
      visionCompare: async () => ({ status: 'pass', detail: 'stub' })
    });

    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.acs.length, 4);
    for (const ac of result.acs) {
      assert.strictEqual(ac.status, 'pass');
      assert.ok(ac.baseline, 'baseline must be recorded on pass');
    }

    // Progress file on disk has visual_acs array.
    const progPath = path.join(forgeDir, 'progress', 'T020.json');
    assert.ok(fs.existsSync(progPath), 'progress file must be written');
    const prog = JSON.parse(fs.readFileSync(progPath, 'utf8'));
    assert.strictEqual(prog.task_id, 'T020');
    assert.ok(Array.isArray(prog.visual_acs), 'visual_acs must be an array');
    assert.strictEqual(prog.visual_acs.length, 4);
    for (const ac of prog.visual_acs) {
      assert.strictEqual(ac.status, 'pass');
    }
  });
});

// ─── 3. Blocked: FORGE_DISABLE_PLAYWRIGHT=1 ──────────────────────────────

suite('runVisualVerifier — blocked when Playwright disabled via env', () => {
  test('FORGE_DISABLE_PLAYWRIGHT=1 -> every AC blocked, detail "playwright_unavailable"', async () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });

    // Capabilities LOOK available, but env override should win.
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

    // Simulate env var. No screenshots should be attempted.
    let screenshotCalls = 0;
    const stubEnv = Object.assign({}, process.env, { FORGE_DISABLE_PLAYWRIGHT: '1' });

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'T020',
      specId: '001-readable-graph',
      env: stubEnv,
      takeScreenshot: async () => { screenshotCalls++; return { pngBuffer: Buffer.from([0]) }; }
    });

    assert.strictEqual(screenshotCalls, 0, 'no screenshot calls when Playwright disabled');
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.capability.available, false);
    assert.strictEqual(result.capability.reason, 'playwright_unavailable');
    assert.strictEqual(result.acs.length, 4);
    for (const ac of result.acs) {
      assert.strictEqual(ac.status, 'blocked');
      assert.strictEqual(ac.detail, 'playwright_unavailable');
    }

    // Progress written with blocked visual_acs -- completion-gate compatible.
    const prog = JSON.parse(fs.readFileSync(path.join(forgeDir, 'progress', 'T020.json'), 'utf8'));
    assert.strictEqual(prog.visual_acs.length, 4);
    for (const ac of prog.visual_acs) {
      assert.strictEqual(ac.status, 'blocked');
      assert.strictEqual(ac.detail, 'playwright_unavailable');
    }
  });

  test('capabilities.sandbox.browser=false -> blocked with browser_cap_disabled', async () => {
    const { forgeDir, projectDir } = makeTempForgeDir({ seedState: false });

    fs.writeFileSync(
      path.join(forgeDir, 'capabilities.json'),
      JSON.stringify({
        mcp_servers: { 'mcp__playwright': { command: 'stub' } },
        sandbox: { browser: false, spawn: true, network: true }
      })
    );

    const specDir = path.join(projectDir, '.forge', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, '001-readable-graph.md');
    fs.copyFileSync(MOCK_SPEC, specPath);

    // Scrub any inherited FORGE_DISABLE_PLAYWRIGHT so this test only
    // exercises the caps.sandbox.browser branch.
    const cleanEnv = Object.assign({}, process.env);
    delete cleanEnv.FORGE_DISABLE_PLAYWRIGHT;

    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'T020',
      specId: '001-readable-graph',
      env: cleanEnv
    });

    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.capability.reason, 'browser_cap_disabled');
    for (const ac of result.acs) {
      assert.strictEqual(ac.status, 'blocked');
      assert.strictEqual(ac.detail, 'browser_cap_disabled');
    }
  });
});

// ─── 4. Baseline path schema ─────────────────────────────────────────────

suite('baselinePath — schema', () => {
  test('baseline file path matches .forge/baselines/<spec-id>/<rid>-<acId>.png', () => {
    const ac = { requirementId: 'R001', acId: 'R001.AC1' };
    const p = baselinePath('.forge', '001-readable-graph', ac);

    // Use forward-slash-normalised form for the shape assertion so
    // Windows path separators do not break the regex.
    const normalised = p.split(path.sep).join('/');
    assert.match(
      normalised,
      /^\.forge\/baselines\/001-readable-graph\/R001-R001\.AC1\.png$/,
      'baseline path must exactly match the documented schema'
    );
  });

  test('pass path in record mode actually writes the baseline png to disk', async () => {
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

    const magic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xAA, 0xBB]);
    const result = await runVisualVerifier(forgeDir, {
      specPath,
      taskId: 'T020',
      specId: '001-readable-graph',
      recordBaselines: true,
      takeScreenshot: async () => ({ pngBuffer: magic })
    });

    assert.strictEqual(result.status, 'pass');
    const expected = path.join(
      forgeDir, 'baselines', '001-readable-graph', 'R001-R001.AC1.png'
    );
    assert.ok(fs.existsSync(expected), 'baseline file must exist at the documented path');
    const onDisk = fs.readFileSync(expected);
    assert.ok(onDisk.equals(magic), 'baseline bytes must match the screenshot buffer');
  });
});

// ─── 5. CLI: visual-verify parse round-trips JSON ────────────────────────

suite('visual-verify CLI', () => {
  test('parse sub-action emits the parsed AC list to stdout as JSON', () => {
    const stdout = execFileSync(
      process.execPath,
      [FORGE_TOOLS_CLI, 'visual-verify', 'parse', '--spec', MOCK_SPEC],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 4);
    assert.strictEqual(parsed[0].requirementId, 'R001');
    assert.strictEqual(parsed[0].acId, 'R001.AC1');
  });
});

// ─── 6. checkVisualCapabilities unit paths ───────────────────────────────

suite('checkVisualCapabilities — gate logic', () => {
  test('env FORGE_DISABLE_PLAYWRIGHT=1 wins over healthy caps', () => {
    const caps = { mcp_servers: { 'mcp__playwright': {} }, sandbox: { browser: true } };
    const out = checkVisualCapabilities(caps, { FORGE_DISABLE_PLAYWRIGHT: '1' });
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'playwright_unavailable');
  });

  test('caps.sandbox.browser:false blocks with browser_cap_disabled', () => {
    const caps = { mcp_servers: { 'mcp__playwright': {} }, sandbox: { browser: false } };
    const out = checkVisualCapabilities(caps, {});
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'browser_cap_disabled');
  });

  test('missing playwright in mcp_servers -> playwright_unavailable', () => {
    const caps = { mcp_servers: { 'mcp__other': {} }, sandbox: { browser: true } };
    const out = checkVisualCapabilities(caps, {});
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'playwright_unavailable');
  });

  test('null caps -> assumes available (env-only gate)', () => {
    const out = checkVisualCapabilities(null, {});
    assert.strictEqual(out.available, true);
  });

  test('healthy caps + no env override -> available', () => {
    const caps = { mcp_servers: { 'mcp__playwright': {} }, sandbox: { browser: true } };
    const out = checkVisualCapabilities(caps, {});
    assert.strictEqual(out.available, true);
  });
});

// ─── 7. writeVisualProgress merges with existing progress ────────────────

suite('writeVisualProgress — merge semantics', () => {
  test('preserves existing context_bundle and adds visual_acs', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const progDir = path.join(forgeDir, 'progress');
    fs.mkdirSync(progDir, { recursive: true });
    const progPath = path.join(progDir, 'T020.json');

    // Seed an existing progress record the executor would have written.
    fs.writeFileSync(progPath, JSON.stringify({
      task_id: 'T020',
      current_step: 'review_pending',
      context_bundle: { target: 'agents/forge-visual-verifier.md' }
    }));

    writeVisualProgress(forgeDir, 'T020', [
      { acId: 'R001.AC1', status: 'pass', detail: 'ok' },
      { acId: 'R002.AC1', status: 'fail', detail: 'halo overlap' }
    ]);

    const after = JSON.parse(fs.readFileSync(progPath, 'utf8'));
    assert.strictEqual(after.current_step, 'review_pending', 'executor context preserved');
    assert.ok(after.context_bundle, 'context_bundle preserved');
    assert.strictEqual(after.context_bundle.target, 'agents/forge-visual-verifier.md');
    assert.strictEqual(after.visual_acs.length, 2);
    assert.strictEqual(after.visual_acs[0].status, 'pass');
    assert.strictEqual(after.visual_acs[1].status, 'fail');
  });
});

runTests();
