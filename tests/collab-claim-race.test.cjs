#!/usr/bin/env node
// tests/collab-claim-race.test.cjs
//
// Regression test for forge-self-fixes-2 R010.
//
// Before the fix, Ably's cas() returned a Promise. tryAcquireLease used
// the sync assignment `const ok = transport.cas(...)`, so `ok` was a
// Promise object and `if (!ok)` never triggered. Every claim returned
// acquired:true regardless of who actually held the lease on the wire.
//
// This test simulates the async-cas contract deterministically in-process
// without requiring a real Ably channel. A shared store resolves exactly
// one proposal as winner via election-by-timestamp, matching the wire
// semantics documented in createAblyTransport.cas.

'use strict';

const assert = require('node:assert');
const { tryAcquireLease, claimTask } = require('../scripts/forge-collab.cjs');

// -----------------------------------------------------------------------
// Async-CAS mock. Two transports share one `wire` map so a claim on one
// is visible to the other. cas() returns a Promise that resolves AFTER a
// short election window — the earliest (ts asc, from asc) proposal that
// matches `expected` wins. Before R010 the caller treated the Promise as
// truthy and always "won", so this test would see BOTH transports claim
// the same lease.
// -----------------------------------------------------------------------
function mkAsyncCasTransport(clientId, wire) {
  return {
    mode: 'memory-async',
    read(name) {
      const v = wire.store.get(name);
      return v ? Object.assign({}, v) : null;
    },
    cas(name, expected, next) {
      const ts = Date.now();
      if (!wire.queue.has(name)) wire.queue.set(name, []);
      // Each proposal captures its own resolve function so the earliest
      // timer can resolve ALL pending proposals atomically when the
      // election runs. This matches Ably's publish-ack where one echoer
      // decides the winner and every proposer receives a cas_won event.
      return new Promise((resolve) => {
        const proposal = { clientId, expected, next, ts, resolve };
        wire.queue.get(name).push(proposal);
        // Only the first proposal in each election window schedules a
        // timer. Subsequent proposals piggyback. Mirrors the casElectionMs
        // coalescing in the real Ably transport.
        if (wire.queue.get(name).length === 1) {
          setTimeout(() => {
            const pending = wire.queue.get(name) || [];
            const sorted = pending.slice().sort(
              (a, b) => a.ts - b.ts || a.clientId.localeCompare(b.clientId)
            );
            const current = wire.store.get(name) || null;
            let winner = null;
            for (const p of sorted) {
              if (_same(p.expected, current)) { winner = p; break; }
            }
            if (winner && winner.next !== null) {
              wire.store.set(name, Object.assign({}, winner.next));
            } else if (winner && winner.next === null) {
              wire.store.delete(name);
            }
            // Clear the queue BEFORE resolving so any cas() call issued
            // from a then-handler lands in a fresh election.
            wire.queue.set(name, []);
            for (const p of sorted) p.resolve(p === winner);
          }, 25);
        }
      });
    },
    del(name, expected) { return this.cas(name, expected, null); },
    list() {
      return Array.from(wire.store.values()).map((v) => Object.assign({}, v));
    }
  };
}

function _same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.claimant === b.claimant && a.acquiredAt === b.acquiredAt;
}

// -----------------------------------------------------------------------
// Test 1: the exact 2026-04-22 Tier-2 reproducer. Two Ably-shape transports
// share one wire; both claim the same task in parallel; exactly one wins.
// -----------------------------------------------------------------------
async function testExactlyOneWinnerOnSharedWire() {
  const wire = { store: new Map(), queue: new Map() };
  const tLucas = mkAsyncCasTransport('lucas', wire);
  const tDaisy = mkAsyncCasTransport('daisy', wire);

  const [rL, rD] = await Promise.all([
    claimTask(tLucas, 'T001', 'lucas', { ttlSeconds: 60 }),
    claimTask(tDaisy, 'T001', 'daisy', { ttlSeconds: 60 })
  ]);

  const winners = [rL.acquired, rD.acquired].filter(Boolean).length;
  assert.strictEqual(winners, 1,
    `exactly one participant should win; got ${winners}. rL=${JSON.stringify(rL)} rD=${JSON.stringify(rD)}`);

  // The non-winner must have acquired:false with a reason.
  const loser = rL.acquired ? rD : rL;
  assert.strictEqual(loser.acquired, false);
  assert.ok(/lost_race|held_by/.test(loser.reason), `loser.reason should be lost_race or held_by_*, got ${loser.reason}`);

  // The wire has exactly one lease, held by the winner.
  const leases = tLucas.list();
  assert.strictEqual(leases.length, 1);
  const winnerHandle = rL.acquired ? 'lucas' : 'daisy';
  assert.strictEqual(leases[0].claimant, winnerHandle);

  console.log('PASS  testExactlyOneWinnerOnSharedWire (winner:', winnerHandle + ')');
}

// -----------------------------------------------------------------------
// Test 2: returned object shape survives the async path. Before R010 the
// caller accidentally returned the Promise as `ok`, hiding the real shape.
// -----------------------------------------------------------------------
async function testClaimResultShape() {
  const wire = { store: new Map(), queue: new Map() };
  const t = mkAsyncCasTransport('solo', wire);
  const r = await tryAcquireLease(t, 'consolidation', 'solo', { ttlSeconds: 30 });
  assert.strictEqual(r.acquired, true);
  assert.ok(r.lease, 'lease property present on acquired result');
  assert.strictEqual(r.lease.claimant, 'solo');
  assert.ok(r.lease.expiresAt, 'expiresAt on lease');
  console.log('PASS  testClaimResultShape');
}

// -----------------------------------------------------------------------
// Test 3: memory-transport path stays sync-compatible. The fix used
// `await`, which resolves non-Promises to themselves; this test confirms
// the memory transport (which returns sync bool) still works unchanged.
// -----------------------------------------------------------------------
async function testMemoryTransportBackcompat() {
  const { createMemoryTransport } = require('../scripts/forge-collab.cjs');
  const t = createMemoryTransport({ clientId: 'test' });
  const r1 = await tryAcquireLease(t, 'X', 'a');
  assert.strictEqual(r1.acquired, true);
  const r2 = await tryAcquireLease(t, 'X', 'b');
  assert.strictEqual(r2.acquired, false);
  assert.match(r2.reason, /held_by_a/);
  console.log('PASS  testMemoryTransportBackcompat');
}

async function run_all() {
  const tests = [
    testExactlyOneWinnerOnSharedWire,
    testClaimResultShape,
    testMemoryTransportBackcompat
  ];
  let failed = 0;
  for (const t of tests) {
    try { await t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run_all();
