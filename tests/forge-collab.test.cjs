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
  DEFAULT_CLAIM_TTL_SECONDS, DEFAULT_HEARTBEAT_SECONDS, DEFAULT_CONSOLIDATION_TTL_SECONDS,
  generateFlagId, flagPath, userScopedLogPath, appendToUserScopedLog,
  selectTransportMode, renderSetupGuide, createTransport, createPollingTransport,
  POLLING_BRANCH_DEFAULT, POLLING_INTERVAL_MS_DEFAULT,
  brainstormDump, readAllInputs, consolidateInputs, categorizeInputs,
  writeConsolidatedUnderLease, routeClarifyingQuestion,
  TASK_BRANCH_PREFIX, taskBranchName, startTaskBranch, updateTaskBranch,
  deleteTaskBranch, createRecordingGitRunner,
  renderResearchResult, persistResearchResult, appendResearchSection, isResearchTask,
  FLAG_STATUS, writeForwardMotionFlag, listFlags, readFlag, overrideFlag,
  DEFAULT_MERGE_RETRIES, DEFAULT_MERGE_BACKOFF_MS, squashMergeAndPush,
  readAutoPushConfig, gatedPush, filterClaimableForLateJoin, lateJoinBootstrap
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

// =====================================================================
// T004 -- transport layer (R013, R015): mode select + polling + targeted
// =====================================================================

suite('selectTransportMode (R013)', () => {
  test('ABLY_KEY present -> ably', () => {
    assert.strictEqual(selectTransportMode({ env: { ABLY_KEY: 'xxx' } }), 'ably');
  });

  test('no ABLY_KEY + polling opt-in -> polling', () => {
    assert.strictEqual(selectTransportMode({ env: {}, polling: true }), 'polling');
  });

  test('no ABLY_KEY + no polling opt-in -> setup-required', () => {
    assert.strictEqual(selectTransportMode({ env: {} }), 'setup-required');
  });

  test('explicit opts.mode overrides env detection', () => {
    assert.strictEqual(selectTransportMode({ env: { ABLY_KEY: 'x' }, mode: 'polling' }), 'polling');
    assert.strictEqual(selectTransportMode({ env: {}, mode: 'memory' }), 'memory');
  });
});

suite('renderSetupGuide (R013)', () => {
  test('includes Ably signup url and ABLY_KEY hint', () => {
    const g = renderSetupGuide();
    assert.match(g, /ably\.com/);
    assert.match(g, /ABLY_KEY/);
    assert.match(g, /--polling/);
    assert.match(g, /npm install ably/);
  });
});

suite('createTransport dispatcher (R013)', () => {
  test('no ABLY_KEY without polling -> returns setup-required object with guide', () => {
    const t = createTransport({ env: {} });
    assert.strictEqual(t.mode, 'setup-required');
    assert.match(t.guide, /ABLY_KEY/);
  });

  test('memory mode returns a working lease store', () => {
    const t = createTransport({ mode: 'memory' });
    assert.strictEqual(t.mode, 'memory');
    assert.strictEqual(typeof t.read, 'function');
    assert.strictEqual(typeof t.cas, 'function');
  });

  test('polling mode returns a polling transport', () => {
    const t = createTransport({ mode: 'polling', ioAdapter: _stubIo() });
    assert.strictEqual(t.mode, 'polling');
  });
});

suite('polling transport (R013, R015)', () => {
  test('publish + subscribe round-trip via shared io', async () => {
    const io = _stubIo();
    const tA = createPollingTransport({ ioAdapter: io, clientId: 'alice', intervalMs: 60_000 });
    const tB = createPollingTransport({ ioAdapter: io, clientId: 'bob',   intervalMs: 60_000 });
    await tA.connect();
    await tB.connect();
    const received = [];
    tB.subscribe('lock-claim', (m) => received.push(m));
    await tA.publish('lock-claim', { task: 'T004' });
    await tB._internal._refresh();
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].data.task, 'T004');
    assert.strictEqual(received[0].from, 'alice');
    await tA.disconnect(); await tB.disconnect();
  });

  test('sendTargeted addresses a specific handle via target field (R015)', async () => {
    const io = _stubIo();
    const tA = createPollingTransport({ ioAdapter: io, clientId: 'alice', intervalMs: 60_000 });
    const tDaniel = createPollingTransport({ ioAdapter: io, clientId: 'daniel', intervalMs: 60_000 });
    const tLucas  = createPollingTransport({ ioAdapter: io, clientId: 'lucas',  intervalMs: 60_000 });
    await tA.connect(); await tDaniel.connect(); await tLucas.connect();
    const danMsgs = [];
    const lucMsgs = [];
    tDaniel.subscribe('flag-ping', m => { if (m.data.target === 'daniel') danMsgs.push(m); });
    tLucas.subscribe('flag-ping',  m => { if (m.data.target === 'lucas')  lucMsgs.push(m); });
    await tA.sendTargeted('daniel', 'flag-ping', { flag: 'F001' });
    await tDaniel._internal._refresh();
    await tLucas._internal._refresh();
    assert.strictEqual(danMsgs.length, 1);
    assert.strictEqual(lucMsgs.length, 0, 'non-target must receive zero messages per R015 AC');
    await tA.disconnect(); await tDaniel.disconnect(); await tLucas.disconnect();
  });

  test('cas semantics -- single-node CAS accepts null-expected once, rejects thereafter', async () => {
    // Unit-scope test: one polling transport's cas enforces CAS on its own
    // local cache. Cross-node race resolution is a git-layer concern tested
    // in the integration review (T013), not here.
    const io = _stubIo();
    const t = createPollingTransport({ ioAdapter: io, clientId: 'alice', intervalMs: 60_000 });
    await t.connect();
    const lease = { name: 'claim:T001', claimant: 'alice', acquiredAt: 'T', expiresAt: 'T' };
    assert.strictEqual(t.cas('claim:T001', null, lease), true);
    // Second attempt with null-expected must fail because the slot is now occupied.
    assert.strictEqual(t.cas('claim:T001', null, Object.assign({}, lease, { claimant: 'bob' })), false);
    // cas with the current value as expected succeeds (refresh/takeover pattern).
    assert.strictEqual(t.cas('claim:T001', lease, Object.assign({}, lease, { expiresAt: 'T+1' })), true);
    await t.disconnect();
  });
});

suite('polling transport defaults', () => {
  test('POLLING_BRANCH_DEFAULT is forge/collab-state', () => {
    assert.strictEqual(POLLING_BRANCH_DEFAULT, 'forge/collab-state');
  });
  test('POLLING_INTERVAL_MS_DEFAULT is within 2-3 seconds per R013 AC', () => {
    assert.ok(POLLING_INTERVAL_MS_DEFAULT >= 2000 && POLLING_INTERVAL_MS_DEFAULT <= 3000);
  });
});

// Shared in-memory io adapter for polling transport tests.
function _stubIo() {
  const state = { leases: {}, messages: [] };
  return {
    async ensureBranch() { return true; },
    async readBranch() { return JSON.parse(JSON.stringify(state)); },
    async writeLease(branch, name, lease) {
      if (lease === null) delete state.leases[name];
      else state.leases[name] = lease;
      return true;
    },
    async appendMessage(branch, msg) {
      state.messages.push(msg);
      return true;
    }
  };
}

// =====================================================================
// T006 -- single-writer utilities (R016): flag IDs + user-scoped logs
// =====================================================================

suite('generateFlagId', () => {
  test('returns F-prefixed 13-char id', () => {
    const id = generateFlagId();
    assert.match(id, /^F[0-9a-f]{12}$/);
  });

  test('two concurrent generations produce distinct ids (filesystem-safe)', () => {
    const n = 500;
    const ids = new Set();
    for (let i = 0; i < n; i++) ids.add(generateFlagId());
    assert.strictEqual(ids.size, n, 'expected all generated flag ids to be unique');
  });

  test('flagPath composes collabDir + flags/<id>.md', () => {
    const p = flagPath('/tmp/collab', 'F0123456789ab');
    assert.ok(p.endsWith(path.join('flags', 'F0123456789ab.md')));
    assert.throws(() => flagPath('', 'F1'));
    assert.throws(() => flagPath('/tmp', ''));
  });
});

suite('userScopedLogPath', () => {
  test('includes kind and handle in filename', () => {
    const p = userScopedLogPath('/c', 'routing', 'daniel');
    assert.ok(p.endsWith('routing-log-daniel.jsonl'));
  });

  test('sanitizes unsafe handle characters', () => {
    const p = userScopedLogPath('/c', 'flag-emit', 'evil/../name');
    assert.ok(!p.includes('/../'));
    assert.match(path.basename(p), /^flag-emit-log-[A-Za-z0-9_-]+\.jsonl$/);
  });

  test('defaults unknown kind/handle to safe placeholders', () => {
    const p = userScopedLogPath('/c', '', null);
    assert.match(path.basename(p), /^log-log-unknown\.jsonl$/);
  });
});

suite('appendToUserScopedLog', () => {
  test('appends a JSONL line with ts and creates parent dir', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const p1 = appendToUserScopedLog(collabDir, 'routing', 'daniel', { event: 'routed', target: 'lucas' });
    const p2 = appendToUserScopedLog(collabDir, 'routing', 'daniel', { event: 'routed', target: 'sarah' });
    assert.strictEqual(p1, p2);
    const lines = fs.readFileSync(p1, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.ok(first.ts && second.ts, 'each entry gets ts');
    assert.strictEqual(first.target, 'lucas');
    assert.strictEqual(second.target, 'sarah');
  });

  test('two users appending simultaneously land in distinct files (no contention)', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const pA = appendToUserScopedLog(collabDir, 'routing', 'alice', { n: 1 });
    const pB = appendToUserScopedLog(collabDir, 'routing', 'bob',   { n: 2 });
    assert.notStrictEqual(pA, pB);
    assert.ok(fs.existsSync(pA));
    assert.ok(fs.existsSync(pB));
  });

  test('preserves caller-provided ts when supplied', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const p = appendToUserScopedLog(collabDir, 'flag-emit', 'daniel', { ts: 'custom-ts', flag: 'F1' });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8').trim());
    assert.strictEqual(entry.ts, 'custom-ts');
  });
});

// =====================================================================
// T005 -- ably peerDependency declaration (R013)
// =====================================================================

suite('package.json peer-dependency declaration (R013)', () => {
  const pkgPath = path.join(__dirname, '..', 'package.json');

  test('package.json exists at repo root', () => {
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist at repo root');
  });

  test('ably is declared under peerDependencies, not dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const peer = pkg.peerDependencies || {};
    const hard = pkg.dependencies || {};
    assert.ok(peer.ably, 'expected peerDependencies.ably to be declared');
    assert.ok(!hard.ably, 'ably must not be a hard dependency');
  });

  test('peerDependenciesMeta marks ably as optional', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const meta = (pkg.peerDependenciesMeta && pkg.peerDependenciesMeta.ably) || {};
    assert.strictEqual(meta.optional, true, 'peerDependenciesMeta.ably.optional must be true');
  });

  test('no hard dependencies declared (zero-install philosophy preserved)', () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const hard = pkg.dependencies || {};
    assert.strictEqual(Object.keys(hard).length, 0, 'expected zero hard dependencies');
  });

  test('ably is only imported from scripts/forge-collab.cjs (R013 AC: lazy-loaded)', () => {
    const scriptsDir = path.join(__dirname, '..', 'scripts');
    const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs'));
    const offenders = [];
    for (const f of files) {
      if (f === 'forge-collab.cjs') continue;
      const content = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
      // Match require('ably') or require("ably") or from 'ably'
      if (/require\s*\(\s*['"]ably['"]\s*\)/.test(content) || /from\s+['"]ably['"]/.test(content)) {
        offenders.push(f);
      }
    }
    assert.deepStrictEqual(offenders, [], 'ably must only be imported from scripts/forge-collab.cjs');
  });
});

// =====================================================================
// T007 -- brainstorm pipeline (R002, R003, R004, R014, R015, R016)
// =====================================================================

suite('brainstormDump (R002)', () => {
  test('writes inputs-<handle>.md with frontmatter and body', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const p = brainstormDump(collabDir, 'daniel', 'we need redis for caching\n\npayments use stripe', { timestamp: '2026-04-19T00:00:00Z' });
    assert.ok(p.endsWith(path.join('brainstorm', 'inputs-daniel.md')));
    const raw = fs.readFileSync(p, 'utf8');
    assert.match(raw, /^---\nauthor: daniel\ntimestamp: 2026-04-19T00:00:00Z\n---/);
    assert.match(raw, /redis/);
    assert.match(raw, /stripe/);
  });

  test('sanitizes unsafe handle characters', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const p = brainstormDump(collabDir, 'evil/../name', 'hi', { timestamp: 'T' });
    assert.ok(!p.includes('/../'));
  });
});

suite('readAllInputs (R003)', () => {
  test('returns empty array when no brainstorm dir', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    assert.deepStrictEqual(readAllInputs(collabDir), []);
  });

  test('reads every inputs-*.md with handle + body', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    brainstormDump(collabDir, 'daniel', 'redis caching sessions');
    brainstormDump(collabDir, 'lucas',  'use nats for pub sub');
    brainstormDump(collabDir, 'sarah',  'stripe payments');
    const r = readAllInputs(collabDir);
    assert.strictEqual(r.length, 3);
    const handles = r.map(x => x.handle).sort();
    assert.deepStrictEqual(handles, ['daniel', 'lucas', 'sarah']);
  });
});

suite('consolidateInputs (R003)', () => {
  test('overlapping ideas merge into multi-contributor topic', () => {
    const inputs = [
      { handle: 'daniel', body: 'redis cache invalidation is tricky' },
      { handle: 'lucas',  body: 'cache invalidation strategy matters' },
      { handle: 'sarah',  body: 'stripe payments need retries' }
    ];
    const md = consolidateInputs(inputs);
    assert.match(md, /contributors:.*(daniel.*lucas|lucas.*daniel)/);
    assert.match(md, /contributors:.*sarah/);
  });

  test('empty inputs -> empty string', () => {
    assert.strictEqual(consolidateInputs([]), '');
  });

  test('injected consolidator overrides default', () => {
    assert.strictEqual(
      consolidateInputs([{ handle: 'd', body: 'x' }], { consolidator: () => 'custom' }),
      'custom'
    );
  });
});

suite('categorizeInputs (R004, R014, R016)', () => {
  test('three topics produce at least three categories', () => {
    const inputs = [
      { handle: 'daniel', body: 'redis cache' },
      { handle: 'lucas',  body: 'stripe payments' },
      { handle: 'sarah',  body: 'react ui polish' }
    ];
    const md = consolidateInputs(inputs);
    const cats = categorizeInputs(md, inputs);
    assert.ok(cats.length >= 3, 'expected >=3 categories, got ' + cats.length);
  });

  test('each category has required fields including type in {coding, research}', () => {
    const inputs = [{ handle: 'daniel', body: 'explore the mongo query planner' }];
    const md = consolidateInputs(inputs);
    const cats = categorizeInputs(md, inputs);
    for (const c of cats) {
      assert.ok(c.id);
      assert.ok(c.title);
      assert.ok(Array.isArray(c.source_contributors));
      assert.strictEqual(typeof c.is_decision, 'boolean');
      assert.ok(c.type === 'coding' || c.type === 'research');
    }
  });

  test('classifier picks research for explore/investigate topics (R014)', () => {
    const inputs = [{ handle: 'd', body: 'we should research cache eviction policies' }];
    const md = consolidateInputs(inputs);
    const cats = categorizeInputs(md, inputs);
    assert.ok(cats.some(c => c.type === 'research'));
  });

  test('contradictions surface as is_decision: true (R005/R016)', () => {
    const inputs = [
      { handle: 'daniel', body: 'use redis for pub sub' },
      { handle: 'lucas',  body: 'use nats for pub sub' }
    ];
    const md = consolidateInputs(inputs);
    const cats = categorizeInputs(md, inputs);
    const decisions = cats.filter(c => c.is_decision);
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].source_contributors.includes('daniel'));
    assert.ok(decisions[0].source_contributors.includes('lucas'));
  });

  test('injected classifier + detector override defaults', () => {
    const inputs = [{ handle: 'd', body: 'hi' }];
    const md = consolidateInputs(inputs);
    const cats = categorizeInputs(md, inputs, {
      classifier: () => 'research',
      contradictionDetector: () => [{ summary: 'forced', positions: [{ option: 'x', contributors: ['d'] }] }]
    });
    assert.ok(cats.some(c => c.type === 'research'));
    assert.ok(cats.some(c => c.is_decision === true && c.title === 'forced'));
  });
});

suite('writeConsolidatedUnderLease (R016)', () => {
  test('single writer -> writes consolidated.md and categories.json', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const inputs = [
      { handle: 'daniel', body: 'redis cache' },
      { handle: 'lucas',  body: 'stripe payments' }
    ];
    const t = createMemoryTransport();
    const r = await writeConsolidatedUnderLease(t, collabDir, 'daniel', inputs, { ttlSeconds: 30, now: 1000 });
    assert.strictEqual(r.held, true);
    assert.ok(r.result.taskCount >= 2);
    assert.ok(fs.existsSync(r.result.consolidatedPath));
    assert.ok(fs.existsSync(r.result.categoriesPath));
    const cats = JSON.parse(fs.readFileSync(r.result.categoriesPath, 'utf8'));
    assert.ok(Array.isArray(cats.categories));
  });

  test('concurrent consolidation -> second defers without writing', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const t = createMemoryTransport();
    tryAcquireLease(t, 'consolidation', 'lucas', { ttlSeconds: 30, now: 1000 });
    const r = await writeConsolidatedUnderLease(t, collabDir, 'daniel', [{ handle: 'd', body: 'x' }], { ttlSeconds: 30, now: 1001 });
    assert.strictEqual(r.held, false);
    assert.match(r.reason, /held_by_lucas/);
    assert.strictEqual(fs.existsSync(path.join(collabDir, 'brainstorm', 'consolidated.md')), false);
  });
});

suite('routeClarifyingQuestion (R015)', () => {
  test('writes question file + sends targeted transport message', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const sent = [];
    const transport = {
      async sendTargeted(handle, event, data) { sent.push({ handle, event, data }); },
      async publish(event, data) { sent.push({ broadcast: true, event, data }); }
    };
    const participants = [
      { handle: 'daniel', contributions: 'redis cache invalidation', active_tasks: 0 },
      { handle: 'lucas',  contributions: 'stripe payments',          active_tasks: 0 }
    ];
    const r = await routeClarifyingQuestion(transport, collabDir, participants, {
      text: 'which cache eviction policy should we use?',
      topic: 'cache',
      source_section: 'Topic 1'
    });
    assert.ok(fs.existsSync(r.path));
    assert.strictEqual(r.routed_to, 'daniel');
    const raw = fs.readFileSync(r.path, 'utf8');
    assert.match(raw, /routed_to: daniel/);
    assert.match(raw, /status: open/);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].handle, 'daniel');
  });

  test('broadcast on tie -> publish, not sendTargeted', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const sent = [];
    const transport = {
      async sendTargeted(h, e, d) { sent.push({ handle: h, event: e, data: d }); },
      async publish(e, d) { sent.push({ broadcast: true, event: e, data: d }); }
    };
    const participants = [
      { handle: 'a', contributions: 'identical', active_tasks: 0 },
      { handle: 'b', contributions: 'identical', active_tasks: 0 }
    ];
    const r = await routeClarifyingQuestion(transport, collabDir, participants, { text: 'q', topic: 't' }, { scorer: () => 0.5 });
    assert.strictEqual(r.routed_to, 'broadcast');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].broadcast, true);
  });
});

// =====================================================================
// T008 -- per-task branches pushed to origin (R007)
// =====================================================================

suite('taskBranchName (R007)', () => {
  test('prefixes task id with forge/task/', () => {
    assert.strictEqual(taskBranchName('T004'), 'forge/task/T004');
    assert.strictEqual(TASK_BRANCH_PREFIX, 'forge/task/');
  });

  test('rejects empty task id', () => {
    assert.throws(() => taskBranchName(''));
    assert.throws(() => taskBranchName(null));
  });
});

suite('startTaskBranch (R007)', () => {
  test('pushes HEAD to origin refs/heads/forge/task/<id> by default', () => {
    const runner = createRecordingGitRunner();
    const r = startTaskBranch('T004', { runner, cwd: '/tmp/worktree' });
    assert.strictEqual(r.pushed, true);
    assert.strictEqual(r.branch, 'forge/task/T004');
    assert.strictEqual(r.remote, 'origin');
    assert.strictEqual(runner.calls.length, 1);
    assert.deepStrictEqual(runner.calls[0].args, [
      'push', 'origin', 'HEAD:refs/heads/forge/task/T004'
    ]);
    assert.strictEqual(runner.calls[0].cwd, '/tmp/worktree');
  });

  test('honors opts.ref for arbitrary source ref', () => {
    const runner = createRecordingGitRunner();
    startTaskBranch('T005', { runner, ref: 'abc1234' });
    assert.deepStrictEqual(runner.calls[0].args, [
      'push', 'origin', 'abc1234:refs/heads/forge/task/T005'
    ]);
  });

  test('honors opts.remote override', () => {
    const runner = createRecordingGitRunner();
    startTaskBranch('T005', { runner, remote: 'upstream' });
    assert.match(runner.calls[0].args.join(' '), /upstream/);
  });

  test('opts.force adds --force-with-lease', () => {
    const runner = createRecordingGitRunner();
    startTaskBranch('T005', { runner, force: true });
    assert.ok(runner.calls[0].args.includes('--force-with-lease'));
  });

  test('surfaces git errors', () => {
    const runner = createRecordingGitRunner({ throwOn: () => true });
    assert.throws(() => startTaskBranch('T005', { runner }));
  });
});

suite('updateTaskBranch (R007, checkpoint refresh)', () => {
  test('always uses --force-with-lease', () => {
    const runner = createRecordingGitRunner();
    updateTaskBranch('T004', { runner });
    assert.ok(runner.calls[0].args.includes('--force-with-lease'));
  });
});

suite('deleteTaskBranch (R007, post-completion cleanup)', () => {
  test('push --delete with branch name', () => {
    const runner = createRecordingGitRunner();
    const r = deleteTaskBranch('T004', { runner });
    assert.strictEqual(r.deleted, true);
    assert.deepStrictEqual(runner.calls[0].args, [
      'push', 'origin', '--delete', 'forge/task/T004'
    ]);
  });

  test('non-fatal on git error -- returns deleted:false with reason', () => {
    const runner = createRecordingGitRunner({ throwOn: () => true });
    const r = deleteTaskBranch('T004', { runner });
    assert.strictEqual(r.deleted, false);
    assert.ok(r.error);
  });
});

suite('start + update + delete -- R007 lifecycle', () => {
  test('sequence mirrors Forge task lifecycle', () => {
    const runner = createRecordingGitRunner();
    startTaskBranch('T010', { runner });
    updateTaskBranch('T010', { runner });        // checkpoint 1
    updateTaskBranch('T010', { runner });        // checkpoint 2
    deleteTaskBranch('T010', { runner });        // post squash-merge
    assert.strictEqual(runner.calls.length, 4);
    const ops = runner.calls.map(c => c.args[0] + ' ' + (c.args.includes('--delete') ? 'delete' : c.args.includes('--force-with-lease') ? 'force-push' : 'push'));
    assert.deepStrictEqual(ops, ['push push', 'push force-push', 'push force-push', 'push delete']);
  });
});

// =====================================================================
// T009 -- research-type task execution (R014)
// =====================================================================

suite('isResearchTask (R014)', () => {
  test('true only for type=research tasks', () => {
    assert.strictEqual(isResearchTask({ type: 'research' }), true);
    assert.strictEqual(isResearchTask({ type: 'coding' }), false);
    assert.strictEqual(isResearchTask({}), false);
    assert.strictEqual(isResearchTask(null), false);
  });
});

suite('renderResearchResult (R014)', () => {
  test('renders frontmatter with task_id, researcher, completed_at', () => {
    const doc = renderResearchResult({
      taskId: 'C003', researcher: 'daniel',
      body: 'findings:\n- redis supports pub/sub natively',
      completedAt: '2026-04-19T01:00:00Z'
    });
    assert.match(doc, /task_id: C003/);
    assert.match(doc, /researcher: daniel/);
    assert.match(doc, /completed_at: 2026-04-19T01:00:00Z/);
    assert.match(doc, /redis supports pub\/sub/);
  });

  test('sanitizes researcher handle into frontmatter', () => {
    const doc = renderResearchResult({ taskId: 'C1', researcher: 'evil/../name', body: '' });
    assert.match(doc, /researcher: evil___\.\._name|researcher: evil_____name|researcher: evil_.._name/);
  });
});

suite('persistResearchResult (R014)', () => {
  test('writes file, stages, commits, pushes (happy path)', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const runner = createRecordingGitRunner();
    const r = persistResearchResult({
      collabDir, taskId: 'C003', researcher: 'daniel',
      body: 'findings...', cwd: projectDir, runner
    });
    assert.strictEqual(r.committed, true);
    assert.strictEqual(r.pushed, true);
    assert.ok(fs.existsSync(r.path));
    // Expect git add, commit, push in order
    const ops = runner.calls.map(c => c.args[0]);
    assert.deepStrictEqual(ops, ['add', 'commit', 'push']);
  });

  test('push=false writes file without any git invocations', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const runner = createRecordingGitRunner();
    const r = persistResearchResult({
      collabDir, taskId: 'C003', researcher: 'daniel',
      body: 'findings...', cwd: projectDir, runner, push: false
    });
    assert.strictEqual(r.committed, false);
    assert.strictEqual(r.pushed, false);
    assert.ok(fs.existsSync(r.path));
    assert.strictEqual(runner.calls.length, 0);
  });

  test('commit failure -> returns committed:false with error', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const runner = createRecordingGitRunner({ throwOn: (args) => args[0] === 'commit' });
    const r = persistResearchResult({
      collabDir, taskId: 'C003', researcher: 'daniel',
      body: 'findings...', cwd: projectDir, runner
    });
    assert.strictEqual(r.committed, false);
    assert.ok(r.error);
  });

  test('push failure after commit -> committed:true, pushed:false', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const runner = createRecordingGitRunner({ throwOn: (args) => args[0] === 'push' });
    const r = persistResearchResult({
      collabDir, taskId: 'C003', researcher: 'daniel',
      body: 'findings...', cwd: projectDir, runner
    });
    assert.strictEqual(r.committed, true);
    assert.strictEqual(r.pushed, false);
    assert.ok(r.error);
  });
});

suite('appendResearchSection (R014 streaming)', () => {
  test('creates file on first append + commits and pushes each section', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const runner = createRecordingGitRunner();
    const r1 = appendResearchSection({
      collabDir, taskId: 'C003', researcher: 'daniel',
      heading: 'Overview', body: 'redis supports pub/sub',
      cwd: projectDir, runner
    });
    assert.strictEqual(r1.appended, true);
    assert.strictEqual(r1.pushed, true);
    const r2 = appendResearchSection({
      collabDir, taskId: 'C003', researcher: 'daniel',
      heading: 'Benchmarks', body: 'read throughput: 100k/s',
      cwd: projectDir, runner
    });
    assert.strictEqual(r2.appended, true);
    assert.strictEqual(r2.pushed, true);
    const raw = fs.readFileSync(r1.path, 'utf8');
    assert.match(raw, /## Overview/);
    assert.match(raw, /## Benchmarks/);
    // Two full add+commit+push cycles
    const ops = runner.calls.map(c => c.args[0]);
    assert.deepStrictEqual(ops, ['add', 'commit', 'push', 'add', 'commit', 'push']);
  });
});

suite('mixed coding + research in a categorization', () => {
  test('only research tasks hit the research pipeline; coding stays unchanged', () => {
    const tasks = [
      { id: 'C001', type: 'coding',   title: 'implement something' },
      { id: 'C002', type: 'research', title: 'investigate library options' },
      { id: 'C003', type: 'coding',   title: 'wire up route' }
    ];
    const researchTasks = tasks.filter(isResearchTask);
    assert.strictEqual(researchTasks.length, 1);
    assert.strictEqual(researchTasks[0].id, 'C002');
  });
});

// =====================================================================
// T010 -- forward-motion flags + override UX + targeted notifications
//         (R008, R009, R015, R016)
// =====================================================================

suite('writeForwardMotionFlag -- phase guard (R008)', () => {
  test('rejected when not in executing phase', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    for (const phase of ['brainstorming', 'planning', 'reviewing_branch', 'verifying', 'idle']) {
      const r = await writeForwardMotionFlag({
        phase, collabDir, task_id: 'T001', author: 'd', decision: 'x'
      });
      assert.strictEqual(r.written, false, 'phase ' + phase + ' should reject');
      assert.strictEqual(r.reason, 'wrong_phase');
    }
  });

  test('accepted for executing and its sub-phases', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    for (const phase of ['executing', 'implementing', 'testing', 'reviewing', 'fixing', 'debugging']) {
      const r = await writeForwardMotionFlag({
        phase, collabDir, task_id: 'T001', author: 'd',
        decision: 'use-redis', alternatives: ['nats'], rationale: 'already in stack'
      });
      assert.strictEqual(r.written, true, 'phase ' + phase + ' should accept');
      assert.ok(fs.existsSync(r.path));
    }
  });
});

suite('writeForwardMotionFlag -- file + log (R008, R016)', () => {
  test('writes a flag file with full frontmatter', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T005', author: 'daniel',
      decision: 'redis', alternatives: ['nats', 'postgres-listen-notify'],
      rationale: 'already in stack, team familiarity',
      source_contributors: ['daniel', 'lucas'],
      body: 'Redis chosen because ...'
    });
    assert.strictEqual(r.written, true);
    const raw = fs.readFileSync(r.path, 'utf8');
    assert.match(raw, /decision: "redis"/);
    assert.match(raw, /alternatives: \["nats","postgres-listen-notify"\]/);
    assert.match(raw, /rationale: "already in stack, team familiarity"/);
    assert.match(raw, /source_contributors: \["daniel","lucas"\]/);
    assert.match(raw, /status: open/);
    assert.match(raw, /Redis chosen because/);
  });

  test('appends to user-scoped flag-emit log (R016)', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T005', author: 'daniel',
      decision: 'x', alternatives: [], rationale: 'r', source_contributors: []
    });
    const logPath = path.join(collabDir, 'flag-emit-log-daniel.jsonl');
    assert.ok(fs.existsSync(logPath));
    const line = fs.readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(line);
    assert.strictEqual(entry.task_id, 'T005');
    assert.strictEqual(entry.decision, 'x');
  });

  test('two flags produced simultaneously land at distinct paths (R016)', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r1 = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'a', decision: 'd1'
    });
    const r2 = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T2', author: 'b', decision: 'd2'
    });
    assert.strictEqual(r1.written, true);
    assert.strictEqual(r2.written, true);
    assert.notStrictEqual(r1.path, r2.path);
  });
});

suite('writeForwardMotionFlag -- targeted notification (R015)', () => {
  test('pings only the closest source_contributor, not other participants', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const sent = [];
    const transport = {
      async sendTargeted(handle, event, data) { sent.push({ handle, event, data }); },
      async publish(event, data) { sent.push({ broadcast: true, event, data }); }
    };
    const participants = [
      { handle: 'daniel', contributions: 'redis cache', active_tasks: 0 },
      { handle: 'lucas',  contributions: 'stripe payments', active_tasks: 0 },
      { handle: 'sarah',  contributions: 'react ui polish', active_tasks: 0 }
    ];
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T5', author: 'agent-bot',
      decision: 'use redis pubsub',
      alternatives: ['nats'],
      rationale: 'cache invalidation strategy',
      source_contributors: ['daniel'],
      participants,
      transport
    });
    assert.strictEqual(r.written, true);
    assert.strictEqual(r.notified.mode, 'targeted');
    assert.strictEqual(r.notified.target, 'daniel');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].handle, 'daniel');
  });

  test('broadcast fallback when no source contributors provided', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const sent = [];
    const transport = {
      async sendTargeted(h, e, d) { sent.push({ handle: h, event: e, data: d }); },
      async publish(e, d) { sent.push({ broadcast: true, event: e, data: d }); }
    };
    const participants = [
      { handle: 'a', contributions: 'x', active_tasks: 0 },
      { handle: 'b', contributions: 'x', active_tasks: 0 }
    ];
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T5', author: 'bot',
      decision: 'd', source_contributors: [],
      participants, transport, scorer: () => 0.5
    });
    assert.strictEqual(r.written, true);
    assert.strictEqual(r.notified.mode, 'broadcast');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].broadcast, true);
  });
});

suite('listFlags + readFlag (R009)', () => {
  test('lists all flags; filters by status', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'a', decision: 'x'
    });
    await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T2', author: 'a', decision: 'y'
    });
    const all = listFlags(collabDir);
    assert.strictEqual(all.length, 2);
    const open = listFlags(collabDir, { status: FLAG_STATUS.OPEN });
    assert.strictEqual(open.length, 2);
    const overridden = listFlags(collabDir, { status: FLAG_STATUS.OVERRIDDEN });
    assert.strictEqual(overridden.length, 0);
  });

  test('readFlag returns the flag or null', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'a', decision: 'x'
    });
    const loaded = readFlag(collabDir, r.id);
    assert.ok(loaded);
    assert.strictEqual(loaded.task_id, 'T1');
    assert.strictEqual(readFlag(collabDir, 'Fmissing1234'), null);
  });
});

suite('overrideFlag (R009)', () => {
  test('overriding an open flag updates decision and status', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'a', decision: 'redis'
    });
    const ov = overrideFlag(collabDir, r.id, 'nats', { author: 'lucas' });
    assert.strictEqual(ov.overridden, true);
    assert.strictEqual(ov.previousDecision, 'redis');
    const loaded = readFlag(collabDir, r.id);
    assert.strictEqual(loaded.status, FLAG_STATUS.OVERRIDDEN);
    assert.strictEqual(loaded.decision, 'nats');
    assert.match(fs.readFileSync(loaded.path, 'utf8'), /Previous decision: "redis"/);
  });

  test('missing flag returns overridden:false with reason', () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r = overrideFlag(collabDir, 'Fmissing', 'x');
    assert.strictEqual(r.overridden, false);
    assert.strictEqual(r.reason, 'not_found');
  });

  test('already-overridden flag returns overridden:false', async () => {
    const { projectDir } = makeTempForgeDir();
    const collabDir = path.join(projectDir, '.forge', 'collab');
    const r = await writeForwardMotionFlag({
      phase: 'executing', collabDir, task_id: 'T1', author: 'a', decision: 'redis'
    });
    overrideFlag(collabDir, r.id, 'nats', { author: 'lucas' });
    const r2 = overrideFlag(collabDir, r.id, 'postgres', { author: 'sarah' });
    assert.strictEqual(r2.overridden, false);
    assert.strictEqual(r2.reason, 'already_overridden');
  });
});

// =====================================================================
// T011 -- per-agent squash-merge with race-retry (R010, TDD)
// =====================================================================

function _mergeRunnerHelper(opts) {
  opts = opts || {};
  let pushesAttempted = 0;
  const failPushTimes = opts.failPushTimes || 0;
  const runner = (args) => {
    runner.calls.push(args.slice());
    if (args[0] === 'push') {
      pushesAttempted++;
      if (pushesAttempted <= failPushTimes) {
        const e = new Error('push rejected (simulated)');
        e.stderr = 'non-fast-forward: Updates were rejected because the remote contains work that you do not have locally';
        throw e;
      }
    }
    return '';
  };
  runner.calls = [];
  return runner;
}

suite('squashMergeAndPush -- happy path (R010)', () => {
  test('checks out main, squashes branch, commits, pushes', async () => {
    const runner = _mergeRunnerHelper();
    const r = await squashMergeAndPush({ taskId: 'T004', runner, sleep: async () => {} });
    assert.strictEqual(r.merged, true);
    assert.strictEqual(r.pushed, true);
    assert.strictEqual(r.attempts, 1);
    const ops = runner.calls.map(c => c[0] + (c[1] === '--squash' ? ' --squash' : ''));
    assert.ok(ops.includes('checkout'));
    assert.ok(ops.includes('merge --squash'));
    assert.ok(ops.includes('commit'));
    assert.ok(ops.includes('push'));
  });

  test('custom mainBranch + remote + commitMessage threaded through', async () => {
    const runner = _mergeRunnerHelper();
    await squashMergeAndPush({
      taskId: 'T004', runner, sleep: async () => {},
      mainBranch: 'trunk', remote: 'upstream', commitMessage: 'custom msg'
    });
    const commitCall = runner.calls.find(c => c[0] === 'commit');
    assert.deepStrictEqual(commitCall, ['commit', '-m', 'custom msg']);
    const pushCall = runner.calls.find(c => c[0] === 'push');
    assert.deepStrictEqual(pushCall, ['push', 'upstream', 'trunk']);
    const checkoutCall = runner.calls.find(c => c[0] === 'checkout');
    assert.deepStrictEqual(checkoutCall, ['checkout', 'trunk']);
  });
});

suite('squashMergeAndPush -- race retry (R010)', () => {
  test('one push rejection -> pull --rebase + retry -> success', async () => {
    const runner = _mergeRunnerHelper({ failPushTimes: 1 });
    let sleepCount = 0;
    const sleep = async (ms) => { sleepCount++; };
    const r = await squashMergeAndPush({ taskId: 'T004', runner, sleep });
    assert.strictEqual(r.merged, true);
    assert.strictEqual(r.pushed, true);
    assert.strictEqual(r.attempts, 2);
    const pulls = runner.calls.filter(c => c[0] === 'pull');
    assert.strictEqual(pulls.length, 1);
    assert.deepStrictEqual(pulls[0], ['pull', '--rebase', 'origin', 'main']);
    assert.strictEqual(sleepCount, 1, 'linear backoff should sleep once between retries');
  });

  test('two push rejections -> two pulls -> third push succeeds', async () => {
    const runner = _mergeRunnerHelper({ failPushTimes: 2 });
    const r = await squashMergeAndPush({ taskId: 'T004', runner, sleep: async () => {} });
    assert.strictEqual(r.pushed, true);
    assert.strictEqual(r.attempts, 3);
    const pulls = runner.calls.filter(c => c[0] === 'pull');
    assert.strictEqual(pulls.length, 2);
  });

  test('three rejections exhaust retries -> merged:true, pushed:false', async () => {
    const runner = _mergeRunnerHelper({ failPushTimes: 99 });
    const r = await squashMergeAndPush({ taskId: 'T004', runner, sleep: async () => {} });
    assert.strictEqual(r.merged, true);
    assert.strictEqual(r.pushed, false);
    assert.strictEqual(r.attempts, DEFAULT_MERGE_RETRIES);
    assert.match(r.error, /push rejected after/);
  });

  test('non-race failure (other push error) bubbles up', async () => {
    let calls = [];
    const runner = (args) => {
      calls.push(args);
      if (args[0] === 'push') {
        const e = new Error('permission denied');
        e.stderr = 'remote: permission to repo denied';
        throw e;
      }
      return '';
    };
    runner.calls = calls;
    let threw = null;
    try {
      await squashMergeAndPush({ taskId: 'T004', runner, sleep: async () => {} });
    } catch (e) { threw = e; }
    assert.ok(threw, 'non-race push errors should throw, not retry');
    assert.match(threw.message, /permission denied/);
    assert.strictEqual(calls.filter(c => c[0] === 'pull').length, 0);
  });

  test('two agents near-simultaneous -- both land cleanly (R010 AC)', async () => {
    // Agent A: no rejection (wins first). Agent B: one rejection then success.
    const runnerA = _mergeRunnerHelper({ failPushTimes: 0 });
    const runnerB = _mergeRunnerHelper({ failPushTimes: 1 });
    const rA = await squashMergeAndPush({ taskId: 'T004', runner: runnerA, sleep: async () => {} });
    const rB = await squashMergeAndPush({ taskId: 'T005', runner: runnerB, sleep: async () => {} });
    assert.strictEqual(rA.pushed, true);
    assert.strictEqual(rB.pushed, true);
    assert.strictEqual(rA.attempts, 1);
    assert.strictEqual(rB.attempts, 2);
  });
});

suite('squashMergeAndPush -- defaults', () => {
  test('DEFAULT_MERGE_RETRIES is 3 per R010 AC', () => {
    assert.strictEqual(DEFAULT_MERGE_RETRIES, 3);
  });
  test('DEFAULT_MERGE_BACKOFF_MS is positive (linear)', () => {
    assert.ok(DEFAULT_MERGE_BACKOFF_MS > 0);
  });
});

// =====================================================================
// T012 -- push-config inheritance + late-join (R011, R012)
// =====================================================================

suite('readAutoPushConfig (R011)', () => {
  test('defaults to true when config missing', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.rmSync(path.join(forgeDir, 'config.json'), { force: true });
    assert.strictEqual(readAutoPushConfig(forgeDir), true);
  });

  test('returns explicit true / false from top-level auto_push', () => {
    const a = makeTempForgeDir({ config: { auto_push: false } });
    assert.strictEqual(readAutoPushConfig(a.forgeDir), false);
    const b = makeTempForgeDir({ config: { auto_push: true } });
    assert.strictEqual(readAutoPushConfig(b.forgeDir), true);
  });

  test('supports collab.auto_push namespace', () => {
    const { forgeDir } = makeTempForgeDir({ config: { collab: { auto_push: false } } });
    assert.strictEqual(readAutoPushConfig(forgeDir), false);
  });

  test('malformed config defaults to true (safe)', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, 'config.json'), '{not json');
    assert.strictEqual(readAutoPushConfig(forgeDir), true);
  });
});

suite('gatedPush (R011)', () => {
  test('auto_push enabled -> silent push, no prompter call', async () => {
    const runner = createRecordingGitRunner();
    let prompted = 0;
    const r = await gatedPush(['push', 'origin', 'main'], {
      autoPush: true, runner, prompter: async () => { prompted++; return true; }
    });
    assert.strictEqual(r.pushed, true);
    assert.strictEqual(runner.calls.length, 1);
    assert.strictEqual(prompted, 0);
  });

  test('auto_push disabled -> prompter called; true proceeds', async () => {
    const runner = createRecordingGitRunner();
    let seenArgs = null;
    const r = await gatedPush(['push', 'origin', 'main'], {
      autoPush: false, runner,
      prompter: async (info) => { seenArgs = info.args; return true; }
    });
    assert.strictEqual(r.pushed, true);
    assert.deepStrictEqual(seenArgs, ['push', 'origin', 'main']);
  });

  test('auto_push disabled + prompter returns false -> user_declined', async () => {
    const runner = createRecordingGitRunner();
    const r = await gatedPush(['push', 'origin', 'main'], {
      autoPush: false, runner, prompter: async () => false
    });
    assert.strictEqual(r.pushed, false);
    assert.strictEqual(r.reason, 'user_declined');
    assert.strictEqual(runner.calls.length, 0);
  });

  test('auto_push disabled + no prompter -> auto_push_disabled_no_prompter', async () => {
    const runner = createRecordingGitRunner();
    const r = await gatedPush(['push', 'origin', 'main'], { autoPush: false, runner });
    assert.strictEqual(r.pushed, false);
    assert.strictEqual(r.reason, 'auto_push_disabled_no_prompter');
  });

  test('opts.forgeDir reads config when autoPush not given', async () => {
    const runner = createRecordingGitRunner();
    const { forgeDir } = makeTempForgeDir({ config: { auto_push: false } });
    const r = await gatedPush(['push', 'origin', 'main'], {
      forgeDir, runner, prompter: async () => true
    });
    assert.strictEqual(r.pushed, true); // prompter returned true
  });
});

suite('filterClaimableForLateJoin (R012)', () => {
  test('skips already-claimed tasks', () => {
    const t = createMemoryTransport();
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 120, now: 1_000_000 });
    claimTask(t, 'T005', 'lucas',  { ttlSeconds: 120, now: 1_000_000 });
    const claimable = filterClaimableForLateJoin(t, ['T004', 'T005', 'T006', 'T007'], { now: 1_000_000 + 1000 });
    assert.deepStrictEqual(claimable.sort(), ['T006', 'T007']);
  });

  test('stale claims DO become claimable', () => {
    const t = createMemoryTransport();
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 10, now: 1_000_000 });
    const claimable = filterClaimableForLateJoin(t, ['T004'], { now: 1_000_000 + 60_000 });
    assert.deepStrictEqual(claimable, ['T004']);
  });

  test('empty unblocked list -> empty claimable', () => {
    const t = createMemoryTransport();
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 120, now: 1_000_000 });
    assert.deepStrictEqual(filterClaimableForLateJoin(t, [], { now: 1_000_000 + 1000 }), []);
  });
});

suite('lateJoinBootstrap (R012)', () => {
  test('runs git pull, connects transport, returns claimable', async () => {
    const runner = createRecordingGitRunner();
    const t = createMemoryTransport();
    // connect() is absent on memory transport; should not fail.
    claimTask(t, 'T004', 'daniel', { ttlSeconds: 120, now: 1_000_000 });
    const r = await lateJoinBootstrap({
      transport: t,
      unblockedTaskIds: ['T004', 'T005', 'T006'],
      runner,
      cwd: '/tmp/repo',
      now: 1_000_000 + 1000
    });
    assert.strictEqual(r.joined, true);
    assert.deepStrictEqual(r.claimable.sort(), ['T005', 'T006']);
    const pullCall = runner.calls.find(c => c.args[0] === 'pull').args;
    assert.deepStrictEqual(pullCall, ['pull', 'origin', 'main']);
  });

  test('git pull failure -> joined:false, reason: git_pull_failed', async () => {
    const runner = createRecordingGitRunner({ throwOn: (args) => args[0] === 'pull' });
    const t = createMemoryTransport();
    const r = await lateJoinBootstrap({
      transport: t, unblockedTaskIds: ['T001'], runner, cwd: '/tmp/repo'
    });
    assert.strictEqual(r.joined, false);
    assert.strictEqual(r.reason, 'git_pull_failed');
  });

  test('custom remote/branch threaded through', async () => {
    const runner = createRecordingGitRunner();
    const t = createMemoryTransport();
    await lateJoinBootstrap({
      transport: t, unblockedTaskIds: ['T001'], runner,
      remote: 'upstream', branch: 'trunk'
    });
    const pullCall = runner.calls.find(c => c.args[0] === 'pull').args;
    assert.deepStrictEqual(pullCall, ['pull', 'upstream', 'trunk']);
  });

  test('skipGitPull bypasses pull for tests', async () => {
    const runner = createRecordingGitRunner();
    const t = createMemoryTransport();
    const r = await lateJoinBootstrap({
      transport: t, unblockedTaskIds: ['T001'], runner, skipGitPull: true
    });
    assert.strictEqual(r.joined, true);
    assert.strictEqual(runner.calls.length, 0);
  });
});

runTests();
