#!/usr/bin/env node
// tests/speccer-validator.test.cjs
//
// Unit tests for scripts/forge-speccer-validator.cjs. Covers precondition
// vs creation-target syntax (forge-self-fixes R001) and the prior
// precondition-only behavior to prevent regression.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const {
  validateSpecPaths,
  extractPathTokens,
  extractAllPathTokens,
  CREATE_TOKEN_RE
} = require('../scripts/forge-speccer-validator.cjs');

function mktmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Test 1: plain backtick paths that don't exist -> reported as missing.
// ---------------------------------------------------------------------------
function testPreconditionMissingFlagged() {
  const root = mktmpdir('forge-validator-precondition');
  try {
    const spec = writeFile(root, 'spec.md', [
      '---',
      'domain: test',
      '---',
      '- [ ] A file at `src/missing.ts` must already exist.',
      ''
    ].join('\n'));
    const result = validateSpecPaths(spec, root);
    assert.strictEqual(result.valid, false, 'should be invalid when precondition missing');
    assert.strictEqual(result.missing.length, 1, 'should report one missing');
    assert.strictEqual(result.missing[0].path, 'src/missing.ts');
    assert.deepStrictEqual(result.creation_targets, [], 'no creation targets expected');
    console.log('PASS  testPreconditionMissingFlagged');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 2: {create:...} syntax on missing paths -> valid:true, paths in
// creation_targets array, none in missing. This is the R001 success path.
// ---------------------------------------------------------------------------
function testCreationTargetSkipsExistence() {
  const root = mktmpdir('forge-validator-create');
  try {
    const spec = writeFile(root, 'spec.md', [
      '---',
      'domain: test',
      '---',
      '- [ ] Task T001 creates `{create:src/new.ts}` and `{create:scripts/build.mjs}`.',
      '- [ ] Task T002 creates `{create:src/App.tsx}`.',
      ''
    ].join('\n'));
    const result = validateSpecPaths(spec, root);
    assert.strictEqual(result.valid, true, 'should be valid when only creation targets present');
    assert.deepStrictEqual(result.missing, [], 'missing should be empty');
    const paths = result.creation_targets.map(h => h.path).sort();
    assert.deepStrictEqual(
      paths,
      ['scripts/build.mjs', 'src/App.tsx', 'src/new.ts'],
      'all three creation targets extracted'
    );
    console.log('PASS  testCreationTargetSkipsExistence');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Mixed spec — some preconditions exist, some missing, some are
// creation targets. Only the missing preconditions fail the gate.
// ---------------------------------------------------------------------------
function testMixedSpec() {
  const root = mktmpdir('forge-validator-mixed');
  try {
    writeFile(root, 'src/existing.ts', '// real');
    const spec = writeFile(root, 'spec.md', [
      '- [ ] Must exist: `src/existing.ts`.',
      '- [ ] Must exist: `src/also-missing.ts`.',
      '- [ ] Will exist: `{create:src/App.tsx}`.',
      ''
    ].join('\n'));
    const result = validateSpecPaths(spec, root);
    assert.strictEqual(result.valid, false, 'one precondition is missing');
    assert.strictEqual(result.missing.length, 1);
    assert.strictEqual(result.missing[0].path, 'src/also-missing.ts');
    assert.strictEqual(result.creation_targets.length, 1);
    assert.strictEqual(result.creation_targets[0].path, 'src/App.tsx');
    console.log('PASS  testMixedSpec');
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// Test 4: CREATE_TOKEN_RE detects the syntax in both backtick and fence
// contexts, and ignores malformed tokens.
// ---------------------------------------------------------------------------
function testCreateTokenExtraction() {
  const text = [
    'prose with `{create:a/b.ts}` and plain `c/d.ts`.',
    '```',
    'fence line with {create:e/f.md} and no backtick.',
    '```',
    'malformed `{create:no-extension}` should be ignored.',
    'malformed `{create:}` empty should be ignored.',
    ''
  ].join('\n');
  const { plainHits, createHits } = extractAllPathTokens(text);
  const createPaths = createHits.map(h => h.path).sort();
  assert.deepStrictEqual(createPaths, ['a/b.ts', 'e/f.md']);
  const plainPaths = plainHits.map(h => h.path).sort();
  assert.deepStrictEqual(plainPaths, ['c/d.ts']);
  console.log('PASS  testCreateTokenExtraction');
}

// ---------------------------------------------------------------------------
// Test 5: A path appearing both as plain backtick and in {create:} gets
// treated as a creation target (explicit opt-out beats implicit precondition).
// ---------------------------------------------------------------------------
function testCreateShadowsPlain() {
  const root = mktmpdir('forge-validator-shadow');
  try {
    const spec = writeFile(root, 'spec.md', [
      '- [ ] See `src/App.tsx` prose reference.',
      '- [ ] Creates `{create:src/App.tsx}`.',
      ''
    ].join('\n'));
    const result = validateSpecPaths(spec, root);
    assert.strictEqual(result.valid, true, 'create-token should shadow plain reference');
    assert.strictEqual(result.creation_targets.length, 1);
    assert.strictEqual(result.creation_targets[0].path, 'src/App.tsx');
    console.log('PASS  testCreateShadowsPlain');
  } finally {
    cleanup(root);
  }
}

// Confirm CREATE_TOKEN_RE is exported (contract for downstream tooling).
function testExportsShape() {
  assert.ok(CREATE_TOKEN_RE instanceof RegExp, 'CREATE_TOKEN_RE should be exported as RegExp');
  console.log('PASS  testExportsShape');
}

function run() {
  const tests = [
    testPreconditionMissingFlagged,
    testCreationTargetSkipsExistence,
    testMixedSpec,
    testCreateTokenExtraction,
    testCreateShadowsPlain,
    testExportsShape
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

run();
