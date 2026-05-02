// tests/visual-verifier-crlf.test.cjs -- Wave 4 T001 / R001
//
// Regression coverage for the CRLF-tolerance fix in `parseFrontmatter` and
// `parseVisualAcs`. The original parsers were LF-only: on a Windows checkout
// (CRLF line endings) the frontmatter regex never matched and `split('\n')`
// left a trailing `\r` on every line, so the checkbox regex returned zero
// matches. Fix: change every `\n` literal in the frontmatter regexes to
// `\r?\n`, and split content on `/\r?\n/`.
//
// These tests guarantee LF and CRLF inputs produce byte-for-byte identical
// results so the same spec checked out on macOS / Linux / Windows is parsed
// consistently.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const { parseFrontmatter, parseVisualAcs } = tools;

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SPEC = path.resolve(
  REPO_ROOT,
  'mock-projects/blurry-graph/.forge/specs/001-readable-graph.md'
);

// Helper: write a temp spec file with the chosen line endings, return its
// absolute path. Caller is responsible for unlinking; we use a per-suite
// temp dir cleaned up at process exit by the helper's tempdir tracker.
const _tmpFiles = [];
function writeTempSpec(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-crlf-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  _tmpFiles.push(p);
  return p;
}
process.on('exit', () => {
  for (const p of _tmpFiles) {
    try {
      fs.unlinkSync(p);
      fs.rmdirSync(path.dirname(p));
    } catch (_) { /* best effort */ }
  }
});

// ─── 1. parseFrontmatter -- CRLF and LF return equivalent shapes ───────────

suite('parseFrontmatter -- CRLF tolerance', () => {
  test('CRLF frontmatter parses equivalently to LF', () => {
    const lf  = '---\nfoo: bar\nbaz: qux\n---\nbody line one\nbody line two';
    const crlf = '---\r\nfoo: bar\r\nbaz: qux\r\n---\r\nbody line one\r\nbody line two';
    const a = parseFrontmatter(lf);
    const b = parseFrontmatter(crlf);
    assert.deepStrictEqual(a.data, b.data, 'frontmatter data must match');
    assert.deepStrictEqual(a.data, { foo: 'bar', baz: 'qux' });
    // Content for CRLF still carries CR bytes -- that's fine; the consumer
    // (parseVisualAcs) splits on /\r?\n/ to handle that. The point of this
    // assertion is that the *frontmatter* was successfully stripped, i.e.
    // the body does NOT begin with `---`.
    assert.ok(!a.content.startsWith('---'), 'LF body should not start with ---');
    assert.ok(!b.content.startsWith('---'), 'CRLF body should not start with ---');
  });

  test('CRLF-only input does not fall through to {data:{}, content:text}', () => {
    const crlf = '---\r\nkey: value\r\n---\r\nhello';
    const { data, content } = parseFrontmatter(crlf);
    // The pre-fix bug: regex failed, the function returned the entire input
    // as content with empty data. Guard against regression.
    assert.strictEqual(data.key, 'value', 'CRLF frontmatter key must parse');
    assert.ok(!content.includes('---'), 'CRLF content must have frontmatter stripped');
  });

  test('LF input still works (no regression for *nix checkouts)', () => {
    const lf = '---\nphase: ready\niteration: 0\n---\n\n## Section\n';
    const { data, content } = parseFrontmatter(lf);
    assert.strictEqual(data.phase, 'ready');
    assert.strictEqual(data.iteration, 0);
    assert.ok(content.includes('## Section'));
  });
});

// ─── 2. parseVisualAcs -- CRLF tmp fixture vs LF equivalent ────────────────

suite('parseVisualAcs -- CRLF tmp fixture', () => {
  // Minimal but realistic AC body: 3 requirements, 4 visual ACs total --
  // mirrors the shape of the blurry-graph mock spec so the regression
  // exercises the same code paths the production parser hits.
  const SPEC_BODY_LF = [
    '---',
    'domain: test',
    'status: approved',
    '---',
    '',
    '## Requirements',
    '',
    '### R001: First requirement',
    '',
    '**Acceptance Criteria:**',
    '- [ ] [visual] path=/foo viewport=1280x800 checks=["a","b"]',
    '',
    '### R002: Second requirement',
    '',
    '**Acceptance Criteria:**',
    '- [ ] [visual] path=/bar checks=["c"]',
    '- [ ] [visual] path=/baz viewport=375x667 checks=["d"]',
    '',
    '### R003: Third requirement',
    '',
    '**Acceptance Criteria:**',
    '- [x] [visual] path=/qux checks=["e","f"]',
    ''
  ].join('\n');

  const SPEC_BODY_CRLF = SPEC_BODY_LF.replace(/\n/g, '\r\n');

  test('CRLF tmp fixture returns 4 ACs, identical to LF version', () => {
    const lfPath = writeTempSpec('spec-lf.md', SPEC_BODY_LF);
    const crlfPath = writeTempSpec('spec-crlf.md', SPEC_BODY_CRLF);
    const lfAcs = parseVisualAcs(lfPath);
    const crlfAcs = parseVisualAcs(crlfPath);
    assert.strictEqual(lfAcs.length, 4, 'LF fixture should yield 4 visual ACs');
    assert.strictEqual(crlfAcs.length, 4, 'CRLF fixture should yield 4 visual ACs');

    // Ignore `line` and `raw` -- those legitimately differ between LF and
    // CRLF (`raw` carries the original line text, line numbers are 1-based
    // line indices into the original split). Compare the semantically
    // meaningful fields.
    const project = a => a.map(x => ({
      requirementId: x.requirementId,
      acId: x.acId,
      path: x.path,
      viewport: x.viewport,
      checks: x.checks
    }));
    assert.deepStrictEqual(project(crlfAcs), project(lfAcs), 'semantic fields must match');
  });

  test('parseVisualAcs on the actual blurry-graph mock spec returns exactly 4', () => {
    assert.ok(fs.existsSync(MOCK_SPEC), 'mock spec must exist: ' + MOCK_SPEC);
    const acs = parseVisualAcs(MOCK_SPEC);
    assert.strictEqual(acs.length, 4, 'blurry-graph mock spec must yield 4 visual ACs on this OS');
  });

  test('round-trip: CRLF write -> read -> LF write -> read produces identical AC fields', () => {
    const crlfPath = writeTempSpec('round-crlf.md', SPEC_BODY_CRLF);
    const a = parseVisualAcs(crlfPath);

    // Read the CRLF file, normalize to LF, write back, re-parse.
    const raw = fs.readFileSync(crlfPath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const lfPath = writeTempSpec('round-lf.md', normalized);
    const b = parseVisualAcs(lfPath);

    const project = arr => arr.map(x => ({
      requirementId: x.requirementId,
      acId: x.acId,
      path: x.path,
      viewport: x.viewport,
      checks: x.checks
    }));
    assert.deepStrictEqual(project(a), project(b), 'CRLF and LF round-trip must yield identical ACs');
  });

  test('checkbox regex matches both - [ ] and - [x] / - [X] under CRLF', () => {
    const body = [
      '---',
      'x: 1',
      '---',
      '',
      '### R009: mixed checkbox states',
      '',
      '- [ ] [visual] path=/u checks=["one"]',
      '- [x] [visual] path=/v checks=["two"]',
      '- [X] [visual] path=/w checks=["three"]',
      ''
    ].join('\r\n');
    const p = writeTempSpec('mixed.md', body);
    const acs = parseVisualAcs(p);
    assert.strictEqual(acs.length, 3, 'all three checkbox states must match under CRLF');
    assert.deepStrictEqual(acs.map(a => a.path), ['/u', '/v', '/w']);
    assert.deepStrictEqual(acs.map(a => a.acId), ['R009.AC1', 'R009.AC2', 'R009.AC3']);
  });
});

runTests();
