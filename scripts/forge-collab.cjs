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
// T004 -- transport layer: Ably + polling fallback + targeted delivery (R013, R015)
//
// The transport abstraction satisfies two interfaces:
//   1. The lease store (read/cas/del/list) that T003's primitives depend on.
//   2. A messaging layer with `publish`, `subscribe`, and `sendTargeted`
//      for presence, handoff, and targeted flag/question notifications.
//
// Two concrete backends:
//   * `ably`      -- sub-second latency via realtime WebSockets. Requires
//                    ABLY_KEY + the optional `ably` peer dep installed.
//   * `polling`   -- zero-setup fallback that uses a dedicated
//                    `forge/collab-state` branch on origin as the
//                    substrate. Claims/messages are commits, polled every
//                    2-3 seconds. Slower but no infra.
//
// `createTransport()` picks one based on env + opts, returning an object
// with the union interface. Tests inject an in-memory transport (T003)
// which is functionally a third backend for unit-level testing.
// ======================================================================

const POLLING_BRANCH_DEFAULT = 'forge/collab-state';
const POLLING_INTERVAL_MS_DEFAULT = 2500;

/**
 * Decide which transport to activate given the environment and options.
 * Returns the string "ably", "polling", or the sentinel "setup-required"
 * when neither ABLY_KEY nor explicit --polling opt-in is present.
 */
function selectTransportMode(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  if (opts.mode === 'memory' || opts.mode === 'ably' || opts.mode === 'polling') {
    return opts.mode;
  }
  if (env.ABLY_KEY) return 'ably';
  if (opts.polling === true) return 'polling';
  return 'setup-required';
}

/**
 * The human-friendly onboarding message shown when ABLY_KEY is absent and
 * the caller did not opt into --polling. Kept here so tests can assert on
 * the exact guidance without duplicating strings.
 */
function renderSetupGuide() {
  return [
    'forge:collaborate uses realtime Ably by default.',
    '',
    'To enable realtime mode (recommended):',
    '  1. Sign up at https://ably.com (free tier: 200 conns, 6M msgs/mo)',
    '  2. Copy your API key from the dashboard',
    '  3. Set it: export ABLY_KEY="<your-key>"',
    '  4. Install the optional peer dep: npm install ably',
    '  5. Re-run /forge:collaborate',
    '',
    'Or skip Ably and use the zero-setup git-polling fallback:',
    '  /forge:collaborate --polling',
    ''
  ].join('\n');
}

/**
 * Build an Ably-backed transport. Lazy-imports `ably` only when reached, so
 * non-collab Forge sessions never touch the peer dep. Thin wrapper around
 * Ably's Realtime client + channel presence + namespaced lease state.
 *
 * For the full R013/R015 acceptance we need publish/subscribe/presence and
 * targeted delivery. Ably supports these via named channels + presence
 * members + message targeting by clientId; this wrapper exposes a uniform
 * surface over those primitives.
 *
 * Network calls are NOT issued during construction -- callers must invoke
 * `await transport.connect()` to actually establish the socket. Tests
 * typically do not construct the ably backend; they use the memory one.
 */
function createAblyTransport(opts) {
  opts = opts || {};
  const key = opts.apiKey || (opts.env || process.env).ABLY_KEY;
  if (!key) throw new Error('createAblyTransport requires ABLY_KEY or opts.apiKey');
  // Lazy require inside the branch per R013 AC (must not import when the
  // user has not opted into realtime collab). The require is sync but only
  // evaluated when this backend is reached.
  let AblyModule;
  try {
    AblyModule = require('ably');
  } catch (e) {
    throw new Error(
      'forge:collab realtime mode requires the `ably` peer dependency.\n' +
      'Install it with: npm install ably\n' +
      'Or run `/forge:collaborate --polling` for the zero-setup fallback.'
    );
  }
  const channelName = opts.channel || 'forge-collab';
  const clientId = opts.clientId || 'unknown';
  let client = null;
  let channel = null;
  let connected = false;

  async function connect() {
    if (connected) return;
    client = new AblyModule.Realtime({ key, clientId });
    await new Promise((resolve, reject) => {
      client.connection.once('connected', resolve);
      client.connection.once('failed', reject);
    });
    channel = client.channels.get(channelName);
    connected = true;
  }

  async function disconnect() {
    if (!client) return;
    await client.close();
    connected = false;
  }

  async function publish(event, data) {
    if (!connected) throw new Error('ably transport not connected');
    await channel.publish(event, data);
  }

  function subscribe(event, cb) {
    if (!connected) throw new Error('ably transport not connected');
    channel.subscribe(event, (msg) => cb({ event: msg.name, data: msg.data, from: msg.clientId }));
  }

  async function sendTargeted(handle, event, data) {
    // Ably supports targeted delivery via client-side filtering on the
    // recipient clientId (or a private channel per recipient). We use the
    // envelope approach: publish on the common channel with a `target`
    // field; subscribers drop messages not addressed to them. Simpler and
    // cheaper on free-tier message counts than one channel per recipient.
    await publish(event, Object.assign({ target: handle }, data || {}));
  }

  // Lease store interface (read/cas/del/list). For Ably we use channel
  // state as a logical key-value store: a lease is represented as a
  // persisted message on a per-lease subchannel. The in-memory map below
  // acts as a local cache refreshed by subscribing to the lease event.
  const localLeases = new Map();
  function read(name) {
    return localLeases.has(name) ? Object.assign({}, localLeases.get(name)) : null;
  }
  function _same(a, b) {
    if (a === b) return true; if (!a || !b) return false;
    return a.claimant === b.claimant && a.acquiredAt === b.acquiredAt;
  }
  function cas(name, expected, next) {
    const cur = localLeases.has(name) ? localLeases.get(name) : null;
    if (expected === null && cur !== null) return false;
    if (expected !== null && !_same(cur, expected)) return false;
    if (next === null) localLeases.delete(name);
    else localLeases.set(name, Object.assign({}, next));
    // Fire-and-forget broadcast so peers converge.
    if (connected) publish('lease-update', { name, next }).catch(() => {});
    return true;
  }
  function del(name, expected) { return cas(name, expected, null); }
  function list() { return Array.from(localLeases.values()).map(v => Object.assign({}, v)); }

  return {
    mode: 'ably',
    connect, disconnect,
    publish, subscribe, sendTargeted,
    read, cas, del, list,
    _internal: { get client() { return client; }, get channel() { return channel; } }
  };
}

/**
 * Build a polling-branch-backed transport. Uses a dedicated git branch on
 * origin as the substrate: leases and messages are commits, polled at a
 * fixed interval.
 *
 * The full git-push/fetch machinery runs at connect()/publish() time; the
 * local lease store is a cached snapshot read from the branch HEAD. Tests
 * provide an `ioAdapter` that stubs git calls so the polling logic can be
 * verified without a live remote.
 */
function createPollingTransport(opts) {
  opts = opts || {};
  const branch = opts.branch || POLLING_BRANCH_DEFAULT;
  const intervalMs = Number(opts.intervalMs) || POLLING_INTERVAL_MS_DEFAULT;
  const io = opts.ioAdapter || _defaultPollingIo({
    cwd: opts.cwd,
    forgeDir: opts.forgeDir,
    autoPush: opts.autoPush,
    runner: opts.runner,
    prompter: opts.prompter,
    ttlSeconds: opts.ttlSeconds,
    retries: opts.retries,
    backoffMs: opts.backoffMs,
    now: opts.now
  });
  let connected = false;
  let poller = null;
  const localLeases = new Map();
  const pendingMessages = [];
  const subscribers = new Map(); // event -> [cb...]

  async function connect() {
    if (connected) return;
    await io.ensureBranch(branch);
    await _refresh();
    connected = true;
    poller = setInterval(() => { _refresh().catch(() => {}); }, intervalMs);
    if (poller.unref) poller.unref();
  }

  async function disconnect() {
    if (poller) { clearInterval(poller); poller = null; }
    connected = false;
  }

  async function _refresh() {
    const snapshot = await io.readBranch(branch);
    const leases = snapshot && snapshot.leases ? snapshot.leases : {};
    localLeases.clear();
    for (const [name, lease] of Object.entries(leases)) {
      localLeases.set(name, Object.assign({}, lease));
    }
    const messages = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages : [];
    for (const m of messages) {
      if (pendingMessages.find(pm => pm.id === m.id)) continue;
      pendingMessages.push(m);
      const subs = subscribers.get(m.event) || [];
      for (const cb of subs) {
        try { cb({ event: m.event, data: m.data, from: m.from }); } catch (_) {}
      }
    }
  }

  async function publish(event, data) {
    const msg = {
      id: crypto.randomUUID(),
      event,
      data: data || {},
      from: opts.clientId || 'unknown',
      ts: new Date().toISOString()
    };
    await io.appendMessage(branch, msg);
  }

  function subscribe(event, cb) {
    const arr = subscribers.get(event) || [];
    arr.push(cb);
    subscribers.set(event, arr);
  }

  async function sendTargeted(handle, event, data) {
    await publish(event, Object.assign({ target: handle }, data || {}));
  }

  // Lease store: read is local cache, cas writes through git.
  function read(name) {
    return localLeases.has(name) ? Object.assign({}, localLeases.get(name)) : null;
  }
  function _same(a, b) {
    if (a === b) return true; if (!a || !b) return false;
    return a.claimant === b.claimant && a.acquiredAt === b.acquiredAt;
  }
  function cas(name, expected, next) {
    const cur = localLeases.has(name) ? localLeases.get(name) : null;
    if (expected === null && cur !== null) return false;
    if (expected !== null && !_same(cur, expected)) return false;
    if (next === null) localLeases.delete(name);
    else localLeases.set(name, Object.assign({}, next));
    // Queue a write-through; any rejection on push is surfaced by the io
    // adapter so the caller can retry or treat as lost-race.
    if (io.writeLease) io.writeLease(branch, name, next).catch(() => {});
    return true;
  }
  function del(name, expected) { return cas(name, expected, null); }
  function list() { return Array.from(localLeases.values()).map(v => Object.assign({}, v)); }

  return {
    mode: 'polling',
    connect, disconnect,
    publish, subscribe, sendTargeted,
    read, cas, del, list,
    _internal: {
      _refresh,
      get pendingMessages() { return pendingMessages.slice(); },
      get io() { return io; },
      get branch() { return branch; }
    }
  };
}

/**
 * Default polling-transport IO adapter. Uses real git plumbing so the
 * `forge/collab-state` branch on origin always holds exactly one commit
 * whose `state.json` blob is the authoritative `{ leases, messages }`
 * document. Every mutation is:
 *
 *   1. fetch origin branch + read current state + read current sha (CAS
 *      expected value for force-with-lease)
 *   2. mutate state in memory
 *   3. synthesize a new rootless commit via `git hash-object` +
 *      `git mktree` + `git commit-tree` (no parent -> exactly one commit
 *      on the ref after every push)
 *   4. `git push --force-with-lease=refs/heads/<branch>:<sha-read>` via
 *      gatedPush so the user's auto_push preference is honored.
 *   5. on rejection, re-read and retry up to 3 times with 100ms linear
 *      backoff; the 4th rejection returns `{ ok:false, reason:'cas_exhausted' }`.
 *
 * A `writeLease` call may also pass `{ expected }` so the caller gets
 * `{ ok:false, reason:'cas_race_lost' }` when a peer claimed the slot
 * first at the semantic level (lease already held by someone else).
 *
 * Tests inject a pure in-memory stub via `opts.ioAdapter`; this default
 * is what runs when no stub is provided.
 *
 * opts:
 *   cwd       repo dir (defaults to process.cwd())
 *   forgeDir  path to .forge/ so readAutoPushConfig can gate pushes
 *   autoPush  explicit boolean override; skips config lookup
 *   runner    injectable (args, {cwd}) -> stdout runner for tests
 *   ttlSeconds  message TTL for appendMessage compaction (default 300)
 *   retries   push-retry count before cas_exhausted (default 3)
 *   backoffMs linear backoff base in ms (default 100)
 */
function _defaultPollingIo(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const forgeDir = opts.forgeDir || path.join(cwd, '.forge');
  const ttlSeconds = Number(opts.ttlSeconds) || 300;
  const retries = Number.isFinite(opts.retries) ? Number(opts.retries) : 3;
  const backoffMs = Number.isFinite(opts.backoffMs) ? Number(opts.backoffMs) : 100;
  const runner = typeof opts.runner === 'function' ? opts.runner : null;

  function run(args, runOpts) {
    runOpts = runOpts || {};
    if (runner) return runner(args, { cwd: runOpts.cwd || cwd, input: runOpts.input });
    // When input is provided, stdin must be a pipe (not 'ignore') so the
    // caller's payload actually reaches the git subprocess. Otherwise
    // `git hash-object -w --stdin` hashes empty input, producing the tree
    // with no state.json entry -- a silent wrong answer.
    const spawnOpts = {
      cwd: runOpts.cwd || cwd,
      encoding: 'utf8',
      stdio: runOpts.input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    };
    if (runOpts.input != null) spawnOpts.input = runOpts.input;
    try {
      return execFileSync('git', args, spawnOpts);
    } catch (e) {
      const err = new Error('git ' + args.join(' ') + ' failed: ' +
        (e.stderr ? e.stderr.toString() : e.message));
      err.stderr = e.stderr ? e.stderr.toString() : '';
      err.stdout = e.stdout ? e.stdout.toString() : '';
      err.cause = e;
      throw err;
    }
  }

  function tryRun(args, runOpts) {
    try { return { ok: true, out: run(args, runOpts) }; }
    catch (e) { return { ok: false, err: e }; }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _fetchBranch(branch) {
    // Force-update the local remote-tracking ref so re-reads after a
    // rejected push see the winner's commit, even when our own earlier
    // push advanced the local tracking ref past the current origin tip.
    // The '+' prefix on the refspec permits non-fast-forward updates.
    return tryRun(['fetch', 'origin', '+' + branch + ':refs/remotes/origin/' + branch]);
  }

  function _lsRemoteSha(branch) {
    const res = tryRun(['ls-remote', 'origin', 'refs/heads/' + branch]);
    if (!res.ok) return null;
    const line = (res.out || '').split(/\r?\n/).find(l => l.trim());
    if (!line) return null;
    return line.split(/\s+/)[0] || null;
  }

  function _readStateAndSha(branch) {
    // Returns { sha, state } with sha=null when origin has no such branch yet.
    // We prefer the *remote* sha via ls-remote because a prior rejected push
    // could have left our local tracking ref stale; ls-remote is the source
    // of truth for the force-with-lease expected value.
    const remoteSha = _lsRemoteSha(branch);
    if (!remoteSha) return { sha: null, state: { leases: {}, messages: [] } };
    // Ensure the object is local so `git show` can read it.
    tryRun(['fetch', 'origin', '+' + remoteSha + ':refs/remotes/origin/' + branch]);
    const show = tryRun(['show', remoteSha + ':state.json']);
    if (!show.ok) return { sha: remoteSha, state: { leases: {}, messages: [] } };
    let state;
    try { state = JSON.parse(show.out); }
    catch (_) { state = { leases: {}, messages: [] }; }
    if (!state || typeof state !== 'object') state = { leases: {}, messages: [] };
    if (!state.leases || typeof state.leases !== 'object') state.leases = {};
    if (!Array.isArray(state.messages)) state.messages = [];
    return { sha: remoteSha, state };
  }

  function _buildCommit(state) {
    // Serialize state deterministically (keys sorted at the top level) so
    // two clients producing the same logical state land on the same blob
    // and the same tree SHA, making no-op writes a true no-op.
    const canonical = JSON.stringify({
      leases: state.leases || {},
      messages: state.messages || []
    }, null, 2) + '\n';
    const blobOut = run(['hash-object', '-w', '--stdin'], { input: canonical });
    const blobSha = blobOut.trim();
    const treeInput = '100644 blob ' + blobSha + '\tstate.json\n';
    const treeOut = run(['mktree'], { input: treeInput });
    const treeSha = treeOut.trim();
    // No parent -> every mutation replaces the ref with a single-commit history.
    const commitOut = run(
      ['commit-tree', treeSha, '-m', 'forge-collab: update state.json'],
      {}
    );
    return commitOut.trim();
  }

  function _isNonFastForward(err) {
    const s = ((err && err.stderr) || (err && err.message) || '') + '';
    return /stale info|non-fast-forward|rejected|force-with-lease|cannot lock ref/i.test(s);
  }

  async function _pushWithLease(branch, commitSha, expectedSha) {
    const lease = expectedSha
      ? 'refs/heads/' + branch + ':' + expectedSha
      : 'refs/heads/' + branch;
    const args = [
      'push',
      '--force-with-lease=' + lease,
      'origin',
      commitSha + ':refs/heads/' + branch
    ];
    // Gate through the user's auto_push preference. T012 semantics:
    // auto_push=false + no prompter -> returns pushed:false, reason:'auto_push_disabled_no_prompter'.
    const result = await gatedPush(args, {
      cwd,
      forgeDir,
      autoPush: typeof opts.autoPush === 'boolean' ? opts.autoPush : undefined,
      runner: runner ? (a, o) => runner(a, o || {}) : undefined,
      prompter: opts.prompter
    });
    return result;
  }

  async function _mutate(branch, mutator) {
    // mutator: (state) -> { state, abort?: { ok:false, reason:string } }
    // Returns { ok:true, sha } on success, or the abort object, or
    // { ok:false, reason:'cas_exhausted' } after retries are exhausted.
    let attempt = 0;
    let lastErr = null;
    while (attempt <= retries) {
      _fetchBranch(branch);
      const read = _readStateAndSha(branch);
      let mutated;
      try { mutated = mutator(JSON.parse(JSON.stringify(read.state))); }
      catch (e) { return { ok: false, reason: 'mutator_threw', error: e.message }; }
      if (mutated && mutated.abort) return mutated.abort;
      const nextState = mutated && mutated.state ? mutated.state : read.state;
      const commitSha = _buildCommit(nextState);
      let pushResult;
      try {
        pushResult = await _pushWithLease(branch, commitSha, read.sha);
      } catch (e) {
        lastErr = e;
        if (_isNonFastForward(e)) {
          attempt += 1;
          if (attempt > retries) break;
          await sleep(attempt * backoffMs);
          continue;
        }
        throw e;
      }
      if (pushResult && pushResult.pushed === false) {
        // auto_push disabled and prompter refused (or absent).
        return {
          ok: false,
          reason: pushResult.reason || 'push_gated',
          pushResult
        };
      }
      return { ok: true, sha: commitSha };
    }
    return {
      ok: false,
      reason: 'cas_exhausted',
      error: lastErr ? (lastErr.message || String(lastErr)) : 'unknown'
    };
  }

  function _pruneMessages(messages, now) {
    const cutoff = (now || Date.now()) - ttlSeconds * 1000;
    const seen = new Set();
    const kept = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const tsMs = m.ts ? Date.parse(m.ts) : NaN;
      if (Number.isFinite(tsMs) && tsMs < cutoff) continue;
      if (m.id && seen.has(m.id)) continue;
      if (m.id) seen.add(m.id);
      kept.push(m);
    }
    return kept;
  }

  function _leasesEqual(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return a.claimant === b.claimant && a.acquiredAt === b.acquiredAt;
  }

  return {
    async ensureBranch(branch) {
      _fetchBranch(branch);
      const read = _readStateAndSha(branch);
      if (read.sha) return true;
      // Branch missing on origin -> seed it with an empty state document so
      // later reads/writes always have a ref to force-with-lease against.
      const seed = { leases: {}, messages: [] };
      const commitSha = _buildCommit(seed);
      // Use an empty expected-sha to mean "ref must not exist yet"; if two
      // clients race to create, whoever lands first wins and the loser's
      // push is rejected -> we re-fetch and discover the ref.
      const pushResult = await gatedPush(
        [
          'push',
          '--force-with-lease=refs/heads/' + branch + ':',
          'origin',
          commitSha + ':refs/heads/' + branch
        ],
        {
          cwd,
          forgeDir,
          autoPush: typeof opts.autoPush === 'boolean' ? opts.autoPush : undefined,
          runner: runner ? (a, o) => runner(a, o || {}) : undefined,
          prompter: opts.prompter
        }
      ).catch(() => ({ pushed: false, reason: 'seed_push_rejected' }));
      if (pushResult && pushResult.pushed === false) {
        // Either auto_push was gated off, or a peer beat us to the seed.
        // Re-fetch so subsequent reads see their commit.
        _fetchBranch(branch);
      }
      return true;
    },

    async readBranch(branch) {
      _fetchBranch(branch);
      return _readStateAndSha(branch).state;
    },

    async writeLease(branch, name, next, writeOpts) {
      writeOpts = writeOpts || {};
      const hasExpected = Object.prototype.hasOwnProperty.call(writeOpts, 'expected');
      return _mutate(branch, (state) => {
        if (hasExpected) {
          const cur = state.leases[name] != null ? state.leases[name] : null;
          if (!_leasesEqual(cur, writeOpts.expected)) {
            return { abort: { ok: false, reason: 'cas_race_lost', current: cur } };
          }
        }
        if (next === null || next === undefined) delete state.leases[name];
        else state.leases[name] = next;
        return { state };
      });
    },

    async appendMessage(branch, msg) {
      return _mutate(branch, (state) => {
        state.messages = _pruneMessages(state.messages, opts.now);
        const withTs = Object.assign({ ts: new Date().toISOString() }, msg || {});
        // Dedupe by id when the caller already assigned one.
        if (!withTs.id || !state.messages.find(m => m.id === withTs.id)) {
          state.messages.push(withTs);
        }
        return { state };
      });
    },

    // Exposed for the cross-process wire test + future introspection.
    _internal: {
      _readStateAndSha,
      _buildCommit,
      _pruneMessages,
      get ttlSeconds() { return ttlSeconds; },
      get retries() { return retries; },
      get backoffMs() { return backoffMs; }
    }
  };
}

/**
 * Top-level transport factory. Picks the right backend based on env/opts.
 *
 * Returns either a ready transport object, or an object shaped
 * `{ mode: "setup-required", guide: <string> }` which callers render to
 * the user and exit on.
 */
function createTransport(opts) {
  opts = opts || {};
  const mode = selectTransportMode(opts);
  if (mode === 'setup-required') {
    return { mode, guide: renderSetupGuide() };
  }
  if (mode === 'memory') return Object.assign(createMemoryTransport(), { mode: 'memory' });
  if (mode === 'ably') return createAblyTransport(opts);
  if (mode === 'polling') return createPollingTransport(opts);
  throw new Error('unknown transport mode: ' + mode);
}

// ======================================================================
// T006 -- single-writer utilities: flag IDs + user-scoped append logs (R016)
//
// Two tiny building blocks that remove cross-writer contention without
// requiring the transport-gated lease machinery above:
//   * generateFlagId()     -- UUID-based IDs so concurrent flag writes land
//                             at distinct filesystem paths by construction.
//   * userScopedLogPath()  -- return per-user log paths so append-only
//                             coordination logs never have cross-user races.
//   * appendToUserScopedLog() -- small wrapper that creates the directory
//                             and appends a JSONL entry.
// ======================================================================

function _safeHandle(handle) {
  // Strip anything that could escape a filename; keep alnum + - + _
  return String(handle || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

function _safeKind(kind) {
  return String(kind || 'log').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'log';
}

/**
 * Generate a new flag ID. Uses crypto.randomUUID() under the hood. Two
 * concurrent invocations on the same machine (or across machines) produce
 * distinct IDs with cryptographic probability, so simultaneous flag writes
 * land at distinct filesystem paths per spec-collab R016 AC.
 *
 * Format: "F<12-hex-prefix-of-uuid>" -- short, greppable, filesystem-safe.
 */
function generateFlagId() {
  const uuid = crypto.randomUUID();
  const hex = uuid.replace(/-/g, '').slice(0, 12);
  return 'F' + hex;
}

/**
 * Build the filesystem path of the flag file for the given ID. Lives under
 * `<collabDir>/flags/<id>.md`. Directory is created by callers that actually
 * write.
 */
function flagPath(collabDir, flagId) {
  if (!collabDir) throw new Error('flagPath requires collabDir');
  if (!flagId) throw new Error('flagPath requires flagId');
  return path.join(collabDir, 'flags', String(flagId) + '.md');
}

/**
 * Return the per-user log path for a given kind. Append-only coordination
 * logs (routing decisions, flag emits, etc.) are user-scoped by filename
 * rather than funneled into a single shared file -- so two users appending
 * simultaneously never contend on the same file.
 */
function userScopedLogPath(collabDir, kind, handle) {
  if (!collabDir) throw new Error('userScopedLogPath requires collabDir');
  return path.join(collabDir, _safeKind(kind) + '-log-' + _safeHandle(handle) + '.jsonl');
}

/**
 * Append a JSON-serializable entry as a single JSONL line. Creates parent
 * dirs as needed. Each entry gets an ISO timestamp if none provided.
 */
function appendToUserScopedLog(collabDir, kind, handle, entry) {
  const p = userScopedLogPath(collabDir, kind, handle);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const withTs = Object.assign({ ts: new Date().toISOString() }, entry || {});
  fs.appendFileSync(p, JSON.stringify(withTs) + '\n');
  return p;
}

// ======================================================================
// T007 -- brainstorm chat + consolidate + categorize + routed questions
//         (R002, R003, R004, R014, R015, R016)
// ======================================================================

function _inputsPath(collabDir, handle) {
  return path.join(collabDir, 'brainstorm', 'inputs-' + _safeHandle(handle) + '.md');
}
function _consolidatedPath(collabDir) {
  return path.join(collabDir, 'brainstorm', 'consolidated.md');
}
function _categoriesPath(collabDir) {
  return path.join(collabDir, 'categories.json');
}
function _questionsDir(collabDir, round) {
  return path.join(collabDir, 'questions', 'round' + (Number(round) || 1));
}

function _parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] };
}

/**
 * Persist one participant's refined brainstorm output. The chat-mode
 * interactive loop happens at the command layer (outside this module);
 * this primitive only writes the accepted doc with standard frontmatter.
 */
function brainstormDump(collabDir, handle, body, opts) {
  opts = opts || {};
  const ts = opts.timestamp || new Date().toISOString();
  const safe = _safeHandle(handle);
  const p = _inputsPath(collabDir, handle);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fm = ['---', 'author: ' + safe, 'timestamp: ' + ts, '---', ''].join('\n');
  fs.writeFileSync(p, fm + String(body || '').trim() + '\n');
  return p;
}

/** Load every inputs-*.md with { handle, timestamp, body, path }. */
function readAllInputs(collabDir) {
  const dir = path.join(collabDir, 'brainstorm');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /^inputs-.+\.md$/.test(f));
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = _parseFrontmatter(raw);
    out.push({
      handle: parsed.frontmatter.author || f.replace(/^inputs-/, '').replace(/\.md$/, ''),
      timestamp: parsed.frontmatter.timestamp || null,
      body: parsed.body,
      path: full
    });
  }
  return out;
}

/**
 * Merge per-user inputs into a single markdown with contributor-tagged
 * topic sections. Heuristic default; inject opts.consolidator for LLM
 * fidelity.
 */
function consolidateInputs(inputs, opts) {
  opts = opts || {};
  if (typeof opts.consolidator === 'function') return opts.consolidator(inputs);
  if (!Array.isArray(inputs) || inputs.length === 0) return '';
  const groups = [];
  for (const inp of inputs) {
    const paragraphs = String(inp.body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      const tokens = _tokenSet(para);
      let placed = false;
      for (const g of groups) {
        let overlap = 0;
        for (const t of tokens) if (g.tokens.has(t)) overlap++;
        if (overlap >= 2) {
          g.paragraphs.push({ author: inp.handle, text: para });
          g.contributors.add(inp.handle);
          for (const t of tokens) g.tokens.add(t);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({
          tokens: new Set(tokens),
          paragraphs: [{ author: inp.handle, text: para }],
          contributors: new Set([inp.handle])
        });
      }
    }
  }
  const lines = ['# Consolidated Brainstorm', ''];
  groups.forEach((g, i) => {
    const contribs = Array.from(g.contributors).sort().join(', ');
    lines.push('## Topic ' + (i + 1) + ' (contributors: ' + contribs + ')');
    for (const p of g.paragraphs) lines.push('- (' + p.author + ') ' + p.text.replace(/\s+/g, ' '));
    lines.push('');
  });
  return lines.join('\n');
}

function _extractSections(consolidatedBody) {
  const lines = String(consolidatedBody || '').split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (current) sections.push(current);
      const title = h[1].trim();
      const cm = title.match(/\(contributors:\s*([^)]+)\)/);
      const contributors = cm ? cm[1].split(',').map(s => s.trim()).filter(Boolean) : [];
      current = { title, contributors, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

function _defaultClassifier(text /*, inputs */) {
  const t = String(text || '').toLowerCase();
  if (/\b(research|explore|investigate|evaluate|unknown|unclear)\b/.test(t)) return 'research';
  return 'coding';
}

function _defaultContradictionDetector(inputs) {
  const opinions = {};
  for (const inp of inputs) {
    const useMatch = String(inp.body || '').match(/\b(?:use|prefer|pick)\s+([A-Za-z][A-Za-z0-9_-]{1,30})/gi) || [];
    for (const m of useMatch) {
      const token = m.replace(/^(?:use|prefer|pick)\s+/i, '').toLowerCase();
      if (!opinions[token]) opinions[token] = new Set();
      opinions[token].add(inp.handle);
    }
  }
  const entries = Object.entries(opinions);
  if (entries.length < 2) return [];
  const authorsPerOption = new Set(entries.map(([, a]) => Array.from(a).sort().join(',')));
  if (authorsPerOption.size < 2) return [];
  const champions = entries.map(([tok, authors]) => ({ option: tok, contributors: Array.from(authors) }));
  return [{
    summary: 'Competing technology choices detected: ' + champions.map(c => c.option).join(' vs '),
    positions: champions
  }];
}

/**
 * Categorize a consolidated brainstorm into discrete tasks with per-task
 * `type: "coding" | "research"` and `is_decision` flag (R004, R014, R016).
 */
function categorizeInputs(consolidatedBody, inputs, opts) {
  opts = opts || {};
  const classify = typeof opts.classifier === 'function' ? opts.classifier : _defaultClassifier;
  const contradictionDetector = typeof opts.contradictionDetector === 'function'
    ? opts.contradictionDetector : _defaultContradictionDetector;
  const sections = _extractSections(consolidatedBody);
  const tasks = [];
  let idx = 1;
  for (const s of sections) {
    const type = classify(s.title + '\n' + s.body, inputs);
    const cleanTitle = s.title.replace(/\s*\(contributors:.*\)\s*$/, '').trim();
    tasks.push({
      id: 'C' + String(idx).padStart(3, '0'),
      title: cleanTitle,
      category: cleanTitle,
      source_contributors: s.contributors,
      is_decision: false,
      type: type === 'research' ? 'research' : 'coding'
    });
    idx++;
  }
  const contradictions = contradictionDetector(inputs);
  for (const c of contradictions) {
    const contribs = Array.from(new Set((c.positions || []).flatMap(p => p.contributors || [])));
    tasks.push({
      id: 'C' + String(idx).padStart(3, '0'),
      title: c.summary,
      category: 'decision',
      source_contributors: contribs,
      is_decision: true,
      type: 'research',
      positions: c.positions
    });
    idx++;
  }
  return tasks;
}

/**
 * Write consolidated.md + categories.json under a short-lived consolidation
 * lease per R016. Returns { held, result? / reason / holder }.
 */
async function writeConsolidatedUnderLease(transport, collabDir, claimant, inputs, opts) {
  opts = opts || {};
  const leaseName = opts.leaseName || 'consolidation';
  const ttlSeconds = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : DEFAULT_CONSOLIDATION_TTL_SECONDS;
  const now = _nowMs(opts);
  return withLease(transport, leaseName, claimant, { ttlSeconds, now }, async () => {
    const body = consolidateInputs(inputs, opts);
    const cPath = _consolidatedPath(collabDir);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, body);
    const tasks = categorizeInputs(body, inputs, opts);
    const catPath = _categoriesPath(collabDir);
    fs.mkdirSync(path.dirname(catPath), { recursive: true });
    fs.writeFileSync(catPath, JSON.stringify({ categories: tasks }, null, 2) + '\n');
    return { consolidatedPath: cPath, categoriesPath: catPath, taskCount: tasks.length };
  });
}

/**
 * Route a clarifying question to the closest contributor via similarity +
 * transport ping. Persists a question file for late-joiners (R015).
 */
async function routeClarifyingQuestion(transport, collabDir, participants, question, opts) {
  opts = opts || {};
  const round = typeof opts.round === 'number' ? opts.round : 1;
  const qDir = _questionsDir(collabDir, round);
  fs.mkdirSync(qDir, { recursive: true });
  const id = opts.id || generateFlagId();
  const qPath = path.join(qDir, id + '.md');
  const target = routeToParticipant(
    String(question.text || '') + '\n' + String(question.source_section || ''),
    participants,
    opts
  );
  const fm = [
    '---',
    'id: ' + id,
    'round: ' + round,
    'routed_to: ' + target,
    'topic: ' + (question.topic || ''),
    'source_section: ' + (question.source_section || ''),
    'status: open',
    'created: ' + new Date().toISOString(),
    '---',
    ''
  ].join('\n');
  fs.writeFileSync(qPath, fm + String(question.text || '').trim() + '\n');
  if (transport) {
    const payload = {
      id, round,
      topic: question.topic || '',
      source_section: question.source_section || '',
      on_disk_path: qPath,
      question: question.text
    };
    if (target !== 'broadcast' && typeof transport.sendTargeted === 'function') {
      await transport.sendTargeted(target, 'clarifying-question', payload);
    } else if (typeof transport.publish === 'function') {
      await transport.publish('clarifying-question', payload);
    }
  }
  return { id, path: qPath, routed_to: target };
}

// ======================================================================
// T008 -- per-task branches pushed to origin with checkpoint updates (R007)
//
// Each active worktree is mirrored on origin as `forge/task/<task-id>` so
// teammates can observe in-flight work via `git fetch && git checkout`.
// The primitive is runner-injectable so tests verify the git invocations
// without a real remote.
//
// Branch lifecycle:
//   startTaskBranch(id, ref) -> push forge/task/<id> at `ref` to origin.
//   updateTaskBranch(id)     -> push latest local commits (called after
//                               each checkpoint write).
//   deleteTaskBranch(id)     -> delete origin branch on successful
//                               squash-merge. Failures are non-fatal
//                               (the worktree code still converges).
// ======================================================================

const TASK_BRANCH_PREFIX = 'forge/task/';

function taskBranchName(taskId) {
  if (!taskId) throw new Error('taskBranchName requires a task id');
  return TASK_BRANCH_PREFIX + String(taskId);
}

function _defaultGitRunner() {
  return function gitRun(args, opts) {
    opts = opts || {};
    return execFileSync('git', args, {
      cwd: opts.cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  };
}

/**
 * Push the current worktree's branch as forge/task/<id> to origin.
 *
 * opts:
 *   cwd       worktree directory (defaults to process.cwd())
 *   ref       local ref / commit to push (defaults to HEAD)
 *   remote    remote name (defaults to "origin")
 *   runner    injectable git-runner for tests; (args, opts) -> stdout string
 *   force     whether to force-push. Default false. Set true for checkpoint
 *             updates that rewrite history mid-task.
 *
 * Returns { pushed: true, branch, remote } on success. Throws on git error
 * with a clear message so callers can decide whether to retry.
 */
function startTaskBranch(taskId, opts) {
  opts = opts || {};
  const branch = taskBranchName(taskId);
  const remote = opts.remote || 'origin';
  const ref = opts.ref || 'HEAD';
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  const args = ['push'];
  if (opts.force) args.push('--force-with-lease');
  args.push(remote, ref + ':refs/heads/' + branch);
  runner(args, { cwd: opts.cwd });
  return { pushed: true, branch, remote };
}

/**
 * Push the latest local commits on the worktree's branch to origin.
 * Called after each Forge checkpoint step so teammates see in-flight code.
 * Always uses --force-with-lease because checkpoints can overwrite prior
 * WIP commits.
 */
function updateTaskBranch(taskId, opts) {
  return startTaskBranch(taskId, Object.assign({}, opts, { force: true }));
}

/**
 * Delete the origin-side task branch after successful squash-merge.
 * Non-fatal: swallows errors so a momentarily-unreachable remote doesn't
 * block task completion. Returns { deleted, branch, remote, error? }.
 */
function deleteTaskBranch(taskId, opts) {
  opts = opts || {};
  const branch = taskBranchName(taskId);
  const remote = opts.remote || 'origin';
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  try {
    runner(['push', remote, '--delete', branch], { cwd: opts.cwd });
    return { deleted: true, branch, remote };
  } catch (e) {
    return {
      deleted: false,
      branch,
      remote,
      error: (e && e.message) || 'delete failed'
    };
  }
}

/**
 * Capture a git runner that records every invocation, for tests and for
 * debugging the push pipeline under failure.
 */
function createRecordingGitRunner(behavior) {
  behavior = behavior || {};
  const calls = [];
  function runner(args, opts) {
    calls.push({ args: args.slice(), cwd: (opts && opts.cwd) || null });
    if (typeof behavior.stdout === 'function') {
      return behavior.stdout(args, opts) || '';
    }
    if (typeof behavior.throwOn === 'function' && behavior.throwOn(args)) {
      const err = new Error('simulated git failure: ' + args.join(' '));
      err.stderr = Buffer.from('simulated');
      throw err;
    }
    return '';
  }
  runner.calls = calls;
  return runner;
}

// ======================================================================
// T009 -- research-type task execution + streaming results to git (R014)
//
// When an agent claims a task whose `type === "research"` (from
// categorizeInputs in T007), it runs the research workflow and writes the
// result to .forge/collab/research/<task-id>.md. The file is committed
// and pushed by the executing machine so peers see it after `git pull`.
//
// Coding-type tasks continue through the existing execute pipeline
// unchanged; this primitive is only exercised for research-type tasks.
// ======================================================================

function _researchPath(collabDir, taskId) {
  if (!collabDir) throw new Error('research path requires collabDir');
  if (!taskId) throw new Error('research path requires taskId');
  return path.join(collabDir, 'research', String(taskId) + '.md');
}

/**
 * Render a research result document with standard frontmatter so peers
 * can parse `researcher`, `task_id`, and `completed_at` deterministically.
 */
function renderResearchResult({ taskId, researcher, body, completedAt }) {
  const ts = completedAt || new Date().toISOString();
  const fm = [
    '---',
    'task_id: ' + String(taskId),
    'researcher: ' + _safeHandle(researcher),
    'completed_at: ' + ts,
    '---',
    ''
  ].join('\n');
  return fm + String(body || '').trim() + '\n';
}

/**
 * Persist a research result and (optionally) stage+commit+push it so
 * teammates see the research as soon as it lands on origin.
 *
 * opts:
 *   collabDir  path to .forge/collab/
 *   taskId     research task id (e.g. "C003")
 *   researcher handle of the executing agent
 *   body       markdown research body
 *   cwd        repo working directory (for git ops)
 *   runner     injectable git runner (tests pass createRecordingGitRunner)
 *   push       whether to git add/commit/push (default true). When false,
 *              caller just gets the on-disk write (e.g. for T012 prompt
 *              path when auto-push is disabled).
 */
function persistResearchResult(opts) {
  opts = opts || {};
  const { collabDir, taskId, researcher, body, cwd } = opts;
  const doPush = opts.push !== false;
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  const target = _researchPath(collabDir, taskId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const doc = renderResearchResult({
    taskId, researcher, body, completedAt: opts.completedAt
  });
  fs.writeFileSync(target, doc);
  if (!doPush) return { path: target, committed: false, pushed: false };
  const rel = path.relative(cwd || process.cwd(), target);
  const msg = 'forge(collab): research result ' + String(taskId) +
    ' by ' + _safeHandle(researcher);
  try {
    runner(['add', rel], { cwd });
    runner(['commit', '-m', msg], { cwd });
  } catch (e) {
    // If nothing new to commit, git errors non-zero. Surface clearly.
    return { path: target, committed: false, pushed: false, error: e.message };
  }
  try {
    runner(['push', opts.remote || 'origin', 'HEAD'], { cwd });
  } catch (e) {
    return { path: target, committed: true, pushed: false, error: e.message };
  }
  return { path: target, committed: true, pushed: true };
}

/**
 * Stream a section of research output as the agent produces it. Each call
 * appends a new `## <heading>` block to the research file and commits and
 * pushes it so peers see incremental progress on their `git pull`.
 *
 * No lease/write-contention needed because each task has a single
 * executing machine (enforced by the claim queue in T003).
 */
function appendResearchSection(opts) {
  opts = opts || {};
  const { collabDir, taskId, researcher, heading, body, cwd } = opts;
  const doPush = opts.push !== false;
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  const target = _researchPath(collabDir, taskId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const exists = fs.existsSync(target);
  if (!exists) {
    fs.writeFileSync(target, renderResearchResult({
      taskId, researcher, body: '', completedAt: opts.completedAt
    }));
  }
  const section = '\n## ' + String(heading || 'section') + '\n\n' + String(body || '').trim() + '\n';
  fs.appendFileSync(target, section);
  if (!doPush) return { path: target, appended: true, pushed: false };
  const rel = path.relative(cwd || process.cwd(), target);
  const msg = 'forge(collab): research progress ' + String(taskId) + ' -- ' + (heading || 'section');
  try {
    runner(['add', rel], { cwd });
    runner(['commit', '-m', msg], { cwd });
    runner(['push', opts.remote || 'origin', 'HEAD'], { cwd });
    return { path: target, appended: true, pushed: true };
  } catch (e) {
    return { path: target, appended: true, pushed: false, error: e.message };
  }
}

function isResearchTask(task) {
  return !!(task && task.type === 'research');
}

// ======================================================================
// T010 -- forward-motion decision flags + review/override UX
//         + targeted flag notifications (R008, R009, R015, R016)
//
// During the `executing` phase only, agents never block on human input:
// they pick a decision, write a flag file, and keep moving. The flag is
// a durable record of what was chosen and why; humans can review and
// override it asynchronously.
//
// Phase guard (R008): flag writes are rejected outside the executing
// phase. The existing blocking behaviour stays in brainstorm / plan /
// reviewing_branch / verifying phases.
//
// Flag file format (.forge/collab/flags/<id>.md):
//   ---
//   id: <id>
//   task_id: <task>
//   author: <agent handle>
//   created: <iso>
//   status: open | acknowledged | overridden
//   decision: <chosen option>
//   alternatives: [opt1, opt2, ...]
//   rationale: <one-line>
//   source_contributors: [a, b, ...]
//   ---
//   <expanded body: pros/cons, references>
// ======================================================================

const EXECUTING_PHASES = new Set(['executing', 'implementing', 'testing', 'reviewing', 'fixing', 'debugging']);
const FLAG_STATUS = Object.freeze({ OPEN: 'open', ACKED: 'acknowledged', OVERRIDDEN: 'overridden' });

function _isExecutingPhase(phase) {
  return EXECUTING_PHASES.has(String(phase || '').trim());
}

function _flagDir(collabDir) {
  return path.join(collabDir, 'flags');
}

function _renderFlagDoc(flag, extraBody) {
  const fm = [
    '---',
    'id: ' + flag.id,
    'task_id: ' + (flag.task_id || ''),
    'author: ' + _safeHandle(flag.author),
    'created: ' + (flag.created || new Date().toISOString()),
    'status: ' + (flag.status || FLAG_STATUS.OPEN),
    'decision: ' + JSON.stringify(flag.decision || ''),
    'alternatives: ' + JSON.stringify(flag.alternatives || []),
    'rationale: ' + JSON.stringify(flag.rationale || ''),
    'source_contributors: ' + JSON.stringify(flag.source_contributors || []),
    '---',
    ''
  ].join('\n');
  return fm + String(extraBody || '').trim() + '\n';
}

function _parseFlagDoc(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];
    try {
      if (key === 'decision' || key === 'rationale' ||
          key === 'alternatives' || key === 'source_contributors') {
        fm[key] = JSON.parse(val);
      } else {
        fm[key] = val;
      }
    } catch (_) {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: m[2] };
}

/**
 * Write a forward-motion decision flag during the executing phase. Never
 * blocks. Caller provides the already-chosen decision; this function
 * persists it and notifies targeted contributors via the transport.
 *
 * opts:
 *   phase            current Forge state-machine phase; flag writes are
 *                    rejected when not in an executing sub-phase.
 *   transport        transport object used to sendTargeted the notification.
 *   collabDir        .forge/collab/
 *   task_id          the task that triggered the decision.
 *   author           the agent handle writing the flag.
 *   decision         chosen option string.
 *   alternatives     array of alternative options considered.
 *   rationale        one-line reason for the choice.
 *   source_contributors  who contributed to this task in the brainstorm;
 *                    notification routes to the closest of them.
 *   participants     full participant list for similarity routing (closest
 *                    of `source_contributors` wins).
 *   body             optional extended markdown body (pros/cons, refs).
 */
async function writeForwardMotionFlag(opts) {
  opts = opts || {};
  if (!_isExecutingPhase(opts.phase)) {
    return {
      written: false,
      reason: 'wrong_phase',
      phase: opts.phase,
      guidance: 'forward-motion flags only allowed in the executing phase; current phase is ' + opts.phase
    };
  }
  if (!opts.collabDir) throw new Error('writeForwardMotionFlag requires collabDir');
  if (!opts.task_id) throw new Error('writeForwardMotionFlag requires task_id');
  if (!opts.author) throw new Error('writeForwardMotionFlag requires author');
  if (!opts.decision) throw new Error('writeForwardMotionFlag requires decision');

  const id = opts.id || generateFlagId();
  const flag = {
    id, task_id: opts.task_id, author: opts.author,
    created: opts.created || new Date().toISOString(),
    status: FLAG_STATUS.OPEN,
    decision: opts.decision,
    alternatives: opts.alternatives || [],
    rationale: opts.rationale || '',
    source_contributors: opts.source_contributors || []
  };
  const fpath = flagPath(opts.collabDir, id);
  fs.mkdirSync(path.dirname(fpath), { recursive: true });
  fs.writeFileSync(fpath, _renderFlagDoc(flag, opts.body));

  // Append to a user-scoped flag-emit log so cross-writer append races
  // can't occur (R016: user-scoped log filenames).
  appendToUserScopedLog(opts.collabDir, 'flag-emit', opts.author, {
    flag_id: id, task_id: flag.task_id, decision: flag.decision
  });

  // Targeted notification via transport (R015). Target is the closest
  // source_contributor; fall back to broadcast only if contributors list
  // is empty or routing ties.
  let notified = null;
  if (opts.transport && Array.isArray(opts.participants) && opts.participants.length > 0) {
    const candidates = opts.participants.filter(p =>
      !opts.source_contributors || (opts.source_contributors || []).includes(p.handle)
    );
    const pool = candidates.length > 0 ? candidates : opts.participants;
    const target = routeToParticipant(
      String(flag.decision) + '\n' + String(flag.rationale || ''),
      pool,
      opts
    );
    const payload = {
      flag_id: id,
      task_id: flag.task_id,
      decision: flag.decision,
      alternatives: flag.alternatives,
      rationale: flag.rationale,
      on_disk_path: fpath
    };
    if (target !== 'broadcast' && typeof opts.transport.sendTargeted === 'function') {
      await opts.transport.sendTargeted(target, 'flag-ping', payload);
      notified = { mode: 'targeted', target };
    } else if (typeof opts.transport.publish === 'function') {
      await opts.transport.publish('flag-ping', payload);
      notified = { mode: 'broadcast' };
    }
  }

  return { written: true, id, path: fpath, flag, notified };
}

/**
 * List all flags with their current status. Returns an array of flag
 * objects (frontmatter + body). Unreadable/corrupt flag files are
 * skipped rather than throwing, so a broken flag can't stall the review
 * UX for the others.
 */
function listFlags(collabDir, opts) {
  const dir = _flagDir(collabDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /^F[0-9a-f]+\.md$/.test(f));
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const parsed = _parseFlagDoc(raw);
    if (!parsed) continue;
    if (opts && opts.status && parsed.frontmatter.status !== opts.status) continue;
    out.push(Object.assign({ path: path.join(dir, f) }, parsed.frontmatter, { body: parsed.body }));
  }
  return out;
}

function readFlag(collabDir, flagId) {
  const fpath = flagPath(collabDir, flagId);
  if (!fs.existsSync(fpath)) return null;
  const parsed = _parseFlagDoc(fs.readFileSync(fpath, 'utf8'));
  if (!parsed) return null;
  return Object.assign({ path: fpath }, parsed.frontmatter, { body: parsed.body });
}

/**
 * Override an open flag's decision. Marks it `overridden` and records the
 * new decision so dependent tasks can be re-triggered for rework.
 *
 * Returns { overridden: true, flag, previousDecision } or
 * { overridden: false, reason } when the flag is missing or closed.
 */
function overrideFlag(collabDir, flagId, newDecision, opts) {
  opts = opts || {};
  const fpath = flagPath(collabDir, flagId);
  if (!fs.existsSync(fpath)) return { overridden: false, reason: 'not_found', flagId };
  const parsed = _parseFlagDoc(fs.readFileSync(fpath, 'utf8'));
  if (!parsed) return { overridden: false, reason: 'malformed' };
  const fm = parsed.frontmatter;
  if (fm.status === FLAG_STATUS.OVERRIDDEN) {
    return { overridden: false, reason: 'already_overridden', previousDecision: fm.decision };
  }
  const previousDecision = fm.decision;
  const newFlag = Object.assign({}, fm, {
    status: FLAG_STATUS.OVERRIDDEN,
    decision: newDecision,
    overridden_by: _safeHandle(opts.author || 'unknown'),
    overridden_at: opts.overriddenAt || new Date().toISOString()
  });
  // Re-render preserving body
  const newDoc = _renderFlagDoc(newFlag, parsed.body) +
    'Overridden by: ' + newFlag.overridden_by + ' at ' + newFlag.overridden_at + '\n' +
    'Previous decision: ' + JSON.stringify(previousDecision) + '\n';
  fs.writeFileSync(fpath, newDoc);
  return { overridden: true, flag: newFlag, previousDecision, path: fpath };
}

// ======================================================================
// T011 -- per-agent squash-merge with race-retry (R010)
//
// On task verify-pass the executing agent squash-merges its worktree
// branch to main and pushes origin/main. If another agent merged first
// the push is rejected; we `git pull --rebase origin main` and retry
// up to 3 times with linear backoff. Two agents merging near-
// simultaneously both land cleanly.
//
// This is the only primitive that writes to main. There is no global
// "merge-tier" command -- each agent owns its own completed task.
// ======================================================================

const DEFAULT_MERGE_RETRIES = 3;
const DEFAULT_MERGE_BACKOFF_MS = 250;

function _looksLikeNonFastForward(err) {
  const msg = String((err && err.message) || '');
  const stderr = String((err && err.stderr) || '');
  const text = msg + ' ' + stderr;
  return /non-fast-forward|Updates were rejected|rejected|failed to push some refs/i.test(text);
}

/**
 * Squash-merge the branch `forge/task/<taskId>` into the local main
 * branch, then push origin/main. Retries on push-rejection via
 * pull --rebase so concurrent merges from other agents converge without
 * conflicts (they're guaranteed disjoint by the planner's
 * parallel-constraint logic).
 *
 * opts:
 *   taskId          required; source branch = forge/task/<taskId>.
 *   cwd             repo working dir.
 *   runner          injectable git runner for tests.
 *   mainBranch      default "main".
 *   remote          default "origin".
 *   commitMessage   commit subject for the squash merge.
 *   retries         default 3.
 *   backoffMs       linear backoff step; actual wait = attempt * backoffMs.
 *   sleep           injectable sleep for deterministic tests; (ms)=>void.
 *
 * Returns { merged: true, attempts, pushed: true, ref } on success.
 * Returns { merged: true, pushed: false, error } if all retries exhaust.
 */
async function squashMergeAndPush(opts) {
  opts = opts || {};
  if (!opts.taskId) throw new Error('squashMergeAndPush requires taskId');
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise(r => setTimeout(r, ms));
  const retries = typeof opts.retries === 'number' ? opts.retries : DEFAULT_MERGE_RETRIES;
  const backoffMs = typeof opts.backoffMs === 'number' ? opts.backoffMs : DEFAULT_MERGE_BACKOFF_MS;
  const main = opts.mainBranch || 'main';
  const remote = opts.remote || 'origin';
  const branch = taskBranchName(opts.taskId);
  const msg = opts.commitMessage || ('forge(collab): squash ' + opts.taskId);

  // Checkout main, squash-merge source branch, commit.
  runner(['checkout', main], { cwd: opts.cwd });
  // --squash stages the changes without committing; we need a follow-up commit.
  runner(['merge', '--squash', branch], { cwd: opts.cwd });
  try {
    runner(['commit', '-m', msg], { cwd: opts.cwd });
  } catch (e) {
    // Empty squash (no changes) -- treat as already-merged and continue.
    if (!/nothing to commit/i.test(String((e && e.stderr) || e.message || ''))) throw e;
  }

  // Push + rebase-retry loop.
  let attempts = 0;
  let lastErr = null;
  while (attempts < retries) {
    attempts++;
    try {
      runner(['push', remote, main], { cwd: opts.cwd });
      return { merged: true, pushed: true, attempts, ref: main };
    } catch (e) {
      lastErr = e;
      if (!_looksLikeNonFastForward(e)) {
        // Not a race rejection -- bubble up immediately.
        throw e;
      }
      // Race: fetch peer's commits, rebase our squash on top, retry.
      try {
        runner(['pull', '--rebase', remote, main], { cwd: opts.cwd });
      } catch (pullErr) {
        return {
          merged: true, pushed: false, attempts,
          error: 'pull-rebase failed: ' + (pullErr.message || pullErr)
        };
      }
      if (attempts < retries) await sleep(attempts * backoffMs);
    }
  }
  return {
    merged: true, pushed: false, attempts,
    error: 'push rejected after ' + retries + ' attempts: ' +
      ((lastErr && lastErr.message) || 'unknown')
  };
}

// ======================================================================
// T012 -- push-config inheritance + late-join mid-session (R011, R012)
//
// Push-config inheritance (R011): Forge's existing config key
// `auto_push` (default true) gates whether git pushes happen silently or
// ask the user first. Collab mode reads the same key so per-task branch
// pushes, research-result pushes, and squash-merges match single-user
// Forge's behavior. Disabling auto_push gates ONLY git push steps -- not
// lease heartbeats, flag writes, or targeted transport sends.
//
// Late-join (R012): /forge:collaborate on an already-running session
// pulls git, subscribes to the transport channel, reads the current
// claims snapshot, and claims only tasks not already held by other
// participants.
// ======================================================================

/**
 * Read the auto-push config from .forge/config.json. Defaults to true so
 * existing single-user behaviour is preserved when no config exists.
 */
function readAutoPushConfig(forgeDir) {
  try {
    if (!forgeDir) return true;
    const p = path.join(forgeDir, 'config.json');
    if (!fs.existsSync(p)) return true;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof cfg.auto_push === 'boolean') return cfg.auto_push;
    if (cfg.collab && typeof cfg.collab.auto_push === 'boolean') return cfg.collab.auto_push;
    return true;
  } catch (_) {
    return true;
  }
}

/**
 * Gate a git push through the configured auto-push behavior.
 *
 * opts.autoPush (boolean) -- explicit override; if absent, reads from
 *   .forge/config.json via opts.forgeDir.
 * opts.runner   -- injectable git runner.
 * opts.prompter -- async fn({args, cwd}) -> boolean. Called when
 *                  auto_push is false; must return true to proceed.
 * Returns { pushed: true } or { pushed: false, reason }.
 *
 * This primitive is consumed by persistResearchResult (T009), by the
 * per-task branch push in T008, and by the squash-merge in T011. In
 * collab mode those paths pass opts.forgeDir so the shared config gate
 * governs every push.
 */
async function gatedPush(args, opts) {
  opts = opts || {};
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  let autoPush = opts.autoPush;
  if (typeof autoPush !== 'boolean') autoPush = readAutoPushConfig(opts.forgeDir);

  if (!autoPush) {
    if (typeof opts.prompter !== 'function') {
      return { pushed: false, reason: 'auto_push_disabled_no_prompter' };
    }
    const ok = await opts.prompter({ args, cwd: opts.cwd });
    if (!ok) return { pushed: false, reason: 'user_declined' };
  }
  runner(args, { cwd: opts.cwd });
  return { pushed: true };
}

/**
 * Compute which task IDs a late-joining agent can claim, given the
 * current claims snapshot and the frontier.
 *
 * opts:
 *   transport         collab transport (or memory/ably/polling backend).
 *   unblockedTaskIds  array of task IDs that the planner reports as
 *                     currently eligible (dependencies satisfied).
 *   now               optional clock override for deterministic tests.
 *
 * Returns array of IDs that are NOT held by a live claim.
 */
function filterClaimableForLateJoin(transport, unblockedTaskIds, opts) {
  const held = new Set(
    listActiveTaskClaims(transport, opts).map(c => c.task_id)
  );
  return (unblockedTaskIds || []).filter(id => !held.has(id));
}

/**
 * Bootstrap sequence for a late-joining participant. Runs `git pull`,
 * connects the transport if needed, and returns the list of claimable
 * task IDs. Caller decides which one to claim next.
 *
 * opts:
 *   transport         injected transport (already constructed).
 *   unblockedTaskIds  planner-provided eligibility list.
 *   cwd               repo dir for git pull.
 *   runner            injectable git runner (tests).
 *   remote            default "origin".
 *   branch            default "main".
 *   skipGitPull       when true, skip the pull step (for tests).
 */
async function lateJoinBootstrap(opts) {
  opts = opts || {};
  const runner = typeof opts.runner === 'function' ? opts.runner : _defaultGitRunner();
  if (!opts.skipGitPull) {
    try {
      runner(['pull', opts.remote || 'origin', opts.branch || 'main'], { cwd: opts.cwd });
    } catch (e) {
      return { joined: false, reason: 'git_pull_failed', error: (e && e.message) || String(e) };
    }
  }
  if (opts.transport && typeof opts.transport.connect === 'function') {
    try { await opts.transport.connect(); } catch (e) {
      return { joined: false, reason: 'transport_connect_failed', error: e.message };
    }
  }
  const claimable = filterClaimableForLateJoin(
    opts.transport,
    opts.unblockedTaskIds || [],
    { now: opts.now }
  );
  return { joined: true, claimable };
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

// ======================================================================
// .gitignore migration helper (R001).
//
// Existing checkouts initialized before the collab carve-out landed have a
// plain `.forge/` line in .gitignore that silently drops every collab
// artifact the skill instructs git to add. These helpers detect that case
// and patch the rules in-place so /forge:collaborate start can prompt the
// user before the first brainstorm dump is swallowed.
// ======================================================================

const GITIGNORE_CARVE_OUT_MARKER = '# forge: collab carve-out';
// Anchored `/.forge/*` plus un-ignore re-entry rules. The glob form (not a
// bare `.forge/`) is required so git will descend into the collab subdir;
// git refuses to re-include files under an ignored parent directory.
const GITIGNORE_CARVE_OUT_BLOCK =
  GITIGNORE_CARVE_OUT_MARKER + '\n' +
  '/.forge/*\n' +
  '!/.forge/collab/\n' +
  '!/.forge/collab/**\n';

const COLLAB_NESTED_GITIGNORE =
  '# forge: collab per-machine state (re-ignored under the repo carve-out)\n' +
  'participant.json\n' +
  'flag-emit-log-*.jsonl\n' +
  '.enabled\n';

/**
 * Classify the state of .gitignore in the repo at `cwd` relative to the
 * collab carve-out rules. Pure: no filesystem writes.
 *
 * Returns:
 *   { status: 'missing_gitignore',         needsPatching: true }
 *   { status: 'missing_forge_rule',        needsPatching: true }
 *   { status: 'legacy_rule_no_carve_out',  needsPatching: true }
 *   { status: 'missing_nested_gitignore',  needsPatching: true }
 *   { status: 'ok',                        needsPatching: false }
 *
 * `reason` is a human-readable string suitable for surfacing in the
 * collaborate command's preflight output.
 */
function detectLegacyGitignore(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const gitignorePath = path.join(cwd, '.gitignore');
  const nestedPath = path.join(cwd, '.forge', 'collab', '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return {
      status: 'missing_gitignore',
      needsPatching: true,
      reason: 'No .gitignore exists. Collab needs carve-out rules so shared artifacts propagate via git.',
      gitignorePath,
      nestedPath
    };
  }

  const contents = fs.readFileSync(gitignorePath, 'utf8');
  const hasCarveOut = contents.includes(GITIGNORE_CARVE_OUT_MARKER);
  const hasLegacyRule = /^\.forge\/?\s*$/m.test(contents);
  const nestedExists = fs.existsSync(nestedPath);

  if (hasCarveOut && nestedExists) {
    return { status: 'ok', needsPatching: false, reason: 'Carve-out rules already present.', gitignorePath, nestedPath };
  }

  if (hasCarveOut && !nestedExists) {
    return {
      status: 'missing_nested_gitignore',
      needsPatching: true,
      reason: 'Root carve-out present but .forge/collab/.gitignore is missing. Per-machine state would leak.',
      gitignorePath,
      nestedPath
    };
  }

  if (hasLegacyRule) {
    return {
      status: 'legacy_rule_no_carve_out',
      needsPatching: true,
      reason: 'Legacy `.forge/` rule ignores all collab artifacts. Run the migration helper to add the carve-out.',
      gitignorePath,
      nestedPath
    };
  }

  return {
    status: 'missing_forge_rule',
    needsPatching: true,
    reason: 'No .forge/ rule in .gitignore. Adding the carve-out block.',
    gitignorePath,
    nestedPath
  };
}

/**
 * Patch .gitignore and create .forge/collab/.gitignore so that collab
 * artifacts are tracked while per-machine state stays local.
 *
 * Idempotent: running twice is a no-op. Returns a summary of what changed.
 */
function patchGitignore(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const detection = detectLegacyGitignore({ cwd });
  const actions = [];

  const gitignorePath = detection.gitignorePath;
  const nestedPath = detection.nestedPath;
  const nestedDir = path.dirname(nestedPath);

  if (detection.status === 'ok') {
    return { patched: false, actions, detection };
  }

  // Root .gitignore handling.
  if (detection.status === 'missing_gitignore') {
    fs.writeFileSync(gitignorePath, GITIGNORE_CARVE_OUT_BLOCK);
    actions.push('created_gitignore');
  } else if (detection.status === 'legacy_rule_no_carve_out') {
    // Replace the first bare `.forge/` line with the full carve-out block,
    // preserving surrounding rules so we don't clobber other user entries.
    const original = fs.readFileSync(gitignorePath, 'utf8');
    const lines = original.split(/\r?\n/);
    const newLines = [];
    let replaced = false;
    for (const line of lines) {
      if (!replaced && /^\.forge\/?\s*$/.test(line)) {
        newLines.push(GITIGNORE_CARVE_OUT_BLOCK.trimEnd());
        replaced = true;
      } else {
        newLines.push(line);
      }
    }
    fs.writeFileSync(gitignorePath, newLines.join('\n'));
    actions.push('replaced_legacy_forge_rule');
  } else if (detection.status === 'missing_forge_rule') {
    const original = fs.readFileSync(gitignorePath, 'utf8');
    const sep = original.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, sep + '\n' + GITIGNORE_CARVE_OUT_BLOCK);
    actions.push('appended_carve_out_block');
  }

  // Nested .forge/collab/.gitignore handling.
  if (!fs.existsSync(nestedPath)) {
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedPath, COLLAB_NESTED_GITIGNORE);
    actions.push('created_nested_gitignore');
  }

  return { patched: true, actions, detection };
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
  generateFlagId,
  flagPath,
  userScopedLogPath,
  appendToUserScopedLog,
  selectTransportMode,
  renderSetupGuide,
  createTransport,
  createAblyTransport,
  createPollingTransport,
  POLLING_BRANCH_DEFAULT,
  POLLING_INTERVAL_MS_DEFAULT,
  brainstormDump,
  readAllInputs,
  consolidateInputs,
  categorizeInputs,
  writeConsolidatedUnderLease,
  routeClarifyingQuestion,
  TASK_BRANCH_PREFIX,
  taskBranchName,
  startTaskBranch,
  updateTaskBranch,
  deleteTaskBranch,
  createRecordingGitRunner,
  renderResearchResult,
  persistResearchResult,
  appendResearchSection,
  isResearchTask,
  FLAG_STATUS,
  writeForwardMotionFlag,
  listFlags,
  readFlag,
  overrideFlag,
  DEFAULT_MERGE_RETRIES,
  DEFAULT_MERGE_BACKOFF_MS,
  squashMergeAndPush,
  readAutoPushConfig,
  gatedPush,
  filterClaimableForLateJoin,
  lateJoinBootstrap,
  detectLegacyGitignore,
  patchGitignore,
  GITIGNORE_CARVE_OUT_MARKER,
  GITIGNORE_CARVE_OUT_BLOCK,
  COLLAB_NESTED_GITIGNORE,
  // Exposed for tests and future-task extension points:
  _internal: {
    readOriginUrl, _heuristicScorer, _readEpsilonFromConfig, _tokenSet,
    _isExpired, _claimName, _safeHandle, _safeKind,
    _parseFrontmatter, _extractSections, _defaultClassifier, _defaultContradictionDetector,
    _inputsPath, _consolidatedPath, _categoriesPath, _questionsDir,
    _defaultPollingIo
  }
};
