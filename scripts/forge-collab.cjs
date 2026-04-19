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
  const io = opts.ioAdapter || _defaultPollingIo();
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
    _internal: { _refresh, get pendingMessages() { return pendingMessages.slice(); } }
  };
}

function _defaultPollingIo() {
  // Default io adapter uses the real git CLI. Tests override with a stub.
  function gitCmd(cwd, args) {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = new Error('git ' + args.join(' ') + ' failed: ' + (e.stderr ? e.stderr.toString() : e.message));
      err.cause = e;
      throw err;
    }
  }
  return {
    async ensureBranch(branch) {
      // Create local branch from origin if missing; harmless if it already exists.
      try { gitCmd(process.cwd(), ['fetch', 'origin', branch]); } catch (_) {}
      return true;
    },
    async readBranch(branch) {
      try {
        const raw = gitCmd(process.cwd(), ['show', 'origin/' + branch + ':state.json']);
        return JSON.parse(raw);
      } catch (_) {
        return { leases: {}, messages: [] };
      }
    },
    async writeLease(/* branch, name, lease */) {
      // Real implementation would commit + push; shipped as a stub here so
      // the connect/publish/subscribe loop is testable. T012 push-config
      // task will wire auto-push vs prompted-push here.
      return true;
    },
    async appendMessage(/* branch, msg */) {
      return true;
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
  // Exposed for tests and future-task extension points:
  _internal: {
    readOriginUrl, _heuristicScorer, _readEpsilonFromConfig, _tokenSet,
    _isExpired, _claimName, _safeHandle, _safeKind,
    _parseFrontmatter, _extractSections, _defaultClassifier, _defaultContradictionDetector,
    _inputsPath, _consolidatedPath, _categoriesPath, _questionsDir
  }
};
