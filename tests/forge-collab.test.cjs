// tests/forge-collab.test.cjs -- collab module (T001, R001)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, makeTempForgeDir, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const {
  sessionIdFromOrigin,
  scoreParticipant, routeToParticipant, DEFAULT_EPSILON,
  createMemoryTransport,
  tryAcquireLease, refreshLease, releaseLease, readLease, withLease,
  claimTask, heartbeatTaskClaim, releaseTaskClaim, readTaskClaim, listActiveTaskClaims,
  DEFAULT_CLAIM_TTL_SECONDS, DEFAULT_HEARTBEAT_SECONDS, DEFAULT_CONSOLIDATION_TTL_SECONDS
} = collab;

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

// =====================================================================
// T003 -- claim queue + consolidation-lease primitive (R006, R016)
// =====================================================================

suite('memory transport', () => {
  test('read returns null for missing key', () => {
    const t = createMemoryTransport();
    assert.strictEqual(t.read('x'), null);
  });

  test('cas with null expected fails if entry exists', () => {
    const t = createMemoryTransport();
    t.cas('x', null, { name: 'x', claimant: 'a', acquiredAt: 'T', expiresAt: 'T' });
    const ok = t.cas('x', null, { name: 'x', claimant: 'b', acquiredAt: 'T', expiresAt: 'T' });
    assert.strictEqual(ok, false);
  });

  test('list returns copy of values', () => {
    const t = createMemoryTransport();
    t.cas('x', null, { name: 'x', claimant: 'a', acquiredAt: 'T', expiresAt: 'T' });
    t.cas('y', null, { name: 'y', claimant: 'b', acquiredAt: 'T', expiresAt: 'T' });
    assert.strictEqual(t.list().length, 2);
  });
});

suite('tryAcquireLease -- basic', () => {
  test('fresh lease -- acquired', () => {
    const t = createMemoryTransport();
    const r = tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1000 });
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.lease.claimant, 'daniel');
    assert.strictEqual(r.lease.name, 'consolidation');
    assert.ok(Date.parse(r.lease.expiresAt) > Date.parse(r.lease.acquiredAt));
  });

  test('second distinct claimant while live -- rejected with holder', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1000 });
    const r = tryAcquireLease(t, 'consolidation', 'lucas', { ttlSeconds: 30, now: 1001 });
    assert.strictEqual(r.acquired, false);
    assert.match(r.reason, /held_by_daniel/);
    assert.strictEqual(r.holder.claimant, 'daniel');
  });

  test('same claimant re-acquires (treated as refresh)', () => {
    const t = createMemoryTransport();
    const a = tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1000 });
    const b = tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 2000 });
    assert.strictEqual(a.acquired, true);
    assert.strictEqual(b.acquired, true);
    assert.ok(Date.parse(b.lease.expiresAt) > Date.parse(a.lease.expiresAt));
  });

  test('takes over a stale lease after TTL elapsed', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1000 });
    // Jump forward > 30s
    const r = tryAcquireLease(t, 'consolidation', 'lucas', { ttlSeconds: 30, now: 1000 + 60_000 });
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.tookOverStale, true);
    assert.strictEqual(r.lease.claimant, 'lucas');
  });

  test('two-agent race -- exactly one wins on fresh lease', () => {
    // Shared transport, both call simultaneously. The CAS backend resolves
    // the race: the second caller sees the first's write and fails with
    // lost_race or held_by_other.
    const t = createMemoryTransport();
    const r1 = tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1000 });
    const r2 = tryAcquireLease(t, 'consolidation', 'lucas',  { ttlSeconds: 30, now: 1000 });
    const wins = [r1.acquired, r2.acquired].filter(Boolean).length;
    assert.strictEqual(wins, 1, 'expected exactly one winner in claim race');
  });

  test('argument validation', () => {
    const t = createMemoryTransport();
    assert.throws(() => tryAcquireLease(null, 'n', 'd'));
    assert.throws(() => tryAcquireLease(t, '', 'd'));
    assert.throws(() => tryAcquireLease(t, 'n', ''));
  });
});

suite('refreshLease + releaseLease', () => {
  test('refresh extends expiresAt for the holder', () => {
    const t = createMemoryTransport();
    const a = tryAcquireLease(t, 'L', 'd', { ttlSeconds: 10, now: 1000 });
    const r = refreshLease(t, 'L', 'd', { ttlSeconds: 10, now: 2000 });
    assert.strictEqual(r.refreshed, true);
    assert.ok(Date.parse(r.lease.expiresAt) > Date.parse(a.lease.expiresAt));
  });

  test('refresh by non-holder fails with holder info', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'L', 'd', { ttlSeconds: 10, now: 1000 });
    const r = refreshLease(t, 'L', 'lucas', { ttlSeconds: 10, now: 2000 });
    assert.strictEqual(r.refreshed, false);
    assert.match(r.reason, /held_by_other/);
    assert.strictEqual(r.holder.claimant, 'd');
  });

  test('release by holder succeeds; re-acquire by other works', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'L', 'd', { ttlSeconds: 30, now: 1000 });
    const rel = releaseLease(t, 'L', 'd');
    assert.strictEqual(rel.released, true);
    const r2 = tryAcquireLease(t, 'L', 'lucas', { ttlSeconds: 30, now: 1001 });
    assert.strictEqual(r2.acquired, true);
  });

  test('release on already-empty is idempotent noop', () => {
    const t = createMemoryTransport();
    const r = releaseLease(t, 'L', 'd');
    assert.strictEqual(r.released, true);
    assert.strictEqual(r.noop, true);
  });

  test('release by non-holder fails', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'L', 'd', { ttlSeconds: 30, now: 1000 });
    const r = releaseLease(t, 'L', 'lucas');
    assert.strictEqual(r.released, false);
  });
});

suite('readLease', () => {
  test('reports stale=true when past expiry', () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'L', 'd', { ttlSeconds: 5, now: 1000 });
    const live = readLease(t, 'L', { now: 1001 });
    const stale = readLease(t, 'L', { now: 1000 + 60_000 });
    assert.strictEqual(live.stale, false);
    assert.strictEqual(stale.stale, true);
  });

  test('returns null for unknown lease', () => {
    const t = createMemoryTransport();
    assert.strictEqual(readLease(t, 'missing', { now: 1 }), null);
  });
});

suite('withLease', () => {
  test('runs fn while holding, releases afterward', async () => {
    const t = createMemoryTransport();
    let seen = null;
    const r = await withLease(t, 'consolidation', 'd', { ttlSeconds: 30, now: 1000 }, async (lease) => {
      seen = lease.claimant;
      return 'result-value';
    });
    assert.strictEqual(r.held, true);
    assert.strictEqual(r.result, 'result-value');
    assert.strictEqual(seen, 'd');
    // Lease released after fn
    assert.strictEqual(readLease(t, 'consolidation', { now: 1001 }), null);
  });

  test('defers cleanly when another holder exists -- does not run fn', async () => {
    const t = createMemoryTransport();
    tryAcquireLease(t, 'consolidation', 'lucas', { ttlSeconds: 30, now: 1000 });
    let ran = false;
    const r = await withLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: 1001 }, async () => {
      ran = true;
      return 'should-not-run';
    });
    assert.strictEqual(r.held, false);
    assert.strictEqual(ran, false);
    assert.match(r.reason, /held_by_lucas/);
  });

  test('releases even when fn throws', async () => {
    const t = createMemoryTransport();
    let threw = null;
    try {
      await withLease(t, 'consolidation', 'd', { ttlSeconds: 30, now: 1000 }, async () => {
        throw new Error('fn failed');
      });
    } catch (e) { threw = e; }
    assert.ok(threw);
    // Lease should still be released despite exception.
    assert.strictEqual(readLease(t, 'consolidation', { now: 1001 }), null);
  });
});

suite('task-claim wrappers', () => {
  test('claimTask / heartbeatTaskClaim / releaseTaskClaim round-trip', () => {
    const t = createMemoryTransport();
    const c = claimTask(t, 'T004', 'daniel', { ttlSeconds: DEFAULT_CLAIM_TTL_SECONDS, now: 1000 });
    assert.strictEqual(c.acquired, true);
    const hb = heartbeatTaskClaim(t, 'T004', 'daniel', { ttlSeconds: DEFAULT_CLAIM_TTL_SECONDS, now: 2000 });
    assert.strictEqual(hb.refreshed, true);
    const rel = releaseTaskClaim(t, 'T004', 'daniel');
    assert.strictEqual(rel.released, true);
  });

  test('two agents race for same task -- exactly one wins', () => {
    const t = createMemoryTransport();
    const r1 = claimTask(t, 'T004', 'daniel', { now: 1000 });
    const r2 = claimTask(t, 'T004', 'lucas',  { now: 1000 });
    const winners = [r1.acquired, r2.acquired].filter(Boolean).length;
    assert.strictEqual(winners, 1);
  });

  test('stale claim is reclaimable after TTL', () => {
    const t = createMemoryTransport();
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 60, now: 1000 });
    const r = claimTask(t, 'T004', 'lucas', { ttlSeconds: 60, now: 1000 + 120_000 });
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.tookOverStale, true);
  });

  test('readTaskClaim reports stale flag', () => {
    const t = createMemoryTransport();
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 10, now: 1000 });
    const fresh = readTaskClaim(t, 'T004', { now: 1001 });
    const stale = readTaskClaim(t, 'T004', { now: 1000 + 60_000 });
    assert.strictEqual(fresh.stale, false);
    assert.strictEqual(stale.stale, true);
  });

  test('listActiveTaskClaims filters out expired and non-claim leases', () => {
    const t = createMemoryTransport();
    const T = 1_000_000; // use large numbers so ttl math is unambiguous in ms
    // Active task claim: expires at T + 60s
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 60, now: T });
    // Expired task claim: claimed at T - 200s with only 10s ttl -> long expired
    claimTask(t, 'T005', 'lucas',  { ttlSeconds: 10, now: T - 200_000 });
    // Non-claim lease (consolidation) -- must not appear in active task claims
    tryAcquireLease(t, 'consolidation', 'daniel', { ttlSeconds: 30, now: T });
    const active = listActiveTaskClaims(t, { now: T + 1000 });
    const ids = active.map(a => a.task_id).sort();
    assert.deepStrictEqual(ids, ['T004']);
  });
});

suite('defaults match spec-collab config contract', () => {
  test('DEFAULT_CLAIM_TTL_SECONDS = 120 (matches R006 AC)', () => {
    assert.strictEqual(DEFAULT_CLAIM_TTL_SECONDS, 120);
  });
  test('DEFAULT_HEARTBEAT_SECONDS = 30 (matches R006 AC)', () => {
    assert.strictEqual(DEFAULT_HEARTBEAT_SECONDS, 30);
  });
  test('DEFAULT_CONSOLIDATION_TTL_SECONDS <= 30 (matches R016 AC)', () => {
    assert.ok(DEFAULT_CONSOLIDATION_TTL_SECONDS <= 30);
  });
});

runTests();
