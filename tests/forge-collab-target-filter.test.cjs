// tests/forge-collab-target-filter.test.cjs
//
// T022 (spec-collab-fix R004): transport-layer target filtering.
//
// Every transport backend (memory, polling, ably) must drop a message
// whose `data.target` is set but does not match the subscriber's clientId
// BEFORE invoking the subscriber callback. Broadcast messages (no target)
// still fan out to every subscriber.
//
// Four suites below, one per backend + one for the broadcast contract.
// The ably suite monkey-patches Module._load so the ably peer dep is not
// required to be installed.

const Module = require('node:module');
const { suite, test, assert, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const {
  createMemoryTransport,
  createMemoryBus,
  createPollingTransport,
  createAblyTransport
} = collab;
const { _targetAllowsDelivery } = collab._internal;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// Build a minimal Ably mock matching the subset of the SDK the transport
// uses: Realtime({ key, clientId }) -> { connection.once, channels.get, close }.
// Channel: publish(event, data), subscribe(event, listener). listener
// receives { name, data, clientId }. Channels are shared across clients by
// channel name via a shared registry.
function makeAblyMock() {
  const channelsByName = new Map();
  function getChannel(name) {
    let ch = channelsByName.get(name);
    if (ch) return ch;
    const listeners = []; // { event, fn, fromClientId }
    ch = {
      _listeners: listeners,
      publish(event, data, _fromClientId) {
        // The mock's publish takes an internal 3rd arg so we can stamp the
        // originating clientId onto the envelope. The transport normally
        // omits it — it's set via the Realtime client attaching clientId.
        const fromClientId = _fromClientId || ch._lastPublisher;
        for (const l of listeners) {
          if (l.event !== event) continue;
          try { l.fn({ name: event, data, clientId: fromClientId }); } catch (_) {}
        }
      },
      subscribe(event, fn) {
        listeners.push({ event, fn });
      }
    };
    channelsByName.set(name, ch);
    return ch;
  }
  class Realtime {
    constructor(opts) {
      this._clientId = opts.clientId;
      this.connection = {
        once(ev, cb) {
          if (ev === 'connected') setImmediate(cb);
        }
      };
      this.channels = {
        get: (name) => {
          const ch = getChannel(name);
          // Wrap publish so every message carries the connecting clientId.
          const originalPublish = ch.publish.bind(ch);
          return {
            publish: (event, data) => originalPublish(event, data, this._clientId),
            subscribe: (event, fn) => ch.subscribe(event, fn),
            _listeners: ch._listeners
          };
        }
      };
    }
    close() { /* no-op */ }
  }
  return { Realtime };
}

// Install a require() interceptor so require('ably') resolves to our mock.
// Returns a restore function the caller MUST invoke in a finally block.
function installAblyMock(mock) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'ably') return mock;
    return origLoad.call(this, request, parent, isMain);
  };
  return function restore() { Module._load = origLoad; };
}

// ---------------------------------------------------------------------------
// _targetAllowsDelivery unit
// ---------------------------------------------------------------------------

suite('_targetAllowsDelivery (R004 predicate)', () => {
  test('broadcast (no target) -> delivers to every subscriber', () => {
    assert.strictEqual(_targetAllowsDelivery({}, 'alice'), true);
    assert.strictEqual(_targetAllowsDelivery({ foo: 1 }, 'bob'), true);
    assert.strictEqual(_targetAllowsDelivery(undefined, 'carol'), true);
    assert.strictEqual(_targetAllowsDelivery(null, 'dave'), true);
  });
  test('target set -> delivers only to matching clientId', () => {
    assert.strictEqual(_targetAllowsDelivery({ target: 'daniel' }, 'daniel'), true);
    assert.strictEqual(_targetAllowsDelivery({ target: 'daniel' }, 'lucas'), false);
  });
  test('explicit null target -> broadcast', () => {
    assert.strictEqual(_targetAllowsDelivery({ target: null }, 'anyone'), true);
  });
});

// ---------------------------------------------------------------------------
// Memory transport
// ---------------------------------------------------------------------------

suite('memory transport target filter (R004)', () => {
  test('sendTargeted to middle of 3 subscribers fires exactly one cb', async () => {
    const bus = createMemoryBus();
    const tAlice  = createMemoryTransport({ bus, clientId: 'alice' });
    const tDaniel = createMemoryTransport({ bus, clientId: 'daniel' });
    const tLucas  = createMemoryTransport({ bus, clientId: 'lucas' });
    const aliceMsgs = [];
    const danMsgs = [];
    const lucMsgs = [];
    tAlice.subscribe('flag-ping',  m => aliceMsgs.push(m));
    tDaniel.subscribe('flag-ping', m => danMsgs.push(m));
    tLucas.subscribe('flag-ping',  m => lucMsgs.push(m));

    await tAlice.sendTargeted('daniel', 'flag-ping', { flag: 'F001' });

    assert.strictEqual(danMsgs.length, 1, 'target subscriber fires once');
    assert.strictEqual(danMsgs[0].data.target, 'daniel');
    assert.strictEqual(danMsgs[0].data.flag, 'F001');
    assert.strictEqual(aliceMsgs.length, 0, 'non-target alice fires zero');
    assert.strictEqual(lucMsgs.length, 0, 'non-target lucas fires zero');
  });

  test('broadcast publish with no target fires all 3 cbs', async () => {
    const bus = createMemoryBus();
    const tAlice  = createMemoryTransport({ bus, clientId: 'alice' });
    const tDaniel = createMemoryTransport({ bus, clientId: 'daniel' });
    const tLucas  = createMemoryTransport({ bus, clientId: 'lucas' });
    const seen = { alice: 0, daniel: 0, lucas: 0 };
    tAlice.subscribe('broadcast-ev',  () => { seen.alice++; });
    tDaniel.subscribe('broadcast-ev', () => { seen.daniel++; });
    tLucas.subscribe('broadcast-ev',  () => { seen.lucas++; });

    await tAlice.publish('broadcast-ev', { msg: 'hello' });

    assert.strictEqual(seen.alice, 1);
    assert.strictEqual(seen.daniel, 1);
    assert.strictEqual(seen.lucas, 1);
  });

  test('subscribe opts.clientId overrides factory clientId for filter', async () => {
    // A single transport instance can multiplex two logical subscribers by
    // passing `clientId` in subscribe opts. Useful for test harnesses.
    const bus = createMemoryBus();
    const tPublisher = createMemoryTransport({ bus, clientId: 'publisher' });
    const tSubscriber = createMemoryTransport({ bus, clientId: 'default' });
    const aliceHits = [];
    const bobHits = [];
    tSubscriber.subscribe('ev', m => aliceHits.push(m), { clientId: 'alice' });
    tSubscriber.subscribe('ev', m => bobHits.push(m),   { clientId: 'bob' });

    await tPublisher.sendTargeted('alice', 'ev', {});

    assert.strictEqual(aliceHits.length, 1);
    assert.strictEqual(bobHits.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Polling transport
// ---------------------------------------------------------------------------

suite('polling transport target filter (R004)', () => {
  test('sendTargeted to middle of 3 subscribers fires exactly one cb', async () => {
    const io = _stubIo();
    const tAlice  = createPollingTransport({ ioAdapter: io, clientId: 'alice',  intervalMs: 60_000 });
    const tDaniel = createPollingTransport({ ioAdapter: io, clientId: 'daniel', intervalMs: 60_000 });
    const tLucas  = createPollingTransport({ ioAdapter: io, clientId: 'lucas',  intervalMs: 60_000 });
    await tAlice.connect(); await tDaniel.connect(); await tLucas.connect();

    const aliceMsgs = [];
    const danMsgs = [];
    const lucMsgs = [];
    tAlice.subscribe('flag-ping',  m => aliceMsgs.push(m));
    tDaniel.subscribe('flag-ping', m => danMsgs.push(m));
    tLucas.subscribe('flag-ping',  m => lucMsgs.push(m));

    await tAlice.sendTargeted('daniel', 'flag-ping', { flag: 'F001' });
    // Each transport refreshes independently — the target filter runs at
    // each subscriber's _refresh() so non-target cbs stay silent.
    await tAlice._internal._refresh();
    await tDaniel._internal._refresh();
    await tLucas._internal._refresh();

    assert.strictEqual(danMsgs.length, 1, 'target daniel fires once');
    assert.strictEqual(danMsgs[0].data.flag, 'F001');
    assert.strictEqual(aliceMsgs.length, 0, 'alice (sender) non-target stays zero');
    assert.strictEqual(lucMsgs.length, 0, 'lucas non-target stays zero');

    await tAlice.disconnect(); await tDaniel.disconnect(); await tLucas.disconnect();
  });

  test('broadcast publish fires all 3 subscribers', async () => {
    const io = _stubIo();
    const tAlice  = createPollingTransport({ ioAdapter: io, clientId: 'alice',  intervalMs: 60_000 });
    const tDaniel = createPollingTransport({ ioAdapter: io, clientId: 'daniel', intervalMs: 60_000 });
    const tLucas  = createPollingTransport({ ioAdapter: io, clientId: 'lucas',  intervalMs: 60_000 });
    await tAlice.connect(); await tDaniel.connect(); await tLucas.connect();

    const seen = { alice: 0, daniel: 0, lucas: 0 };
    tAlice.subscribe('lock-claim',  () => { seen.alice++; });
    tDaniel.subscribe('lock-claim', () => { seen.daniel++; });
    tLucas.subscribe('lock-claim',  () => { seen.lucas++; });

    await tAlice.publish('lock-claim', { task: 'T999' });
    await tAlice._internal._refresh();
    await tDaniel._internal._refresh();
    await tLucas._internal._refresh();

    assert.strictEqual(seen.alice, 1);
    assert.strictEqual(seen.daniel, 1);
    assert.strictEqual(seen.lucas, 1);

    await tAlice.disconnect(); await tDaniel.disconnect(); await tLucas.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Ably transport (mocked peer dep)
// ---------------------------------------------------------------------------

suite('ably transport target filter (R004)', () => {
  test('sendTargeted to middle of 3 subscribers fires exactly one cb', async () => {
    const restore = installAblyMock(makeAblyMock());
    try {
      const tAlice  = createAblyTransport({ apiKey: 'test', clientId: 'alice',  channel: 'forge-test' });
      const tDaniel = createAblyTransport({ apiKey: 'test', clientId: 'daniel', channel: 'forge-test' });
      const tLucas  = createAblyTransport({ apiKey: 'test', clientId: 'lucas',  channel: 'forge-test' });
      await tAlice.connect(); await tDaniel.connect(); await tLucas.connect();

      const aliceMsgs = [];
      const danMsgs = [];
      const lucMsgs = [];
      tAlice.subscribe('flag-ping',  m => aliceMsgs.push(m));
      tDaniel.subscribe('flag-ping', m => danMsgs.push(m));
      tLucas.subscribe('flag-ping',  m => lucMsgs.push(m));

      await tAlice.sendTargeted('daniel', 'flag-ping', { flag: 'F001' });

      assert.strictEqual(danMsgs.length, 1, 'target daniel fires once');
      assert.strictEqual(danMsgs[0].data.flag, 'F001');
      assert.strictEqual(aliceMsgs.length, 0, 'non-target alice stays zero');
      assert.strictEqual(lucMsgs.length, 0, 'non-target lucas stays zero');

      await tAlice.disconnect(); await tDaniel.disconnect(); await tLucas.disconnect();
    } finally {
      restore();
    }
  });

  test('broadcast publish fires all 3 subscribers', async () => {
    const restore = installAblyMock(makeAblyMock());
    try {
      const tAlice  = createAblyTransport({ apiKey: 'test', clientId: 'alice',  channel: 'forge-broadcast' });
      const tDaniel = createAblyTransport({ apiKey: 'test', clientId: 'daniel', channel: 'forge-broadcast' });
      const tLucas  = createAblyTransport({ apiKey: 'test', clientId: 'lucas',  channel: 'forge-broadcast' });
      await tAlice.connect(); await tDaniel.connect(); await tLucas.connect();

      const seen = { alice: 0, daniel: 0, lucas: 0 };
      tAlice.subscribe('hello',  () => { seen.alice++; });
      tDaniel.subscribe('hello', () => { seen.daniel++; });
      tLucas.subscribe('hello',  () => { seen.lucas++; });

      await tAlice.publish('hello', { msg: 'world' });

      assert.strictEqual(seen.alice, 1);
      assert.strictEqual(seen.daniel, 1);
      assert.strictEqual(seen.lucas, 1);

      await tAlice.disconnect(); await tDaniel.disconnect(); await tLucas.disconnect();
    } finally {
      restore();
    }
  });
});

runTests();
