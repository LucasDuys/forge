// tests/caveman-whitelist.test.cjs -- T007 / R015
//
// Whitelist enforcement + round-trip semantic-schema preservation + the
// compression-stats ledger that feeds /forge:status.

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const {
  assertCavemanWhitelist,
  isCavemanAllowedPath,
  formatCavemanValue,
  compressWithGuard,
  recordCompressionStats,
  readCompressionStats,
  writeState,
  readState,
  writeCheckpoint,
  writeArtifact,
  readArtifact
} = tools;

// ─── 1. Whitelist allow list ──────────────────────────────────────────────

suite('caveman whitelist allow list (R015 AC1)', () => {
  test('.forge/state.md is allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/state.md'), true);
    assert.doesNotThrow(() => assertCavemanWhitelist('.forge/state.md'));
  });

  test('.forge/progress/<task>.json is allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/progress/T042.json'), true);
    assert.doesNotThrow(() => assertCavemanWhitelist('.forge/progress/T042.json'));
  });

  test('.forge/artifacts/<task>.json is allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/artifacts/T042.json'), true);
  });

  test('.forge/context-bundles/<task>.md is allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/context-bundles/T007.md'), true);
  });

  test('.forge/summaries/** is allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/summaries/review-2026-04-20.md'), true);
    assert.strictEqual(isCavemanAllowedPath('.forge/summaries/nested/whatever.md'), true);
  });

  test('.forge/history/cycles/**/review-*.md is allowed', () => {
    assert.strictEqual(
      isCavemanAllowedPath('.forge/history/cycles/2026-04-20T12-00Z/review-notes.md'),
      true
    );
    assert.strictEqual(
      isCavemanAllowedPath('.forge/history/cycles/2026-04-20T12-00Z/summary.md'),
      true
    );
  });

  test('.forge/resume.md + .forge/context-summary.md are allowed', () => {
    assert.strictEqual(isCavemanAllowedPath('.forge/resume.md'), true);
    assert.strictEqual(isCavemanAllowedPath('.forge/context-summary.md'), true);
  });

  test('accepts backslash paths (Windows normalisation)', () => {
    assert.doesNotThrow(() => assertCavemanWhitelist('.forge\\state.md'));
    assert.strictEqual(isCavemanAllowedPath('.forge\\progress\\T001.json'), true);
  });
});

// ─── 2. Whitelist deny list ───────────────────────────────────────────────

suite('caveman whitelist deny list (R015 AC1 + AC3)', () => {
  test('commit messages (.gitmessage / COMMIT_EDITMSG) are blocked', () => {
    assert.throws(
      () => assertCavemanWhitelist('.git/COMMIT_EDITMSG'),
      /hard-blocked|whitelist/
    );
  });

  test('source code extensions are hard-blocked', () => {
    for (const p of [
      'src/main.js',
      'scripts/forge-tools.cjs',
      'lib/thing.ts',
      'app/x.tsx',
      'foo.py',
      'pkg/file.go'
    ]) {
      assert.throws(() => assertCavemanWhitelist(p), /hard-blocked/, `expected ${p} blocked`);
    }
  });

  test('YAML + config extensions are hard-blocked', () => {
    assert.throws(() => assertCavemanWhitelist('.github/workflows/ci.yml'), /hard-blocked/);
    assert.throws(() => assertCavemanWhitelist('config/settings.yaml'), /hard-blocked/);
    assert.throws(() => assertCavemanWhitelist('pyproject.toml'), /hard-blocked/);
  });

  test('spec + doc trees are blocked by prefix', () => {
    assert.throws(
      () => assertCavemanWhitelist('docs/superpowers/specs/spec-x.md'),
      /hard-blocked|whitelist/
    );
    assert.throws(() => assertCavemanWhitelist('.forge/specs/spec-y.md'), /hard-blocked|whitelist/);
    assert.throws(() => assertCavemanWhitelist('docs/README.md'), /hard-blocked|whitelist/);
  });

  test('skills + commands trees are blocked', () => {
    assert.throws(() => assertCavemanWhitelist('skills/caveman-internal/SKILL.md'), /hard-blocked/);
    assert.throws(() => assertCavemanWhitelist('commands/execute.md'), /hard-blocked/);
  });

  test('unknown .forge/ subpaths fall back to deny', () => {
    assert.throws(() => assertCavemanWhitelist('.forge/custom/rando.md'), /whitelist/);
    assert.throws(() => assertCavemanWhitelist('.forge/config.json'), /whitelist/);
    assert.throws(() => assertCavemanWhitelist('.forge/token-ledger.json'), /whitelist/);
  });

  test('empty, non-string, and junk paths throw with clear messages', () => {
    assert.throws(() => assertCavemanWhitelist(''), /empty or non-string/);
    assert.throws(() => assertCavemanWhitelist(null), /empty or non-string/);
    assert.throws(() => assertCavemanWhitelist(undefined), /empty or non-string/);
    assert.throws(() => assertCavemanWhitelist(42), /empty or non-string/);
  });

  test('error message names the offending path', () => {
    try {
      assertCavemanWhitelist('src/evil.ts');
      assert.fail('expected throw');
    } catch (e) {
      assert.match(e.message, /src\/evil\.ts/);
    }
  });
});

// ─── 3. Round-trip schema preservation (R015 AC2) ─────────────────────────
//
// The caveman skill declares compression as lexical, not semantic, with a
// strict rule (SKILL.md Rule 2) that identifiers, file paths, function
// names, version strings, error codes, and quoted user input MUST survive
// byte-identical. That is the schema the round-trip test enforces: for
// every representative artifact type, compress it and then assert the
// schema-preserved tokens come through untouched.

suite('caveman round-trip schema preservation (R015 AC2)', () => {
  // Representative artifacts covering every whitelist path type.
  const ARTIFACTS = [
    {
      label: 'handoff note (context bundle)',
      path: '.forge/context-bundles/T007.md',
      text: [
        'Task T007 depends on T003 and consumes register_endpoint.',
        'Files modified: scripts/forge-tools.cjs at line 1720.',
        'Decision: call writeCheckpoint() with skipCavemanFormat=false by default.',
        'Version bumped from v0.2.0 to v0.3.0-rc.1; error code ERR_TOKEN_EXHAUSTED preserved.'
      ].join('\n'),
      schema: [
        'T007', 'T003', 'register_endpoint',
        'scripts/forge-tools.cjs', '1720',
        'writeCheckpoint()', 'skipCavemanFormat=false',
        'v0.2.0', 'v0.3.0-rc.1', 'ERR_TOKEN_EXHAUSTED'
      ]
    },
    {
      label: 'state.md body',
      path: '.forge/state.md',
      text: [
        '## What\'s Done',
        '- T001: collab .gitignore carve-out (commit abc1234)',
        '- T006: skills-audit via scripts/forge-tools.cjs skills-audit',
        '',
        '## Key Decisions',
        '- Chose bcrypt 12 rounds for password hashing in src/auth.ts'
      ].join('\n'),
      schema: ['T001', 'T006', 'abc1234', 'scripts/forge-tools.cjs', 'skills-audit', 'bcrypt', 'src/auth.ts']
    },
    {
      label: 'summary / review report',
      path: '.forge/summaries/review-cycle-042.md',
      text: [
        '# Review cycle 42',
        'Tasks reviewed: T013, T019, T022.',
        'Findings: forge-collab.cjs:494 subscribe() delivers to all subscribers (O006).',
        'Action: open backprop ticket BP-17 against spec R004.'
      ].join('\n'),
      schema: ['T013', 'T019', 'T022', 'forge-collab.cjs:494', 'subscribe()', 'O006', 'BP-17', 'R004']
    },
    {
      label: 'review report inside history/cycles',
      path: '.forge/history/cycles/2026-04-20T12-00Z/review-notes.md',
      text: [
        'Reviewer noted that assertCavemanWhitelist() returns void.',
        'File paths seen: scripts/forge-status-block.cjs, scripts/forge-tools.cjs:706.',
        'Token: "I just finished the implementation." must compress.'
      ].join('\n'),
      schema: [
        'assertCavemanWhitelist()',
        'scripts/forge-status-block.cjs',
        'scripts/forge-tools.cjs:706'
      ]
    },
    {
      label: 'resume.md handoff',
      path: '.forge/resume.md',
      text: 'Budget exhausted at task T029; resume from scripts/forge-runner.sh --resume.',
      schema: ['T029', 'scripts/forge-runner.sh', '--resume']
    }
  ];

  for (const art of ARTIFACTS) {
    test(`${art.label}: schema tokens survive compression`, () => {
      // 1. Whitelist check must pass for this path.
      assert.doesNotThrow(() => assertCavemanWhitelist(art.path));
      // 2. Compress.
      const compressed = formatCavemanValue(art.text);
      assert.ok(typeof compressed === 'string', 'compressed output must be a string');
      // 3. Every declared schema token appears byte-identical in the output.
      for (const token of art.schema) {
        assert.ok(
          compressed.indexOf(token) !== -1,
          `schema token ${JSON.stringify(token)} lost during compression of ${art.label}. ` +
            `Before: ${JSON.stringify(art.text)}  After: ${JSON.stringify(compressed)}`
        );
      }
      // 4. Verbose sentinel yields byte-identical output (the strict-lossless
      //    path the skill docs describe).
      const sentinel = '<!-- verbose -->\n' + art.text;
      assert.strictEqual(formatCavemanValue(sentinel), sentinel,
        `verbose-sentinel round-trip must be byte-identical for ${art.label}`);
    });
  }

  test('code fences survive untouched (extra byte-identical guarantee)', () => {
    const art = 'Summary:\n```js\nconst the = a + an;\n```\nDone.';
    const compressed = formatCavemanValue(art);
    assert.ok(
      compressed.indexOf('const the = a + an;') !== -1,
      'fenced code must pass through untouched'
    );
  });
});

// ─── 4. Writer integration (R015 AC3) ─────────────────────────────────────
//
// The four whitelisted writers (writeState, writeCheckpoint, writeArtifact,
// writeContextBundle) go through the guard. Non-whitelisted use throws.

suite('caveman guard at writer integration (R015 AC3)', () => {
  test('compressWithGuard throws for non-whitelisted path', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(
      () => compressWithGuard(forgeDir, 'src/evil.ts', 'some text'),
      /hard-blocked|whitelist/
    );
  });

  test('compressWithGuard passes through on skipCavemanFormat', () => {
    const { forgeDir } = makeTempForgeDir();
    const out = compressWithGuard(forgeDir, 'src/evil.ts', 'some text', { skipCavemanFormat: true });
    assert.strictEqual(out, 'some text');
  });

  test('writeState accepts state.md body (whitelist allow)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    assert.doesNotThrow(() =>
      writeState(forgeDir, { phase: 'executing' }, 'I just finished the work.')
    );
    const state = readState(forgeDir);
    assert.doesNotMatch(state.content, /\bjust\b/);
  });

  test('writeArtifact compresses only string artifact values', () => {
    const { forgeDir } = makeTempForgeDir();
    writeArtifact(forgeDir, 'T007', {
      artifacts: {
        caveman_whitelist: 'I just really finished implementing the whitelist guard in scripts/forge-tools.cjs.'
      },
      files_modified: ['scripts/forge-tools.cjs']
    });
    const a = readArtifact(forgeDir, 'T007');
    assert.ok(a, 'artifact must write');
    assert.doesNotMatch(a.artifacts.caveman_whitelist, /\bjust\b/);
    // File paths preserved byte-identical.
    assert.ok(a.artifacts.caveman_whitelist.indexOf('scripts/forge-tools.cjs') !== -1);
  });

  test('writeCheckpoint writes to progress/*.json (whitelisted)', () => {
    const { forgeDir } = makeTempForgeDir();
    const cp = {
      task_id: 'T007',
      current_step: 'implementation_started',
      next_step: 'tests_written',
      context_bundle: {
        note: 'I just finished the whitelist guard in scripts/forge-tools.cjs at line 706.'
      }
    };
    assert.doesNotThrow(() => writeCheckpoint(forgeDir, 'T007', cp));
    const written = JSON.parse(fs.readFileSync(path.join(forgeDir, 'progress', 'T007.json'), 'utf8'));
    assert.doesNotMatch(written.context_bundle.note, /\bjust\b/);
    assert.ok(written.context_bundle.note.indexOf('scripts/forge-tools.cjs') !== -1);
  });
});

// ─── 5. Compression stats ledger (R015 AC4) ──────────────────────────────

suite('compression stats ledger fuels /forge:status (R015 AC4)', () => {
  test('recordCompressionStats creates per-cycle totals', () => {
    const { forgeDir } = makeTempForgeDir();
    // Seed a current_cycle via state.md so the ledger keys off that.
    writeState(forgeDir, { phase: 'executing', current_cycle: 'cycle-1' }, 'seed');

    recordCompressionStats(forgeDir, '.forge/state.md', 1000, 700);
    recordCompressionStats(forgeDir, '.forge/artifacts/T1.json', 200, 100);

    const stats = readCompressionStats(forgeDir);
    assert.ok(stats.cycles['cycle-1'], 'cycle entry present');
    assert.strictEqual(stats.cycles['cycle-1'].bytes_before, 1200);
    assert.strictEqual(stats.cycles['cycle-1'].bytes_after, 800);
    assert.strictEqual(stats.cycles['cycle-1'].bytes_saved, 400);
    assert.strictEqual(stats.cycles['cycle-1'].artifact_count, 2);
  });

  test('writeState populates the ledger end-to-end', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    // First write establishes frontmatter (current_cycle). Second write is
    // what the scheduler does during a real run, and the ledger keys off
    // the frontmatter of the state file that exists at write time.
    writeState(forgeDir, { phase: 'exec', current_cycle: 'cycle-x' }, 'seed', { skipCavemanFormat: true });
    writeState(forgeDir, { __contentAppend:
      'I just really finished implementing the whitelist. Basically, the code is in scripts/forge-tools.cjs.\n'
    });
    const stats = readCompressionStats(forgeDir);
    assert.ok(stats.cycles['cycle-x'], 'cycle-x entry present');
    assert.ok(stats.cycles['cycle-x'].bytes_before > 0);
    assert.ok(stats.cycles['cycle-x'].bytes_saved >= 0);
  });

  test('writeArtifact populates the ledger', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'exec', current_cycle: 'cyc' }, 'x', { skipCavemanFormat: true });
    writeArtifact(forgeDir, 'T007', {
      artifacts: { note: 'I just really basically implemented the thing in scripts/forge-tools.cjs.' }
    });
    const stats = readCompressionStats(forgeDir);
    assert.ok(stats.cycles['cyc'], 'cycle entry present');
    assert.ok(stats.cycles['cyc'].artifact_count >= 1);
  });

  test('ledger writes are additive across call sites in the same cycle', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'exec', current_cycle: 'agg' }, 'x', { skipCavemanFormat: true });
    writeArtifact(forgeDir, 'T1', {
      artifacts: { a: 'really really really really really really really long text to compress.' }
    });
    writeArtifact(forgeDir, 'T2', {
      artifacts: { a: 'basically basically basically basically compress me too.' }
    });
    const stats = readCompressionStats(forgeDir);
    assert.ok(stats.cycles['agg'].artifact_count >= 2);
    assert.ok(stats.cycles['agg'].bytes_saved >= 0);
  });

  test('status-block surfaces Caveman line when ledger has data', () => {
    // End-to-end: build a temp forge, write some compressed artifacts, run
    // the status block script, and confirm the Caveman line appears.
    const { projectDir, forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'exec', current_cycle: 'cyc-42' }, 'seed', { skipCavemanFormat: true });
    writeArtifact(forgeDir, 'T999', {
      artifacts: {
        note: 'I really just basically finished implementing the whitelist in scripts/forge-tools.cjs.'
      }
    });
    const { execFileSync } = require('node:child_process');
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'forge-status-block.cjs');
    const out = execFileSync(
      process.execPath,
      [scriptPath, '--forge-dir', forgeDir, '--no-color'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.match(out, /Caveman/, 'status block should print a Caveman line when stats exist');
    assert.match(out, /saved/, 'status block should report bytes saved');
  });
});

runTests();
