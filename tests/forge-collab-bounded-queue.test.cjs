// tests/forge-collab-bounded-queue.test.cjs
//
// T019 (spec-collab-fix R003): bounded message queue + per-process dedup
// + schema validator on the polling-transport state document.
//
// Four ACs under test:
//   1. 501 messages -> 500 retained, oldest 1 evicted, warn emitted.
//   2. Per-process seenIds dedup: the same message id arriving twice via
//      _refresh fires subscriber callbacks exactly once.
//   3. TTL + cap compose: TTL prunes stale entries first, cap then evicts
//      the oldest-non-stale if still over the ceiling.
//   4. Schema validator accepts the valid shape and warns (does not throw)
//      on malformed shapes.
//
// Tests 1 + 3 touch real git (via _defaultPollingIo). They are skipped
// cleanly when git is not on PATH, matching forge-collab-polling-real's
// gating convention.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const { createPollingTransport } = collab;
const {
  _defaultPollingIo,
  _validateStateShape,
  MESSAGE_QUEUE_CAP,
  SCHEMA_PATH
} = collab._internal;

const BRANCH = 'forge/collab-state';

// ---------------------------------------------------------------------------
// Real-git harness (copied shape from forge-collab-polling-real.test.cjs).
// ---------------------------------------------------------------------------

function git(cwd, args, opts) {
  opts = opts || {};
  // stdin must be 'pipe' when input is present, otherwise execFileSync
  // silently drops the payload (the T013 fix for _defaultPollingIo.run).
  const hasInput = opts.input != null;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: hasInput ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: opts.input
  });
}

function setupBareAndClone() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-bq-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');

  git(root, ['init', '--bare', '-b', 'main', 'origin.git']);

  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.email', 'bq-test@forge.local']);
  git(seed, ['config', 'user.name', 'BQ Test']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);

  git(root, ['clone', bare, path.basename(clone)]);
  git(clone, ['config', 'user.email', 'bq-test@forge.local']);
  git(clone, ['config', 'user.name', 'BQ Test']);

  return { root, bare, clone };
}

function cleanup(root) {
  if (!root) return;
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  catch (_) { /* best effort on Windows */ }
}

// Capture console.warn calls for the duration of `fn()`.
async function withWarnCapture(fn) {
  const captured = [];
  const orig = console.warn;
  console.warn = (...args) => { captured.push(args.map(String).join(' ')); };
  try { await fn(captured); }
  finally { console.warn = orig; }
  return captured;
}

// ---------------------------------------------------------------------------
// Suite 1: schema validator
// ---------------------------------------------------------------------------

suite('forge-collab R003: schema validator', () => {
  test('schema file is valid JSON and describes {leases, messages}', () => {
    assert.ok(fs.existsSync(SCHEMA_PATH), 'schema file exists at ' + SCHEMA_PATH);
    const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const schema = JSON.parse(raw);
    assert.strictEqual(schema.type, 'object');
    assert.deepStrictEqual(schema.required.sort(), ['leases', 'messages']);
    assert.ok(schema.properties && schema.properties.leases);
    assert.ok(schema.properties && schema.properties.messages);
    assert.strictEqual(schema.properties.messages.maxItems, 500);
  });

  test('_validateStateShape accepts a valid state document', () => {
    const state = {
      leases: {
        'claim:T001': { claimant: 'alice', acquiredAt: '2026-04-20T10:00:00.000Z' }
      },
      messages: [
        { id: 'm1', event: 'lock-claim', data: { task: 'T001' }, from: 'alice', ts: '2026-04-20T10:00:00.000Z' }
      ]
    };
    const res = _validateStateShape(state);
    assert.strictEqual(res.valid, true, 'expected valid, got errors: ' + res.errors.join('; '));
    assert.deepStrictEqual(res.errors, []);
  });

  test('_validateStateShape accepts empty {leases:{}, messages:[]}', () => {
    const res = _validateStateShape({ leases: {}, messages: [] });
    assert.strictEqual(res.valid, true);
  });

  test('_validateStateShape tolerates unknown keys (forward compat)', () => {
    const res = _validateStateShape({
      leases: {}, messages: [], version: 2, extra: { foo: 'bar' }
    });
    assert.strictEqual(res.valid, true);
  });

  test('_validateStateShape flags non-object state', () => {
    const res = _validateStateShape(null);
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.length > 0);
  });

  test('_validateStateShape flags missing message.id', () => {
    const state = {
      leases: {},
      messages: [{ event: 'x', from: 'a', ts: '2026-04-20T10:00:00.000Z' }]
    };
    const res = _validateStateShape(state);
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => /messages\[0\]\.id/.test(e)));
  });

  test('_validateStateShape flags malformed lease', () => {
    const state = {
      leases: { 'claim:T001': { claimant: 'alice' } }, // missing acquiredAt
      messages: []
    };
    const res = _validateStateShape(state);
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => /acquiredAt/.test(e)));
  });

  test('_validateStateShape flags messages as non-array', () => {
    const res = _validateStateShape({ leases: {}, messages: 'not-array' });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => /messages/.test(e)));
  });

  test('MESSAGE_QUEUE_CAP is 500 (matches schema maxItems)', () => {
    assert.strictEqual(MESSAGE_QUEUE_CAP, 500);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: per-process seenIds dedup (stub ioAdapter, no git)
// ---------------------------------------------------------------------------

suite('forge-collab R003: seenIds dedup in _refresh', () => {
  test('same messageId from two _refresh() calls fires cb exactly once', async () => {
    // Stub io returns the same message every time readBranch() is called.
    // Dedup must keep cb-invocation count at 1 regardless of poll count.
    const state = {
      leases: {},
      messages: [
        { id: 'stable-msg-1', event: 'lock-claim', data: { task: 'T777' },
          from: 'alice', ts: new Date().toISOString() }
      ]
    };
    const io = {
      async ensureBranch() { return true; },
      async readBranch() { return JSON.parse(JSON.stringify(state)); },
      async writeLease() { return true; },
      async appendMessage() { return true; }
    };
    const t = createPollingTransport({
      ioAdapter: io, clientId: 'bob', intervalMs: 60_000
    });

    const received = [];
    t.subscribe('lock-claim', (m) => received.push(m));

    await t._internal._refresh();
    await t._internal._refresh();
    await t._internal._refresh();

    assert.strictEqual(received.length, 1,
      'expected exactly one delivery; got ' + received.length);
    assert.strictEqual(received[0].data.task, 'T777');
    // seenIds getter returns a copy
    const seen = t._internal.seenIds;
    assert.ok(seen.has('stable-msg-1'), 'seenIds must record delivered id');
  });

  test('distinct ids still deliver; only duplicate-by-id is dropped', async () => {
    const state = { leases: {}, messages: [] };
    const io = {
      async ensureBranch() { return true; },
      async readBranch() { return JSON.parse(JSON.stringify(state)); },
      async writeLease() { return true; },
      async appendMessage() { return true; }
    };
    const t = createPollingTransport({
      ioAdapter: io, clientId: 'charlie', intervalMs: 60_000
    });
    const received = [];
    t.subscribe('lock-claim', (m) => received.push(m.data.n));

    state.messages.push({ id: 'a', event: 'lock-claim', data: { n: 1 }, from: 'x', ts: new Date().toISOString() });
    await t._internal._refresh();
    state.messages.push({ id: 'b', event: 'lock-claim', data: { n: 2 }, from: 'x', ts: new Date().toISOString() });
    await t._internal._refresh();
    // replay: 'a' already seen, 'b' already seen, new 'c' arrives
    state.messages.push({ id: 'c', event: 'lock-claim', data: { n: 3 }, from: 'x', ts: new Date().toISOString() });
    await t._internal._refresh();
    await t._internal._refresh(); // extra poll, no new ids

    assert.deepStrictEqual(received, [1, 2, 3],
      'expected one delivery per distinct id, in order');
  });

  test('messages without an id are skipped (defensive)', async () => {
    const state = {
      leases: {},
      messages: [
        { event: 'lock-claim', data: { n: 1 }, from: 'x', ts: new Date().toISOString() }
      ]
    };
    const io = {
      async ensureBranch() { return true; },
      async readBranch() { return JSON.parse(JSON.stringify(state)); },
      async writeLease() { return true; },
      async appendMessage() { return true; }
    };
    const t = createPollingTransport({
      ioAdapter: io, clientId: 'd', intervalMs: 60_000
    });
    const received = [];
    t.subscribe('lock-claim', (m) => received.push(m));
    await t._internal._refresh();
    assert.strictEqual(received.length, 0,
      'id-less messages cannot be safely deduped -> skip');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: real-git appendMessage cap + TTL compose
// ---------------------------------------------------------------------------

suite('forge-collab R003: appendMessage cap + TTL compose (real git)', () => {
  test('501 messages -> 500 retained, 1 evicted, warn emitted', async () => {
    if (!gitAvailable()) return; // matches polling-real skip convention
    const { root, clone } = setupBareAndClone();
    try {
      const io = _defaultPollingIo({ cwd: clone, autoPush: true, ttlSeconds: 10_000 });
      await io.ensureBranch(BRANCH);

      // Seed 500 messages in one commit via git plumbing. Doing 500 full
      // appendMessage round-trips would be seconds per call (fetch +
      // ls-remote + hash-object + mktree + commit-tree + push); seeding
      // in a single commit keeps the test fast while still exercising
      // the real appendMessage path for the 501st write.
      const freshTs = new Date().toISOString();
      const seeded = { leases: {}, messages: [] };
      for (let i = 0; i < 500; i++) {
        seeded.messages.push({
          id: 'cap-m-' + i,
          event: 'lock-claim',
          data: { n: i },
          from: 'alice',
          ts: freshTs
        });
      }
      const blob = git(clone, ['hash-object', '-w', '--stdin'], {
        input: JSON.stringify(seeded, null, 2) + '\n'
      }).trim();
      const tree = git(clone, ['mktree'], {
        input: '100644 blob ' + blob + '\tstate.json\n'
      }).trim();
      const commit = git(clone, ['commit-tree', tree, '-m', 'seed 500 messages']).trim();
      git(clone, ['push', '--force', 'origin', commit + ':refs/heads/' + BRANCH]);

      // Fire the 501st append via the real code path.
      const warns = await withWarnCapture(async () => {
        const res = await io.appendMessage(BRANCH, {
          id: 'cap-m-500',
          event: 'lock-claim',
          data: { n: 500 },
          from: 'alice',
          ts: new Date().toISOString()
        });
        assert.ok(res && res.ok, 'appendMessage failed: ' + JSON.stringify(res));
      });

      const state = await io.readBranch(BRANCH);
      assert.strictEqual(state.messages.length, 500,
        'messages should be capped at 500, got ' + state.messages.length);
      // Oldest (id=cap-m-0) must have been evicted; newest (id=cap-m-500) retained.
      const ids = new Set(state.messages.map(m => m.id));
      assert.ok(!ids.has('cap-m-0'), 'oldest (cap-m-0) must be evicted');
      assert.ok(ids.has('cap-m-500'), 'newest (cap-m-500) must be retained');
      assert.ok(ids.has('cap-m-1'), 'second-oldest (cap-m-1) must be retained');

      // Warn contract: "forge:collab message queue at cap, evicting N oldest"
      const evictWarns = warns.filter(w => /message queue at cap, evicting \d+ oldest/.test(w));
      assert.ok(evictWarns.length >= 1,
        'expected at least one eviction warn; got: ' + JSON.stringify(warns));
    } finally {
      cleanup(root);
    }
  });

  test('TTL + cap compose: prune first, then evict oldest-non-stale', async () => {
    if (!gitAvailable()) return;
    const { root, clone } = setupBareAndClone();
    try {
      // Scenario: seed state with 300 stale (ts 1 hour ago) + 250 fresh
      // (ts 1 second ago). ttlSeconds = 60 so the 300 stale are past-ttl
      // and the 250 fresh are not. Then append 1 more.
      //
      // Expected compose inside appendMessage:
      //   prune -> removes 300 stale, keeps 250 fresh         (length 250)
      //   append new -> length 251
      //   cap check: 251 < 500 -> no eviction, no warn
      //
      // This proves the order: TTL prunes before cap. If cap ran first
      // on 550 entries the result would be 500 with stale entries still
      // present.
      const staleTs = new Date(Date.now() - 3600_000).toISOString();
      const freshTs = new Date(Date.now() - 1000).toISOString();
      const seeded = { leases: {}, messages: [] };
      for (let i = 0; i < 300; i++) {
        seeded.messages.push({
          id: 'stale-' + i, event: 'lock-claim', data: {}, from: 'x', ts: staleTs
        });
      }
      for (let i = 0; i < 250; i++) {
        seeded.messages.push({
          id: 'fresh-' + i, event: 'lock-claim', data: {}, from: 'x', ts: freshTs
        });
      }
      const blob = git(clone, ['hash-object', '-w', '--stdin'], {
        input: JSON.stringify(seeded, null, 2) + '\n'
      }).trim();
      const tree = git(clone, ['mktree'], {
        input: '100644 blob ' + blob + '\tstate.json\n'
      }).trim();
      const commit = git(clone, ['commit-tree', tree, '-m', 'seed stale+fresh']).trim();
      git(clone, ['push', '--force', 'origin', commit + ':refs/heads/' + BRANCH]);

      const io = _defaultPollingIo({ cwd: clone, autoPush: true, ttlSeconds: 60 });

      const warns = await withWarnCapture(async () => {
        const res = await io.appendMessage(BRANCH, {
          id: 'compose-new',
          event: 'lock-claim',
          data: {},
          from: 'x',
          ts: new Date().toISOString()
        });
        assert.ok(res && res.ok, 'appendMessage failed: ' + JSON.stringify(res));
      });

      const state = await io.readBranch(BRANCH);
      assert.strictEqual(state.messages.length, 251,
        'TTL-pruned 300 stale + appended 1 -> expected 251, got ' + state.messages.length);
      const ids = new Set(state.messages.map(m => m.id));
      assert.ok(!ids.has('stale-0'), 'stale entries must be pruned');
      assert.ok(!ids.has('stale-299'), 'all stale entries must be pruned');
      assert.ok(ids.has('fresh-0'), 'fresh entries must survive');
      assert.ok(ids.has('fresh-249'), 'all fresh entries must survive');
      assert.ok(ids.has('compose-new'), 'new append must land');
      // No eviction warn since length (251) never exceeded cap (500).
      const evictWarns = warns.filter(w => /message queue at cap/.test(w));
      assert.strictEqual(evictWarns.length, 0,
        'expected zero eviction warns (length below cap); got: ' + JSON.stringify(warns));
    } finally {
      cleanup(root);
    }
  });

  test('schema validator warns on read of malformed state (no throw)', async () => {
    if (!gitAvailable()) return;
    const { root, clone } = setupBareAndClone();
    try {
      const io = _defaultPollingIo({ cwd: clone, autoPush: true });
      await io.ensureBranch(BRANCH);

      // Write one valid message so state has content.
      await io.appendMessage(BRANCH, {
        id: 'valid-msg',
        event: 'lock-claim',
        data: { ok: true },
        from: 'alice',
        ts: new Date().toISOString()
      });

      // Hand-craft a malformed state on origin: messages[0].id missing.
      const malformed = {
        leases: {},
        messages: [{ event: 'lock-claim', from: 'x', ts: new Date().toISOString() }]
      };
      // Seed the malformed document via plumbing: hash-object + mktree +
      // commit-tree + push --force.
      const blob = git(clone, ['hash-object', '-w', '--stdin'], {
        input: JSON.stringify(malformed, null, 2) + '\n'
      }).trim();
      const tree = git(clone, ['mktree'], {
        input: '100644 blob ' + blob + '\tstate.json\n'
      }).trim();
      const commit = git(clone, ['commit-tree', tree, '-m', 'malformed']).trim();
      git(clone, ['push', '--force', 'origin', commit + ':refs/heads/' + BRANCH]);

      // Now read -- must warn, must not throw, must return the shape
      // we set (forward-compat).
      const warns = await withWarnCapture(async () => {
        const s = await io.readBranch(BRANCH);
        assert.ok(s && Array.isArray(s.messages));
      });
      const schemaWarns = warns.filter(w => /schema violation on read/.test(w));
      assert.ok(schemaWarns.length >= 1,
        'expected at least one read-side schema warn; got: ' + JSON.stringify(warns));
    } finally {
      cleanup(root);
    }
  });
});

runTests();
