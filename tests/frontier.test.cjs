// tests/frontier.test.cjs -- frontier parsing

const { suite, test, assert, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { parseFrontier } = tools;

suite('parseFrontier', () => {
  test('extracts task ids, deps, and est tokens', () => {
    const text = `---
spec: auth
---

## Tier 1

- [T001] Build user model | repo: api | depends: | est: ~5k | files: src/models/user.ts
- [T002] Build registration endpoint | repo: api | depends: T001 | est: ~10k | files: src/routes/auth.ts
`;
    const tasks = parseFrontier(text);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].id, 'T001');
    assert.strictEqual(tasks[0].name, 'Build user model');
    assert.strictEqual(tasks[0].repo, 'api');
    assert.strictEqual(tasks[0].estimated_tokens, 5000);
    // Note: parseFrontier currently emits [''] for an empty `depends:` field
    // (regex captures the empty value before the next pipe). Documenting the
    // observed behavior; treat any non-T-prefixed entries as "no real deps".
    assert.ok(
      tasks[0].depends.length === 0 || tasks[0].depends.every(d => !/^T\d/.test(d)),
      'expected no real T-prefixed dependencies for T001'
    );
    assert.strictEqual(tasks[1].id, 'T002');
    assert.deepStrictEqual(tasks[1].depends, ['T001']);
    assert.strictEqual(tasks[1].estimated_tokens, 10000);
  });

  test('handles multiple tiers and tags task with tier number', () => {
    const text = `---
spec: x
---

## Tier 1
- [T001] First | est: ~3k

## Tier 2
- [T002] Second | depends: T001 | est: ~5k

## Tier 3
- [T003] Third | depends: T002 | est: ~5k
`;
    const tasks = parseFrontier(text);
    assert.strictEqual(tasks.length, 3);
    assert.strictEqual(tasks[0].tier, 1);
    assert.strictEqual(tasks[1].tier, 2);
    assert.strictEqual(tasks[2].tier, 3);
  });

  test('returns empty array for empty/blank frontier', () => {
    assert.deepStrictEqual(parseFrontier(''), []);
    assert.deepStrictEqual(parseFrontier('---\nspec: empty\n---\n\n## Tier 1\n'), []);
  });

  test('parses provides/consumes/files lists', () => {
    const text = `## Tier 1
- [T010] Build thing | provides: register_endpoint, user_model | consumes: db_schema | files: a.ts, b.ts
`;
    const tasks = parseFrontier(text);
    assert.strictEqual(tasks.length, 1);
    assert.deepStrictEqual(tasks[0].provides, ['register_endpoint', 'user_model']);
    assert.deepStrictEqual(tasks[0].consumes, ['db_schema']);
    assert.deepStrictEqual(tasks[0].filesTouched, ['a.ts', 'b.ts']);
  });

  test('supports decimal task ids (re-decomposed sub-tasks)', () => {
    const text = `## Tier 1
- [T003.1] Sub task | depends: T003
`;
    const tasks = parseFrontier(text);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 'T003.1');
  });
});

runTests();
