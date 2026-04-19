// tests/forge-collab.test.cjs -- collab module (T001, R001)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, makeTempForgeDir, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const { sessionIdFromOrigin, scoreParticipant, routeToParticipant, DEFAULT_EPSILON } = collab;

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

// ===============================
// T002 -- routing primitive (R005)
// ===============================

// Scorer injections so tests are deterministic and zero-network.
function constantScorer(value) {
  return () => value;
}
function keywordScorer(keyword) {
  return (target, contrib) =>
    String(contrib).toLowerCase().includes(keyword.toLowerCase()) ? 0.8 : 0.1;
}

suite('scoreParticipant -- shape', () => {
  test('returns a number in [0, 1]', () => {
    const s = scoreParticipant('hello world', { handle: 'a', contributions: 'hello there world' });
    assert.ok(typeof s === 'number');
    assert.ok(s >= 0 && s <= 1, `expected [0,1], got ${s}`);
  });

  test('zero contribution participant scores exactly 0', () => {
    const s = scoreParticipant('anything', { handle: 'a', contributions: '' });
    assert.strictEqual(s, 0);
    const s2 = scoreParticipant('anything', { handle: 'a', contributions: '   ' });
    assert.strictEqual(s2, 0);
    const s3 = scoreParticipant('anything', { handle: 'a' }); // no contributions field
    assert.strictEqual(s3, 0);
  });

  test('clamps scorer output to [0, 1]', () => {
    const hi = scoreParticipant('x', { handle: 'a', contributions: 'x' }, { scorer: constantScorer(1.7) });
    assert.strictEqual(hi, 1);
    const lo = scoreParticipant('x', { handle: 'a', contributions: 'x' }, { scorer: constantScorer(-0.4) });
    assert.strictEqual(lo, 0);
    const nan = scoreParticipant('x', { handle: 'a', contributions: 'x' }, { scorer: () => NaN });
    assert.strictEqual(nan, 0);
  });
});

suite('routeToParticipant -- similarity', () => {
  test('three mock participants -- clearly relevant one wins', () => {
    const participants = [
      { handle: 'alice', contributions: 'redis cache invalidation ttl pub sub', active_tasks: 0 },
      { handle: 'bob',   contributions: 'react frontend css tailwind design', active_tasks: 0 },
      { handle: 'carol', contributions: 'payments stripe webhook retries', active_tasks: 0 }
    ];
    const winner = routeToParticipant('cache invalidation strategy for redis', participants);
    assert.strictEqual(winner, 'alice');
  });
});

suite('routeToParticipant -- load balance', () => {
  test('equal similarity but different active loads -> less loaded wins', () => {
    const participants = [
      { handle: 'busy', contributions: 'db schema', active_tasks: 4 },
      { handle: 'idle', contributions: 'db schema', active_tasks: 0 }
    ];
    // Force equal similarity via constant scorer; load dominates.
    const winner = routeToParticipant('db migration', participants, { scorer: constantScorer(0.7) });
    assert.strictEqual(winner, 'idle');
  });

  test('zero-load participant -- formula matches sim x 1/(1+0)', () => {
    const p = { handle: 'a', contributions: 'x', active_tasks: 0 };
    const winner = routeToParticipant('x', [p], { scorer: constantScorer(0.5) });
    assert.strictEqual(winner, 'a'); // no competition, no broadcast
  });

  test('saturated load -- heavily loaded participant still wins when similarity gap dominates', () => {
    const highSimBusy = { handle: 'busy', contributions: 'x', active_tasks: 2 };
    const lowSimIdle  = { handle: 'idle', contributions: 'x', active_tasks: 0 };
    const scorer = (target, contrib, p) => p.handle === 'busy' ? 1.0 : 0.05;
    // busy combined = 1.0 * 1/3 ~= 0.333
    // idle combined = 0.05 * 1  = 0.05
    // Gap ~0.283 > default epsilon 0.05 -> busy wins despite load penalty.
    const winner = routeToParticipant('x', [highSimBusy, lowSimIdle], { scorer });
    assert.strictEqual(winner, 'busy');
  });

  test('saturated load -- small similarity gap + load penalty collapses to broadcast', () => {
    const highSimBusy = { handle: 'busy', contributions: 'x', active_tasks: 100 };
    const lowSimIdle  = { handle: 'idle', contributions: 'x', active_tasks: 0 };
    const scorer = (target, contrib, p) => p.handle === 'busy' ? 0.99 : 0.001;
    // busy combined = 0.99 * (1/101) ~= 0.00980
    // idle combined = 0.001 * 1     = 0.00100
    // Gap 0.0088 < default epsilon 0.05 -> broadcast.
    const winner = routeToParticipant('x', [highSimBusy, lowSimIdle], { scorer });
    assert.strictEqual(winner, 'broadcast');
  });
});

suite('routeToParticipant -- tie / broadcast', () => {
  test('two participants with equal similarity returns broadcast', () => {
    const participants = [
      { handle: 'a', contributions: 'exactly same', active_tasks: 0 },
      { handle: 'b', contributions: 'exactly same', active_tasks: 0 }
    ];
    const r = routeToParticipant('same', participants, { scorer: constantScorer(0.5) });
    assert.strictEqual(r, 'broadcast');
  });

  test('clear winner returns the participant handle, not broadcast', () => {
    const participants = [
      { handle: 'a', contributions: 'match', active_tasks: 0 },
      { handle: 'b', contributions: 'nope',  active_tasks: 0 }
    ];
    const r = routeToParticipant('match', participants, { scorer: keywordScorer('match') });
    assert.strictEqual(r, 'a');
  });

  test('scores tied within epsilon collapse to broadcast', () => {
    // combined scores 0.5 and 0.48 -> diff 0.02 < default epsilon 0.05 -> broadcast
    const scorer = (t, c, p) => p.handle === 'a' ? 0.5 : 0.48;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    const r = routeToParticipant('x', participants, { scorer });
    assert.strictEqual(r, 'broadcast');
  });

  test('scores differing more than epsilon resolve to single winner', () => {
    const scorer = (t, c, p) => p.handle === 'a' ? 0.9 : 0.1;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    const r = routeToParticipant('x', participants, { scorer });
    assert.strictEqual(r, 'a');
  });

  test('all-zero scores -> broadcast', () => {
    const scorer = () => 0;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    const r = routeToParticipant('x', participants, { scorer });
    assert.strictEqual(r, 'broadcast');
  });

  test('empty participants list -> broadcast', () => {
    const r = routeToParticipant('anything', [], { scorer: constantScorer(0.9) });
    assert.strictEqual(r, 'broadcast');
  });
});

suite('routeToParticipant -- epsilon source', () => {
  test('default epsilon exposed as DEFAULT_EPSILON and equals 0.05', () => {
    assert.strictEqual(DEFAULT_EPSILON, 0.05);
  });

  test('opts.epsilon overrides default', () => {
    // With a larger epsilon (0.3), a previously-winning 0.9 vs 0.7 gap collapses to broadcast.
    const scorer = (t, c, p) => p.handle === 'a' ? 0.9 : 0.7;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    const withDefault = routeToParticipant('x', participants, { scorer });
    assert.strictEqual(withDefault, 'a'); // 0.2 gap > default 0.05
    const withWideEps = routeToParticipant('x', participants, { scorer, epsilon: 0.3 });
    assert.strictEqual(withWideEps, 'broadcast');
  });

  test('opts.forgeDir reads collab.route.epsilon from config.json', () => {
    const { forgeDir } = makeTempForgeDir({ config: { collab: { route: { epsilon: 0.5 } } } });
    const scorer = (t, c, p) => p.handle === 'a' ? 0.6 : 0.2;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    // Gap is 0.4; default eps 0.05 -> 'a', configured eps 0.5 -> broadcast.
    const r = routeToParticipant('x', participants, { scorer, forgeDir });
    assert.strictEqual(r, 'broadcast');
  });

  test('opts.epsilon wins over opts.forgeDir config value', () => {
    const { forgeDir } = makeTempForgeDir({ config: { collab: { route: { epsilon: 0.5 } } } });
    const scorer = (t, c, p) => p.handle === 'a' ? 0.6 : 0.2;
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    // Config eps 0.5 would broadcast; opts.epsilon 0.01 restores clear winner.
    const r = routeToParticipant('x', participants, { scorer, forgeDir, epsilon: 0.01 });
    assert.strictEqual(r, 'a');
  });
});

suite('routeToParticipant -- deterministic tiebreak on handle', () => {
  test('exact ties break deterministically on handle string order, not insertion order', () => {
    const scorer = constantScorer(0.5);
    const inputA = [
      { handle: 'zeta',  contributions: 'x', active_tasks: 0 },
      { handle: 'alpha', contributions: 'x', active_tasks: 0 }
    ];
    const inputB = [
      { handle: 'alpha', contributions: 'x', active_tasks: 0 },
      { handle: 'zeta',  contributions: 'x', active_tasks: 0 }
    ];
    // Both have identical combined score -> broadcast (ties collapse).
    // Reordering must not change result.
    assert.strictEqual(routeToParticipant('x', inputA, { scorer }), 'broadcast');
    assert.strictEqual(routeToParticipant('x', inputB, { scorer }), 'broadcast');
  });
});

runTests();
