// tests/forge-collab.test.cjs -- collab module (T001, R001)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const { sessionIdFromOrigin } = collab;

function mkTempRepo(originUrl) {
  if (!gitAvailable()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (originUrl) {
    execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir });
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

suite('sessionIdFromOrigin -- basic shape', () => {
  test('returns a 12-hex-char string for a valid origin', () => {
    if (!gitAvailable()) return;
    const dir = mkTempRepo('https://github.com/example/repo.git');
    try {
      const id = sessionIdFromOrigin({ cwd: dir });
      assert.strictEqual(typeof id, 'string');
      assert.strictEqual(id.length, 12);
      assert.match(id, /^[0-9a-f]{12}$/);
    } finally {
      cleanup(dir);
    }
  });

  test('is deterministic -- same origin url produces same id', () => {
    if (!gitAvailable()) return;
    const url = 'https://github.com/example/determinism.git';
    const id = sessionIdFromOrigin({ origin: url });
    const id2 = sessionIdFromOrigin({ origin: url });
    assert.strictEqual(id, id2);
  });

  test('matches hand-computed sha256 prefix', () => {
    const url = 'https://github.com/example/manual.git';
    const expected = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const actual = sessionIdFromOrigin({ origin: url });
    assert.strictEqual(actual, expected);
  });
});

suite('sessionIdFromOrigin -- two-clone integration', () => {
  test('two clones of the same remote produce identical session IDs', () => {
    if (!gitAvailable()) return;
    const url = 'https://github.com/example/same-remote.git';
    const cloneA = mkTempRepo(url);
    const cloneB = mkTempRepo(url);
    try {
      const idA = sessionIdFromOrigin({ cwd: cloneA });
      const idB = sessionIdFromOrigin({ cwd: cloneB });
      assert.strictEqual(idA, idB);
    } finally {
      cleanup(cloneA);
      cleanup(cloneB);
    }
  });

  test('two clones of different remotes produce different session IDs', () => {
    if (!gitAvailable()) return;
    const cloneA = mkTempRepo('https://github.com/example/repo-a.git');
    const cloneB = mkTempRepo('https://github.com/example/repo-b.git');
    try {
      const idA = sessionIdFromOrigin({ cwd: cloneA });
      const idB = sessionIdFromOrigin({ cwd: cloneB });
      assert.notStrictEqual(idA, idB);
    } finally {
      cleanup(cloneA);
      cleanup(cloneB);
    }
  });
});

suite('sessionIdFromOrigin -- missing origin error', () => {
  test('throws a clear error when no origin remote exists', () => {
    if (!gitAvailable()) return;
    const dir = mkTempRepo(null); // git init but no origin
    try {
      let threw = null;
      try {
        sessionIdFromOrigin({ cwd: dir });
      } catch (e) {
        threw = e;
      }
      assert.ok(threw, 'expected sessionIdFromOrigin to throw when no origin remote');
      assert.match(String(threw.message), /origin/i);
    } finally {
      cleanup(dir);
    }
  });

  test('throws a clear error outside any git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-nogit-'));
    try {
      let threw = null;
      try {
        sessionIdFromOrigin({ cwd: dir });
      } catch (e) {
        threw = e;
      }
      assert.ok(threw, 'expected sessionIdFromOrigin to throw outside a git repo');
    } finally {
      cleanup(dir);
    }
  });
});

runTests();
