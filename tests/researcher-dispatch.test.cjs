// tests/researcher-dispatch.test.cjs -- T014 / R005
//
// Exercises the parallel forge-researcher dispatch added to the brainstorming
// skill plus the research aggregator that backs it.
//
// The feature splits cleanly in two:
//   1. Code side -- scripts/forge-research-aggregator.cjs writes research
//      sections in stable order, dedupes duplicate headings by appending
//      `(2)`, `(3)`, ..., and maintains a YAML frontmatter header.
//   2. Skill side -- skills/brainstorming/SKILL.md documents when to dispatch,
//      what config flag gates the dispatch, and what the fallback is when the
//      Agent tool is unavailable. These are prose invariants the runtime keys
//      off; the tests here assert the anchors exist so an agent cannot
//      silently drop the behaviour.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS_CJS = path.join(REPO_ROOT, 'scripts', 'forge-tools.cjs');
const AGGREGATOR_CJS = path.join(REPO_ROOT, 'scripts', 'forge-research-aggregator.cjs');
const SKILL_MD = path.join(REPO_ROOT, 'skills', 'brainstorming', 'SKILL.md');

const {
  appendResearchSection,
  readResearchFile,
  _researchFilePath
} = require(AGGREGATOR_CJS);

// ─── aggregator unit tests ────────────────────────────────────────────────

suite('forge-research-aggregator', () => {
  test('first append creates file with YAML frontmatter and Section 1', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Dagster asset graph',
      body: 'Treats each data asset as a node; edges are causal.',
      sources: ['https://dagster.io/docs', 'docs/audit/research/streaming-dag.md#dagster']
    });
    assert.equal(r.created, true);
    assert.equal(r.section_number, 1);
    assert.equal(r.heading, 'Dagster asset graph');

    const text = fs.readFileSync(r.path, 'utf8');
    // frontmatter present, with spec + sections:1
    assert.ok(/^---\n/.test(text), 'starts with YAML frontmatter');
    assert.match(text, /spec: demo-spec/);
    assert.match(text, /sections: 1/);
    assert.match(text, /created: \d{4}-\d{2}-\d{2}/);
    // section heading with ordinal
    assert.match(text, /## Section 1: Dagster asset graph/);
    // body + sources block
    assert.match(text, /Treats each data asset as a node/);
    assert.match(text, /\*\*Sources:\*\*/);
    assert.match(text, /- https:\/\/dagster\.io\/docs/);
    assert.match(text, /- docs\/audit\/research\/streaming-dag\.md#dagster/);
  });

  test('multiple appends write sections in stable, monotonic order', () => {
    const { forgeDir } = makeTempForgeDir();
    const a = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Approach A', body: 'First approach body.', sources: ['src-a']
    });
    const b = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Approach B', body: 'Second approach body.', sources: ['src-b']
    });
    const c = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Approach C', body: 'Third approach body.', sources: ['src-c']
    });
    assert.deepEqual([a.section_number, b.section_number, c.section_number], [1, 2, 3]);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(c.created, false);

    const parsed = readResearchFile(forgeDir, 'demo-spec');
    assert.equal(parsed.sections.length, 3);
    assert.deepEqual(parsed.sections.map(s => s.n), [1, 2, 3]);
    assert.deepEqual(parsed.sections.map(s => s.heading), ['Approach A', 'Approach B', 'Approach C']);
    assert.equal(parsed.data.sections, 3);

    // In the raw file the sections appear in order by byte offset.
    const text = fs.readFileSync(parsed.path, 'utf8');
    const idxA = text.indexOf('## Section 1: Approach A');
    const idxB = text.indexOf('## Section 2: Approach B');
    const idxC = text.indexOf('## Section 3: Approach C');
    assert.ok(idxA > 0 && idxB > idxA && idxC > idxB, 'sections ordered by byte offset');
  });

  test('duplicate heading gets "(2)" suffix; triple dup gets "(3)"', () => {
    const { forgeDir } = makeTempForgeDir();
    const a = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Dagster asset graph', body: 'first take'
    });
    const b = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Dagster asset graph', body: 'second take, refined'
    });
    const c = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Dagster asset graph', body: 'third take'
    });
    assert.equal(a.heading, 'Dagster asset graph');
    assert.equal(b.heading, 'Dagster asset graph (2)');
    assert.equal(c.heading, 'Dagster asset graph (3)');

    const parsed = readResearchFile(forgeDir, 'demo-spec');
    assert.deepEqual(
      parsed.sections.map(s => s.heading),
      ['Dagster asset graph', 'Dagster asset graph (2)', 'Dagster asset graph (3)']
    );

    // Dedupe is case-insensitive so casing variations still collide.
    const d = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'DAGSTER ASSET GRAPH', body: 'fourth take, shouting'
    });
    assert.equal(d.heading, 'DAGSTER ASSET GRAPH (4)');
  });

  test('sources optional; body-only section still renders', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Plain note', body: 'no sources for this one'
    });
    const text = fs.readFileSync(r.path, 'utf8');
    assert.match(text, /## Section 1: Plain note/);
    assert.match(text, /no sources for this one/);
    // No sources block when sources array is empty.
    assert.ok(!/\*\*Sources:\*\*/.test(text), 'no sources header when sources empty');
  });

  test('readResearchFile returns null when file does not exist', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = readResearchFile(forgeDir, 'no-such-spec');
    assert.equal(r, null);
  });

  test('specId with path separators is rejected', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(() =>
      appendResearchSection(forgeDir, '../escape', { heading: 'x', body: 'y' })
    , /path separators/);
    assert.throws(() =>
      appendResearchSection(forgeDir, 'a/b', { heading: 'x', body: 'y' })
    , /path separators/);
  });

  test('heading is required', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(() =>
      appendResearchSection(forgeDir, 'demo-spec', { heading: '', body: 'x' })
    , /heading is required/);
  });

  test('research file location matches spec contract', () => {
    const { forgeDir } = makeTempForgeDir();
    appendResearchSection(forgeDir, 'forge-v03-gaps', {
      heading: 'h', body: 'b'
    });
    const expected = path.join(forgeDir, 'specs', 'forge-v03-gaps.research.md');
    assert.ok(fs.existsSync(expected), 'file lands at .forge/specs/<spec>.research.md');
  });

  test('sections containing markdown subheadings are preserved', () => {
    const { forgeDir } = makeTempForgeDir();
    const body = [
      '### Trade-offs',
      '- pros: simple',
      '- cons: latency',
      '',
      '### Prior art',
      'Airflow 2.x does this.'
    ].join('\n');
    appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'Multi-part finding', body
    });
    const parsed = readResearchFile(forgeDir, 'demo-spec');
    assert.equal(parsed.sections.length, 1);
    assert.match(parsed.sections[0].body, /### Trade-offs/);
    assert.match(parsed.sections[0].body, /### Prior art/);
    assert.match(parsed.sections[0].body, /Airflow 2\.x does this\./);
  });

  test('frontmatter sections count stays in sync with body', () => {
    const { forgeDir } = makeTempForgeDir();
    for (let i = 1; i <= 5; i++) {
      appendResearchSection(forgeDir, 'demo-spec', {
        heading: 'H' + i, body: 'B' + i
      });
    }
    const text = fs.readFileSync(_researchFilePath(forgeDir, 'demo-spec'), 'utf8');
    assert.match(text, /sections: 5/);
    const parsed = readResearchFile(forgeDir, 'demo-spec');
    assert.equal(parsed.data.sections, 5);
    assert.equal(parsed.sections.length, 5);
  });
});

// ─── research-append CLI (shell bridge) ──────────────────────────────────

suite('research-append CLI', () => {
  test('--spec --heading --body-file writes section to research file', () => {
    const { forgeDir, projectDir } = makeTempForgeDir();
    const bodyPath = path.join(projectDir, 'research-body.md');
    fs.writeFileSync(bodyPath,
      '### Summary\nDagster-style asset graph suits per-AC streaming because ...');

    const r = spawnSync(process.execPath, [
      TOOLS_CJS, 'research-append',
      '--spec', 'demo-spec',
      '--heading', 'Dagster asset graph',
      '--body-file', bodyPath,
      '--sources', 'https://dagster.io/docs,docs/audit/research/streaming-dag.md#dagster',
      '--forge-dir', forgeDir
    ], { encoding: 'utf8' });

    assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.section_number, 1);
    assert.equal(out.heading, 'Dagster asset graph');

    const parsed = readResearchFile(forgeDir, 'demo-spec');
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0].sources.length, 2);
    assert.ok(parsed.sections[0].sources.includes('https://dagster.io/docs'));
  });

  test('CLI rejects missing --spec with exit 2', () => {
    const { forgeDir, projectDir } = makeTempForgeDir();
    const bodyPath = path.join(projectDir, 'b.md');
    fs.writeFileSync(bodyPath, 'x');
    const r = spawnSync(process.execPath, [
      TOOLS_CJS, 'research-append',
      '--heading', 'h',
      '--body-file', bodyPath,
      '--forge-dir', forgeDir
    ], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--spec is required/);
  });

  test('CLI fails gracefully when --body-file missing on disk', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = spawnSync(process.execPath, [
      TOOLS_CJS, 'research-append',
      '--spec', 'demo',
      '--heading', 'h',
      '--body-file', path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.md'),
      '--forge-dir', forgeDir
    ], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read --body-file/);
  });
});

// ─── skill-level invariant tests (prose anchors the runtime reads) ──────

suite('brainstorming skill: parallel research dispatch documented', () => {
  const skillText = fs.readFileSync(SKILL_MD, 'utf8');

  test('skill declares a Parallel research dispatch phase', () => {
    assert.match(skillText, /Parallel research dispatch/i,
      'skill must document the dispatch phase by name');
  });

  test('skill names forge-researcher as the subagent', () => {
    assert.match(skillText, /forge-researcher/,
      'skill must name forge-researcher as the dispatched subagent');
  });

  test('skill mandates run_in_background: true', () => {
    assert.match(skillText, /run_in_background:\s*true/,
      'skill must mandate run_in_background: true on dispatch');
  });

  test('skill documents dispatch after question 2 and after question 4', () => {
    // The two dispatch points per R005 AC1 and AC2.
    assert.match(skillText, /after question 2/i);
    assert.match(skillText, /after question 4/i);
  });

  test('skill declares output path at .forge/specs/<spec-id>.research.md', () => {
    assert.match(skillText, /\.forge\/specs\/<spec-id>\.research\.md/,
      'skill must document the research-file output path');
  });

  test('skill references the named citation pattern used at proposal stage', () => {
    // AC4: citations must be named, e.g. per docs/audit/research/streaming-dag.md#dagster
    assert.match(skillText, /docs\/audit\/research\/streaming-dag\.md#dagster/,
      'skill must show a concrete named-citation example');
  });

  test('skill gates the whole dispatch behind brainstorm.web_search_enabled', () => {
    assert.match(skillText, /brainstorm\.web_search_enabled/,
      'skill must gate dispatch on the brainstorm.web_search_enabled config flag');
    // Must state the default.
    assert.match(skillText, /default[^\n]{0,80}[`]?true[`]?/i,
      'skill must document the default of brainstorm.web_search_enabled');
  });

  test('skill documents fallback when Agent tool unavailable', () => {
    // AC6: fallback, note absence rather than silent skip.
    assert.match(skillText, /Agent tool[^\n]+not available|Agent tool[^\n]+unavailable|Agent tool[^\n]+missing/i,
      'skill must describe the Agent-tool-unavailable fallback');
    assert.match(skillText, /no research file available/i,
      'skill must require the proposal stage to note the absence explicitly');
  });

  test('skill uses the research-append CLI bridge', () => {
    assert.match(skillText, /research-append/,
      'skill must reference the research-append CLI bridge used to persist results');
  });
});

// ─── dispatch behaviour under the config flag (indirect, skill contract) ──

suite('brainstorming skill: web_search_enabled=false disables dispatch', () => {
  // The skill is prose; we cannot run it directly. We verify the prose
  // instructs the runtime to *skip dispatch entirely* and *note the disable
  // in the spec* when brainstorm.web_search_enabled is false.
  const skillText = fs.readFileSync(SKILL_MD, 'utf8');

  test('skill instructs to skip the phase when flag is false', () => {
    // Phrasing freedom allowed; must mention skip/skipped/disabled alongside
    // the flag in the same section.
    const dispatchSection = skillText.split(/^###\s+/m)
      .find(s => /Parallel research dispatch/i.test(s));
    assert.ok(dispatchSection, 'dispatch section present');
    assert.match(dispatchSection, /web_search_enabled.*false|false.*web_search_enabled/s);
    assert.match(dispatchSection, /skip/i);
  });

  test('skill requires a spec-visible note when dispatch is disabled', () => {
    const dispatchSection = skillText.split(/^###\s+/m)
      .find(s => /Parallel research dispatch/i.test(s));
    assert.match(dispatchSection, /Future Considerations|spec|note/i,
      'skill must say the disabled state is recorded somewhere user-visible');
  });
});

// ─── file format contract (YAML frontmatter + Section + sources) ─────────

suite('research file markdown format contract', () => {
  test('full file matches the documented contract', () => {
    const { forgeDir } = makeTempForgeDir();
    appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'H1', body: 'body of H1', sources: ['s1', 's2']
    });
    appendResearchSection(forgeDir, 'demo-spec', {
      heading: 'H2', body: 'body of H2', sources: []
    });
    const text = fs.readFileSync(_researchFilePath(forgeDir, 'demo-spec'), 'utf8');

    // 1. starts with YAML frontmatter.
    assert.ok(text.startsWith('---\n'), 'leading frontmatter delimiter');
    const fmEnd = text.indexOf('\n---\n', 4);
    assert.ok(fmEnd > 0, 'trailing frontmatter delimiter');

    // 2. frontmatter contains spec, created, sections keys.
    const fm = text.slice(4, fmEnd);
    assert.match(fm, /^spec: demo-spec$/m);
    assert.match(fm, /^created: \d{4}-\d{2}-\d{2}$/m);
    assert.match(fm, /^sections: 2$/m);

    // 3. body contains exactly 2 Section headers, with ordinals 1 and 2.
    const headerRe = /^## Section (\d+): (.+)$/gm;
    const hs = [...text.matchAll(headerRe)];
    assert.equal(hs.length, 2);
    assert.equal(hs[0][1], '1');
    assert.equal(hs[1][1], '2');
    assert.equal(hs[0][2].trim(), 'H1');
    assert.equal(hs[1][2].trim(), 'H2');

    // 4. H1 has a sources bullet list with exactly 2 items.
    const afterH1 = text.slice(hs[0].index, hs[1].index);
    assert.match(afterH1, /\*\*Sources:\*\*/);
    const bulletCount = (afterH1.match(/\n- /g) || []).length;
    assert.equal(bulletCount, 2);

    // 5. H2 has no sources block (empty sources array = omit entirely).
    const afterH2 = text.slice(hs[1].index);
    assert.ok(!/\*\*Sources:\*\*/.test(afterH2), 'H2 has no sources block when empty');
  });
});

runTests();
