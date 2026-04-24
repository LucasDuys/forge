// tests/spec-path-validation.test.cjs -- forge-speccer-validator (R011 / T004)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { suite, test, assert, runTests } = require('./_helper.cjs');
const {
  validateSpecPaths,
  findNearestPath,
  extractPathTokens,
  PATH_RE
} = require('../scripts/forge-speccer-validator.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_REPO = path.join(REPO_ROOT, 'mock-projects', 'blurry-graph');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function writeSpec(tmpDir, name, body) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, body);
  return p;
}

function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-speccer-validator-'));
  // best-effort cleanup at exit
  process.on('exit', () => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  });
  return d;
}

// -----------------------------------------------------------------------------
// suite
// -----------------------------------------------------------------------------

suite('validateSpecPaths — valid', () => {
  test('spec with only valid paths returns valid:true and empty missing', () => {
    const tmp = mkTmp();
    const specBody = `# Valid Spec

This spec references \`src/App.tsx\` and \`src/config.ts\` and \`package.json\`.

\`\`\`
src/main.tsx
vite.config.ts
\`\`\`

URL reference https://example.com/path.md should be ignored.
Version 1.2.3 should be ignored.
`;
    const specPath = writeSpec(tmp, 'valid.md', specBody);
    const result = validateSpecPaths(specPath, MOCK_REPO);
    assert.strictEqual(result.valid, true,
      `expected valid=true, got missing=${JSON.stringify(result.missing)}`);
    assert.deepStrictEqual(result.missing, []);
  });
});

suite('validateSpecPaths — bad path', () => {
  test('spec with one bad path returns that entry with line + path', () => {
    const tmp = mkTmp();
    // Line 1: header
    // Line 2: blank
    // Line 3: backtick reference to missing path
    const specBody = `# Bad-Path Spec

The component under \`app/tests/e2e/visual.test.ts\` fails to load.

Another valid ref: \`src/App.tsx\`.
`;
    const specPath = writeSpec(tmp, 'bad.md', specBody);
    const result = validateSpecPaths(specPath, MOCK_REPO);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.missing.length, 1,
      `expected exactly 1 missing, got ${JSON.stringify(result.missing)}`);
    const miss = result.missing[0];
    assert.strictEqual(miss.path, 'app/tests/e2e/visual.test.ts');
    assert.strictEqual(miss.line, 3,
      `expected line 3, got ${miss.line} (context: ${miss.context})`);
    assert.ok(miss.context && miss.context.length > 0,
      'expected non-empty context');
  });

  test('code fence tokens are detected and reported', () => {
    const tmp = mkTmp();
    const specBody = [
      '# Fence Spec',
      '',
      '```',
      'does/not/exist.ts',
      '```',
      ''
    ].join('\n');
    const specPath = writeSpec(tmp, 'fence.md', specBody);
    const result = validateSpecPaths(specPath, MOCK_REPO);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.missing.length, 1);
    assert.strictEqual(result.missing[0].path, 'does/not/exist.ts');
    assert.strictEqual(result.missing[0].line, 4);
  });

  test('duplicate missing paths are reported once', () => {
    const tmp = mkTmp();
    const specBody = `# Dup Spec

Reference \`missing/file.ts\` here.
And again \`missing/file.ts\` there.
And once more \`missing/file.ts\`.
`;
    const specPath = writeSpec(tmp, 'dup.md', specBody);
    const result = validateSpecPaths(specPath, MOCK_REPO);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.missing.length, 1,
      `expected dedup to 1 entry, got ${result.missing.length}`);
    // First occurrence wins
    assert.strictEqual(result.missing[0].line, 3);
  });

  test('URLs and version numbers are not treated as paths', () => {
    const tmp = mkTmp();
    const specBody = `# URL Spec

See \`https://example.com/foo.md\` for details.
Version \`1.2.3\` is shipped.
`;
    const specPath = writeSpec(tmp, 'url.md', specBody);
    const result = validateSpecPaths(specPath, MOCK_REPO);
    // Both should be ignored, so nothing missing.
    assert.strictEqual(result.valid, true,
      `expected valid=true (URL + version skipped), got missing=${JSON.stringify(result.missing)}`);
  });
});

suite('findNearestPath — autocorrect', () => {
  test('finds the nearest match by basename in the fixture repo', () => {
    // Missing path: `app/tests/e2e/App.tsx`. The mock-projects/blurry-graph/
    // repo has `src/App.tsx`. findNearestPath should pick it up.
    const { match, candidates } = findNearestPath(
      'app/tests/e2e/App.tsx',
      MOCK_REPO
    );
    assert.ok(match, `expected a match, got null (candidates=${candidates})`);
    assert.strictEqual(match, 'src/App.tsx');
    assert.ok(Array.isArray(candidates) && candidates.length >= 1);
  });

  test('returns null match when no file with that basename exists', () => {
    const { match, candidates } = findNearestPath(
      'some/dir/totally-absent-basename.ts',
      MOCK_REPO
    );
    assert.strictEqual(match, null);
    assert.deepStrictEqual(candidates, []);
  });

  test('prefers closer directory match when multiple same-basename candidates exist', () => {
    // Build an ad-hoc fixture with two config.ts files at different depths
    // and verify the one sharing more path segments wins.
    const tmp = mkTmp();
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'other', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'config.ts'), '// a');
    fs.writeFileSync(path.join(tmp, 'other', 'deep', 'config.ts'), '// b');

    const { match } = findNearestPath('src/config.ts', tmp);
    // `src/config.ts` shares the `src` segment; that should outrank
    // `other/deep/config.ts` which shares zero segments.
    assert.strictEqual(match, 'src/config.ts');
  });
});

suite('extractPathTokens — heuristic', () => {
  test('PATH_RE matches expected extensions and rejects others', () => {
    const good = [
      'src/App.tsx',
      'scripts/forge-tools.cjs',
      'docs/spec.md',
      'config.yaml',
      'pyproject.toml',
      'main.go'
    ];
    const bad = [
      '1.2.3',              // starts with digit
      'foo/bar.exe',        // unknown extension
      'src/App',            // no extension
      'path with space.md'  // contains space
    ];
    // Note: the heuristic uses /i so `README.md` and other uppercase-leading
    // paths match — this is intentional per R011 (the regex is case-insensitive
    // so real-world README.md references in specs are validated).
    for (const g of good) {
      assert.ok(PATH_RE.test(g), `expected match for ${g}`);
    }
    for (const b of bad) {
      assert.ok(!PATH_RE.test(b), `expected no match for ${b}`);
    }
  });

  test('does not extract path tokens from prose outside backticks', () => {
    // Paragraph-style mention of src/App.tsx with no backticks should NOT
    // be treated as a path claim. Only fenced or backticked refs count.
    const text = `# Prose Spec

The file src/App.tsx is discussed here but without backticks.
`;
    const hits = extractPathTokens(text);
    assert.strictEqual(hits.length, 0,
      `expected 0 hits in prose, got ${JSON.stringify(hits)}`);
  });

  test('tokens across fence boundaries are tracked by line number', () => {
    const text = [
      '# header',   // 1
      '',           // 2
      '```',        // 3
      'first.ts',   // 4
      'second.ts',  // 5
      '```',        // 6
      '',           // 7
      'plain `third.ts` ref'  // 8
    ].join('\n');
    const hits = extractPathTokens(text);
    // Three tokens: lines 4, 5, 8
    assert.strictEqual(hits.length, 3);
    assert.strictEqual(hits[0].path, 'first.ts');
    assert.strictEqual(hits[0].line, 4);
    assert.strictEqual(hits[1].path, 'second.ts');
    assert.strictEqual(hits[1].line, 5);
    assert.strictEqual(hits[2].path, 'third.ts');
    assert.strictEqual(hits[2].line, 8);
  });
});

runTests();
