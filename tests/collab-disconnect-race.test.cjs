#!/usr/bin/env node
// tests/collab-disconnect-race.test.cjs
//
// Regression test for forge-self-fixes-2 R012. When two Ably transports
// disconnect close together, Ably's ConnectionManager.failQueuedMessages
// throws _ErrorInfo: Connection closed (code 80017) from one of them.
// Process exits 1 on what should be a clean teardown.
//
// We can't run real Ably in a unit test (needs ABLY_KEY and a live
// WebSocket). Instead we stub the `ably` module with a minimal factory
// that simulates the failQueuedMessages path: second close() in quick
// succession throws an ErrorInfo-shaped error with code=80017.

'use strict';

const Module = require('node:module');
const assert = require('node:assert');

// Install an in-process mock for `require('ably')` BEFORE requiring the
// collab module. We hijack Module._resolveFilename so that when Node is
// asked for 'ably' from inside forge-collab.cjs, it gets our mock path.
const mockPath = require('path').join(__dirname, '__ably_mock.cjs');
require('fs').writeFileSync(mockPath, `
'use strict';
let closeCount = 0;
class Realtime {
  constructor(opts) {
    this.key = opts.key;
    this.clientId = opts.clientId;
    this.connection = {
      listeners: { connected: [], failed: [] },
      once(evt, cb) {
        // Immediately fire 'connected' so tests don't wait.
        if (evt === 'connected') setImmediate(cb);
      }
    };
    this.channels = {
      get: () => ({
        subscribe: () => {},
        publish: () => Promise.resolve()
      })
    };
  }
  async close() {
    // Simulate Ably's flush-queued-messages error on the SECOND close
    // that happens within 10ms of the first (mirroring the real race).
    closeCount += 1;
    const myIndex = closeCount;
    const mine = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    if (myIndex >= 2 && Date.now() - mine < 30) {
      const err = new Error('Connection closed');
      err.code = 80017;
      throw err;
    }
  }
  static _reset() { closeCount = 0; }
}
module.exports = { Realtime, _reset: () => { closeCount = 0; } };
`);

const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, ...rest) {
  if (request === 'ably') return mockPath;
  return origResolve(request, ...rest);
};

// Clear any cached forge-collab from earlier test imports (there won't be
// one, but defensive).
try { delete require.cache[require.resolve('../scripts/forge-collab.cjs')]; } catch (_) {}
const collab = require('../scripts/forge-collab.cjs');

// ---------------------------------------------------------------------------
// Test: two transports, parallel disconnect, neither throws.
// ---------------------------------------------------------------------------
async function testParallelDisconnectSwallowsRace() {
  const ablyMock = require(mockPath);
  ablyMock._reset();

  const t1 = collab.createAblyTransport({ apiKey: 'mock', clientId: 'lucas' });
  const t2 = collab.createAblyTransport({ apiKey: 'mock', clientId: 'daisy' });
  await t1.connect();
  await t2.connect();

  // Pre-R012 this Promise.all threw _ErrorInfo: Connection closed.
  // Post-R012 the second disconnect() swallows code 80017.
  await Promise.all([t1.disconnect(), t2.disconnect()]);

  console.log('PASS  testParallelDisconnectSwallowsRace');
}

// ---------------------------------------------------------------------------
// Test: unrelated close() errors still bubble up (don't swallow everything).
// ---------------------------------------------------------------------------
async function testUnrelatedErrorStillThrows() {
  const ablyMock = require(mockPath);
  ablyMock._reset();

  const t = collab.createAblyTransport({ apiKey: 'mock', clientId: 'solo' });
  await t.connect();

  // Replace close() on the internal client with one that throws a
  // non-80017 error, confirming our filter is precise.
  t._internal.client.close = async () => {
    const err = new Error('Auth failed');
    err.code = 40101;
    throw err;
  };
  await assert.rejects(
    () => t.disconnect(),
    (err) => /Auth failed/.test(err.message),
    'non-80017 errors must still throw'
  );
  console.log('PASS  testUnrelatedErrorStillThrows');
}

async function run_all() {
  const tests = [testParallelDisconnectSwallowsRace, testUnrelatedErrorStillThrows];
  let failed = 0;
  for (const t of tests) {
    try { await t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  // Clean up our mock file.
  try { require('fs').unlinkSync(mockPath); } catch (_) {}
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run_all();
