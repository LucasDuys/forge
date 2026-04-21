// tests/forge-collab-ably-cas.test.cjs
//
// T024 (spec-collab-fix R005): Ably CAS authoritative via publish-ack.
//
// The old Ably cas() mutated a local Map and returned a sync boolean, so two
// clients racing null -> lease both returned true against their empty caches.
// The fix makes cas() async and routes the "who won?" decision through three
// wire events (cas_propose, cas_won, lease-update) with a deterministic
// election rule:
//
//   - If someone holds the lease, they echo the first valid proposal
//     (ordered by ts asc, then clientId asc).
//   - If nobody holds, the lowest-clientId participant echoes.
//   - Proposer returns true on its own cas_won echo, false otherwise.
//   - 500 ms timeout returns false with _internal.lastCasResult.reason
//     === "cas_timeout".
//
// This suite covers the four scenarios R005 calls out, using a mock Ably
// client injected via Module._load. The mock supports configurable delivery
// latency so contemporaneous proposals can be simulated without real I/O.

const Module = require('node:module');
const { suite, test, assert, runTests } = require('./_helper.cjs');

// ---------------------------------------------------------------------------
// Ably mock with per-publish delivery delay.
// ---------------------------------------------------------------------------
//
// This is a richer cousin of the one in forge-collab-target-filter.test.cjs:
// it lets a test say "every message on this channel delivers after N ms" so
// two near-simultaneous cas_propose publishes arrive in a shuffled order
// after everyone has had a chance to publish. Without the delay knob, the
// first publish is already fully delivered before the second publish begins,
// which hides the race the fix is meant to resolve.

function makeAblyMock(opts) {
  opts = opts || {};
  const deliveryDelayMs = Number.isFinite(opts.deliveryDelayMs) ? opts.deliveryDelayMs : 0;
  const channelsByName = new Map();
  const pendingTimers = new Set();

  function getChannel(name) {
    let ch = channelsByName.get(name);
    if (ch) return ch;
    const listeners = []; // { event, fn }
    ch = {
      _listeners: listeners,
      _scheduleDeliver(event, data, fromClientId) {
        const envelope = { name: event, data, clientId: fromClientId };
        const fire = () => {
          for (const l of listeners) {
            if (l.event !== event) continue;
            try { l.fn(envelope); } catch (_) {}
          }
        };
        if (deliveryDelayMs > 0) {
          const t = setTimeout(() => {
            pendingTimers.delete(t);
            fire();
          }, deliveryDelayMs);
          if (t && t.unref) t.unref();
          pendingTimers.add(t);
        } else {
          // Preserve the same-tick same-channel fan-out ordering that real
          // ably gives when no latency is simulated: synchronous invoke.
          fire();
        }
      },
      publish(event, data, fromClientId) {
        ch._scheduleDeliver(event, data, fromClientId || ch._lastPublisher);
      },
      subscribe(event, fn) {
        listeners.push({ event, fn });
      }
    };
    channelsByName.set(name, ch);
    return ch;
  }

  class Realtime {
    constructor(initOpts) {
      this._clientId = initOpts.clientId;
      this.connection = {
        once: (ev, cb) => { if (ev === 'connected') setImmediate(cb); }
      };
      this.channels = {
        get: (name) => {
          const ch = getChannel(name);
          return {
            publish: (event, data) => ch.publish(event, data, this._clientId),
            subscribe: (event, fn) => ch.subscribe(event, fn),
            _listeners: ch._listeners
          };
        }
      };
    }
    close() { /* no-op */ }
  }

  return { Realtime, _pendingTimers: pendingTimers };
}

function installAblyMock(mock) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'ably') return mock;
    return origLoad.call(this, request, parent, isMain);
  };
  return function restore() { Module._load = origLoad; };
}

// The transport requires `ably` in its module factory; we install the mock
// BEFORE requiring forge-collab so the inner require('ably') is intercepted.
const collab = require('../scripts/forge-collab.cjs');
const { createAblyTransport } = collab;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('ably CAS authoritative (R005)', () => {
  test('two simultaneous cas(name, null, lease) under 100 ms latency: exactly one true', async () => {
    const restore = installAblyMock(makeAblyMock({ deliveryDelayMs: 100 }));
    try {
      // Use sorted clientIds so the no-holder tiebreak is stable: alice is
      // the lowest and will be the echoer.
      const tAlice = createAblyTransport({ apiKey: 'k', clientId: 'alice', channel: 'cas-race' });
      const tBob   = createAblyTransport({ apiKey: 'k', clientId: 'bob',   channel: 'cas-race' });
      await tAlice.connect();
      await tBob.connect();

      // Both sides must know each other exists before the election fires,
      // otherwise alice's own participants set is {alice} and she would
      // decide the winner in isolation. A single warmup proposal on a
      // throwaway lease seeds both participants sets.
      await tAlice.cas('_warmup', null, { name: '_warmup', claimant: 'alice', acquiredAt: 'T0', expiresAt: 'T1' });
      await tBob.cas('_warmup_b', null, { name: '_warmup_b', claimant: 'bob', acquiredAt: 'T0', expiresAt: 'T1' });

      const leaseA = { name: 'claim:T001', claimant: 'alice', acquiredAt: 'Ta', expiresAt: 'Tax' };
      const leaseB = { name: 'claim:T001', claimant: 'bob',   acquiredAt: 'Tb', expiresAt: 'Tbx' };

      // Fire both proposals without awaiting between them. Under
      // deliveryDelayMs=100, both cas_propose envelopes are scheduled for
      // +100 ms before either has been delivered, so the election runs on
      // the full contended queue.
      const pA = tAlice.cas('claim:T001', null, leaseA);
      const pB = tBob.cas('claim:T001', null, leaseB);
      const [rA, rB] = await Promise.all([pA, pB]);

      const wins = [rA, rB].filter(x => x === true).length;
      assert.strictEqual(wins, 1, 'exactly one cas returns true');
      // The lower clientId (alice) is the elected echoer since nobody holds
      // the lease yet; her own proposal carries ts <= bob's in the common
      // case where both scheduled in-process, but even if bob's ts is lower
      // the rule still picks one deterministically.
      assert.strictEqual(rA === true || rB === true, true, 'at least one winner');
      assert.strictEqual(rA !== rB, true, 'the two results disagree');

      await tAlice.disconnect(); await tBob.disconnect();
    } finally {
      restore();
    }
  });

  test('timeout: no ack within 500 ms returns false with reason "cas_timeout"', async () => {
    // Install a mock whose delivery delay EXCEEDS the cas timeout budget.
    // Even though the proposer itself is a valid echoer (lowest clientId in
    // a single-participant world), the echo it publishes is scheduled with
    // a 600 ms delay and so cannot arrive before the 500 ms timeout.
    //
    // IMPORTANT: casElectionMs defaults to 150 ms; we need electionMs + delay
    // to exceed 500 ms. 150 + 600 = 750 ms > 500 ms ✓.
    const restore = installAblyMock(makeAblyMock({ deliveryDelayMs: 600 }));
    try {
      const t = createAblyTransport({ apiKey: 'k', clientId: 'solo', channel: 'cas-timeout' });
      await t.connect();

      const start = Date.now();
      const result = await t.cas('claim:T002', null, {
        name: 'claim:T002', claimant: 'solo', acquiredAt: 'T0', expiresAt: 'T1'
      });
      const elapsed = Date.now() - start;

      assert.strictEqual(result, false, 'cas returns false on timeout');
      const last = t._internal.lastCasResult;
      assert.ok(last, 'lastCasResult recorded');
      assert.strictEqual(last.reason, 'cas_timeout', 'reason is cas_timeout');
      assert.ok(elapsed >= 500, 'at least 500 ms elapsed, got ' + elapsed);
      assert.ok(elapsed < 1500, 'timed out without hanging, got ' + elapsed);
      // The expected state is still current on next read: nothing was
      // committed because no cas_won arrived.
      assert.strictEqual(t.read('claim:T002'), null);

      await t.disconnect();
    } finally {
      restore();
    }
  });

  test('holder-of-record: A holds, B+C propose with matching expected, A echoes first by ts', async () => {
    const restore = installAblyMock(makeAblyMock({ deliveryDelayMs: 50 }));
    try {
      const tA = createAblyTransport({ apiKey: 'k', clientId: 'alice',   channel: 'cas-holder' });
      const tB = createAblyTransport({ apiKey: 'k', clientId: 'bob',     channel: 'cas-holder' });
      const tC = createAblyTransport({ apiKey: 'k', clientId: 'charlie', channel: 'cas-holder' });
      await tA.connect(); await tB.connect(); await tC.connect();

      // Alice acquires the lease first. After this, everyone's localLeases
      // converges on the same holder via the lease-update echo, so the
      // holder-of-record rule ("Alice is the echoer") applies.
      const holderLease = { name: 'claim:T003', claimant: 'alice', acquiredAt: 'T0', expiresAt: 'T100' };
      const ok0 = await tA.cas('claim:T003', null, holderLease);
      assert.strictEqual(ok0, true, 'Alice initial acquire succeeds');
      // Wait long enough for the lease-update broadcast to reach B and C.
      await new Promise(r => setTimeout(r, 200));
      assert.deepStrictEqual(tB.read('claim:T003'), holderLease, 'B sees alice as holder');
      assert.deepStrictEqual(tC.read('claim:T003'), holderLease, 'C sees alice as holder');

      // B and C both propose an override. Both pass expected=holderLease
      // (the current state), so the holder Alice will accept either. Under
      // deliveryDelayMs=50 ms both proposals arrive at Alice in the same
      // election window and she picks the one with the lower ts.
      const leaseFromB = { name: 'claim:T003', claimant: 'bob',     acquiredAt: 'T200', expiresAt: 'T300' };
      const leaseFromC = { name: 'claim:T003', claimant: 'charlie', acquiredAt: 'T201', expiresAt: 'T301' };

      const pB = tB.cas('claim:T003', holderLease, leaseFromB);
      // Tiny stagger so B's ts is strictly less than C's under Date.now()
      // resolution. 5 ms is well below deliveryDelayMs so both still land
      // at Alice within one election window.
      await new Promise(r => setTimeout(r, 5));
      const pC = tC.cas('claim:T003', holderLease, leaseFromC);

      const [rB, rC] = await Promise.all([pB, pC]);
      assert.strictEqual(rB, true,  'B wins (lower ts)');
      assert.strictEqual(rC, false, 'C loses');

      await tA.disconnect(); await tB.disconnect(); await tC.disconnect();
    } finally {
      restore();
    }
  });

  test('no-holder tiebreak: A+B both propose null-expected, lowest clientId wins', async () => {
    // When nobody holds the lease and two proposals arrive with indistinguishable
    // ts, the echo authority falls to the lowest-clientId participant and they
    // apply (ts, from) ordering to pick a winner. Strings "alice" < "bob"
    // so Alice wins both the echo and the election.
    const restore = installAblyMock(makeAblyMock({ deliveryDelayMs: 80 }));
    try {
      const tA = createAblyTransport({ apiKey: 'k', clientId: 'alice', channel: 'cas-tiebreak' });
      const tB = createAblyTransport({ apiKey: 'k', clientId: 'bob',   channel: 'cas-tiebreak' });
      await tA.connect(); await tB.connect();

      // Seed participant sets on both nodes so Alice knows Bob exists and
      // Bob knows Alice exists BEFORE the contended election. Without this,
      // Alice's participants={alice} and she'd always echo even when she
      // should wait for Bob's perspective (the rule still picks her, but the
      // test exercises the multi-node election path).
      await tA.cas('_seed', null, { name: '_seed', claimant: 'alice', acquiredAt: 'T', expiresAt: 'T' });
      await tB.cas('_seed2', null, { name: '_seed2', claimant: 'bob', acquiredAt: 'T', expiresAt: 'T' });

      const leaseA = { name: 'claim:T004', claimant: 'alice', acquiredAt: 'Ta', expiresAt: 'Tax' };
      const leaseB = { name: 'claim:T004', claimant: 'bob',   acquiredAt: 'Tb', expiresAt: 'Tbx' };

      // Fire both proposals synchronously in the same tick so their Date.now()
      // ts values are likely identical. Even if one ms differs, the test is
      // still valid for the general "lowest clientId under equal ts" rule
      // because Alice's ts can only be <= Bob's in same-tick scheduling.
      const pA = tA.cas('claim:T004', null, leaseA);
      const pB = tB.cas('claim:T004', null, leaseB);
      const [rA, rB] = await Promise.all([pA, pB]);

      assert.strictEqual(rA, true,  'alice wins (lowest clientId or equal-ts tiebreak)');
      assert.strictEqual(rB, false, 'bob loses');

      await tA.disconnect(); await tB.disconnect();
    } finally {
      restore();
    }
  });
});

runTests();
