// scripts/forge-collab.cjs
//
// Forge collab subsystem -- hackathon-native multiplayer mode (spec-collab).
//
// This module is loaded only when the user opts into collab mode via
// /forge:collaborate. Default single-user Forge never requires it.
//
// T001 (R001) establishes the module scaffold and the session-id primitive
// that all later tasks (claim queue, transport, brainstorm, flags) build on.
//
// Later tasks will add:
//   T002 routing, T003 claim queue + consolidation-lease, T004 transport,
//   T005 package.json peerDependency, T006 flag-id + user-scoped logs,
//   T007 brainstorm chat mode + consolidate + categorize,
//   T008 per-task branches, T009 research-type execution,
//   T010 flags + review/override + targeted notifications,
//   T011 squash-merge race-retry, T012 push-config + late-join.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_EPSILON = 0.05;
const DEFAULT_CLAIM_TTL_SECONDS = 120;
const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_CONSOLIDATION_TTL_SECONDS = 30;
const CLAIM_PREFIX = 'claim:';

/**
 * Return the origin remote URL for the repo at `cwd`, or throw if none exists.
 */
function readOriginUrl(cwd) {
  let out;
  try {
    out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    // git failed: not a repo, or no origin remote, or git missing.
    const stderr = (e && e.stderr && e.stderr.toString()) || '';
    if (/No such remote|no such remote|does not exist/i.test(stderr)) {
      throw new Error(
        'forge:collab requires an `origin` git remote. ' +
        'Set one with `git remote add origin <url>`.'
      );
    }
    if (/not a git repository/i.test(stderr)) {
      throw new Error(
        'forge:collab must be run inside a git repository (no git repo detected at ' +
        (cwd || process.cwd()) + ').'
      );
    }
    throw new Error(
      'forge:collab could not read origin remote: ' + (stderr.trim() || e.message)
    );
  }
  return out.trim();
}

/**
 * Derive a stable 12-hex-character session ID from the repository's origin URL.
 *
 * Two clones of the same remote produce the same ID; different remotes produce
 * different IDs. This is the zero-config join primitive for /forge:collaborate.
 *
 * Options:
 *   - origin  explicit origin URL (skips git lookup -- used in tests and CI)
 *   - cwd     directory to inspect when reading `origin` from git
 *
 * Throws with a clear message when no origin remote exists or when called
 * outside a git repository.
 */
function sessionIdFromOrigin(opts) {
  opts = opts || {};
  const url = opts.origin != null ? opts.origin : readOriginUrl(opts.cwd);
  if (typeof url !== 'string' || !url.length) {
    throw new Error('forge:collab sessionIdFromOrigin requires a non-empty origin url');
  }
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/**
 * Read the configured routing epsilon from `.forge/config.json`, returning
 * null if the file or key is missing or malformed.
 *
 * Default path ("collab.route.epsilon") matches spec-collab R005 AC.
 */
function _readEpsilonFromConfig(forgeDir) {
  try {
    if (!forgeDir) return null;
    const p = path.join(forgeDir, 'config.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const cfg = JSON.parse(raw);
    const v = cfg && cfg.collab && cfg.collab.route && cfg.collab.route.epsilon;
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  } catch (_) { /* fall through to null */ }
  return null;
}

function _tokenSet(text) {
  if (text == null) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/**
 * Default zero-dep similarity scorer: normalized Jaccard over token sets.
 *
 * Production callers should inject an LLM-backed scorer via opts.scorer for
 * higher fidelity (per spec-collab R005 AC, the real scorer is an LLM
 * classification call). The Jaccard fallback keeps the primitive testable
 * and usable without network calls while later tasks wire the LLM path.
 */
function _heuristicScorer(targetText, contributions) {
  const a = _tokenSet(targetText);
  const b = _tokenSet(contributions);
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * Score a single participant's relevance to `targetText`.
 *
 * Returns a number in [0, 1]. Participants with no contributions score
 * exactly 0 per spec-collab R005 AC. Unrecognized or non-numeric scorer
 * output also clamps to 0.
 *
 * opts.scorer: (targetText, contributions, participant) => number in [0,1]
 *              Inject to swap the default Jaccard heuristic for an LLM call.
 */
function scoreParticipant(targetText, participant, opts) {
  opts = opts || {};
  const contrib = (participant && participant.contributions) || '';
  if (!contrib || !String(contrib).trim()) return 0;
  const scorer = typeof opts.scorer === 'function' ? opts.scorer : _heuristicScorer;
  const raw = scorer(targetText, contrib, participant);
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Pick the participant best matched to `targetText`, combining similarity
 * with active-load penalty: `similarity * (1 / (1 + active_tasks))`.
 *
 * Returns the chosen handle, or the sentinel "broadcast" when the top two
 * combined scores tie within epsilon (default 0.05, overridable via opts or
 * via `collab.route.epsilon` in `.forge/config.json`).
 *
 * Participants are expected to shape as { handle, contributions, active_tasks? }.
 * Deterministic tiebreak on handle string order avoids per-run drift.
 */
function routeToParticipant(targetText, participants, opts) {
  opts = opts || {};
  if (!Array.isArray(participants) || participants.length === 0) return 'broadcast';

  let epsilon = DEFAULT_EPSILON;
  if (typeof opts.epsilon === 'number') {
    epsilon = opts.epsilon;
  } else if (opts.forgeDir) {
    const fromCfg = _readEpsilonFromConfig(opts.forgeDir);
    if (fromCfg !== null) epsilon = fromCfg;
  }

  const scored = participants.map(p => {
    const sim = scoreParticipant(targetText, p, opts);
    const active = Number(p && p.active_tasks) || 0;
    const loadPenalty = 1 / (1 + active);
    return { handle: p.handle, combined: sim * loadPenalty, sim };
  });

  scored.sort((a, b) => {
    if (b.combined !== a.combined) return b.combined - a.combined;
    if (a.handle < b.handle) return -1;
    if (a.handle > b.handle) return 1;
    return 0;
  });

  const top = scored[0];
  if (!top || top.combined === 0) return 'broadcast';
  const second = scored[1];
  if (second && (top.combined - second.combined) <= epsilon) return 'broadcast';
  return top.handle;
}

// ======================================================================
// T003 -- distributed claim queue + consolidation-lease primitive (R006, R016)
//
// One generic lease primitive, two use cases:
//   * Task claims are leases namespaced `claim:<taskId>` with TTL ~120s.
//   * Single-writer coordination (R016) uses a short-lived lease named
//     e.g. "consolidation" with TTL <= 30s.
//
// The transport backend is injectable so T004 can swap in Ably / polling
// branch implementations without touching this primitive. An in-memory
// transport ships here for tests and as the shape reference.
// ======================================================================

function _nowMs(opts) {
  return (opts && typeof opts.now === 'number') ? opts.now : Date.now();
}

/**
 * In-memory lease transport -- the reference shape for T004 backends.
 *
 * Contract (all methods synchronous in this shape; real backends may be async):
 *   read(name) -> lease | null
 *   cas(name, expected, next) -> boolean   atomic compare-and-set; null expected
 *                                           means "only succeed if no current entry"
 *   del(name, expected) -> boolean         atomic delete-if-match
 *   list() -> lease[]
 *
 * A lease object is shaped { name, claimant, acquiredAt, expiresAt }.
 */
function createMemoryTransport() {
  const store = new Map();
  function read(name) {
    return store.has(name) ? Object.assign({}, store.get(name)) : null;
  }
  function _same(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.claimant === b.claimant && a.acquiredAt === b.acquiredAt;
  }
  function cas(name, expected, next) {
    const current = store.has(name) ? store.get(name) : null;
    if (expected === null) {
      if (current !== null) return false;
    } else if (!_same(current, expected)) {
      return false;
    }
    if (next === null) {
      store.delete(name);
    } else {
      store.set(name, Object.assign({}, next));
    }
    return true;
  }
  function del(name, expected) {
    return cas(name, expected, null);
  }
  function list() {
    return Array.from(store.values()).map(v => Object.assign({}, v));
  }
  return { read, cas, del, list };
}

function _isExpired(lease, now) {
  if (!lease || !lease.expiresAt) return true;
  return Date.parse(lease.expiresAt) <= now;
}

/**
 * Try to acquire the lease `name` for `claimant`. Returns:
 *   { acquired: true, lease } on success (including stale-takeover)
 *   { acquired: false, reason, holder } when another live claimant holds it
 *
 * opts:
 *   ttlSeconds  lease lifetime (default 120s for claims; callers override
 *               to 30s for consolidation or other short-lived leases)
 *   now         optional override for deterministic tests (ms since epoch)
 */
function tryAcquireLease(transport, name, claimant, opts) {
  opts = opts || {};
  if (!transport || typeof transport.read !== 'function') {
    throw new Error('tryAcquireLease requires a transport object');
  }
  if (!name) throw new Error('tryAcquireLease requires a lease name');
  if (!claimant) throw new Error('tryAcquireLease requires a claimant handle');
  const ttl = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : DEFAULT_CLAIM_TTL_SECONDS;
  const now = _nowMs(opts);
  const current = transport.read(name);
  const expiresAt = new Date(now + ttl * 1000).toISOString();
  const acquiredAt = new Date(now).toISOString();
  const next = { name, claimant, acquiredAt, expiresAt };

  if (current && !_isExpired(current, now) && current.claimant !== claimant) {
    return {
      acquired: false,
      reason: 'held_by_' + current.claimant,
      holder: current
    };
  }

  // Either fresh, stale, or already ours -> take/refresh.
  const ok = transport.cas(name, current, next);
  if (!ok) {
    const nowHolder = transport.read(name);
    return {
      acquired: false,
      reason: 'lost_race',
      holder: nowHolder
    };
  }
  return { acquired: true, lease: next, tookOverStale: !!(current && _isExpired(current, now)) };
}

/**
 * Refresh the lease `name`. Succeeds only if `claimant` currently holds it.
 */
function refreshLease(transport, name, claimant, opts) {
  opts = opts || {};
  const ttl = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : DEFAULT_CLAIM_TTL_SECONDS;
  const now = _nowMs(opts);
  const current = transport.read(name);
  if (!current) return { refreshed: false, reason: 'not_held' };
  if (current.claimant !== claimant) {
    return { refreshed: false, reason: 'held_by_other', holder: current };
  }
  const next = Object.assign({}, current, {
    expiresAt: new Date(now + ttl * 1000).toISOString()
  });
  const ok = transport.cas(name, current, next);
  if (!ok) return { refreshed: false, reason: 'lost_race' };
  return { refreshed: true, lease: next };
}

/**
 * Release the lease `name` held by `claimant`. Idempotent: calling release
 * on a lease you do not hold returns { released: true, noop: true } rather
 * than throwing -- this matches the existing Forge lock semantics.
 */
function releaseLease(transport, name, claimant) {
  const current = transport.read(name);
  if (!current) return { released: true, noop: true };
  if (current.claimant !== claimant) {
    return { released: false, reason: 'held_by_other', holder: current };
  }
  const ok = transport.del(name, current);
  if (!ok) return { released: false, reason: 'lost_race' };
  return { released: true };
}

function readLease(transport, name, opts) {
  const now = _nowMs(opts);
  const current = transport.read(name);
  if (!current) return null;
  return Object.assign({}, current, { stale: _isExpired(current, now) });
}

/**
 * Scoped helper: run `fn` while holding the lease, release afterward.
 * On contention returns { held: false, ... } without running fn -- callers
 * see "defer or abort cleanly" semantics per spec-collab R016 AC.
 */
async function withLease(transport, name, claimant, opts, fn) {
  if (typeof fn !== 'function') throw new Error('withLease requires a function as last arg');
  const acq = tryAcquireLease(transport, name, claimant, opts);
  if (!acq.acquired) return { held: false, reason: acq.reason, holder: acq.holder };
  try {
    const result = await fn(acq.lease);
    return { held: true, result, lease: acq.lease };
  } finally {
    releaseLease(transport, name, claimant);
  }
}

// ======================================================================
// Task-claim wrappers -- thin names on top of the generic lease primitive.
// ======================================================================

function _claimName(taskId) { return CLAIM_PREFIX + String(taskId); }

function claimTask(transport, taskId, claimant, opts) {
  return tryAcquireLease(transport, _claimName(taskId), claimant, opts);
}

function heartbeatTaskClaim(transport, taskId, claimant, opts) {
  return refreshLease(transport, _claimName(taskId), claimant, opts);
}

function releaseTaskClaim(transport, taskId, claimant) {
  return releaseLease(transport, _claimName(taskId), claimant);
}

function readTaskClaim(transport, taskId, opts) {
  return readLease(transport, _claimName(taskId), opts);
}

function listActiveTaskClaims(transport, opts) {
  const now = _nowMs(opts);
  return (transport.list() || [])
    .filter(l => l && typeof l.name === 'string' && l.name.startsWith(CLAIM_PREFIX))
    .filter(l => !_isExpired(l, now))
    .map(l => Object.assign({}, l, { task_id: l.name.slice(CLAIM_PREFIX.length) }));
}

module.exports = {
  sessionIdFromOrigin,
  scoreParticipant,
  routeToParticipant,
  DEFAULT_EPSILON,
  DEFAULT_CLAIM_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_CONSOLIDATION_TTL_SECONDS,
  createMemoryTransport,
  tryAcquireLease,
  refreshLease,
  releaseLease,
  readLease,
  withLease,
  claimTask,
  heartbeatTaskClaim,
  releaseTaskClaim,
  readTaskClaim,
  listActiveTaskClaims,
  // Exposed for tests and future-task extension points:
  _internal: { readOriginUrl, _heuristicScorer, _readEpsilonFromConfig, _tokenSet, _isExpired, _claimName }
};
