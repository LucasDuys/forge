// tests/dev-server-lifecycle.test.cjs -- T016 / R010
//
// Covers the sandbox-aware dev-server lifecycle:
//   1. startDevServer with valid config + a live mock returns state=ready
//   2. wait_url unreachable -> state=timeout after wait_timeout_ms
//   3. missing sandbox.dev_server -> state=missing_config, nothing spawned
//   4. stopDevServer sends SIGTERM, waits grace, cleans up
//   5. Cross-platform kill: Windows uses taskkill, Unix uses SIGTERM
//   6. Integration: spin a real node http server, probe, stop -- no orphans
//   7. discoverCapabilities writes caps.sandbox with {browser,spawn,network}
//   8. setup-state --record-baselines lands record_baselines:true in state
//
// No external deps: the "dev server" is a plain node http.Server script.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const devServer = require('../scripts/forge-dev-server.cjs');
const { startDevServer, stopDevServer, probeSandbox, _loadSandboxConfig, _waitForReady, _pidAlive } = devServer;

// --- helpers --------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function writeConfig(forgeDir, sandbox) {
  const cfg = { sandbox };
  fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify(cfg, null, 2));
}

function writeNoSandboxConfig(forgeDir) {
  fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({}, null, 2));
}

// A tiny dev-server stub that listens on the given port. We keep the path
// absolute so `node <script>` from any cwd works.
function makeStubServerScript(dir, port, label) {
  const script = `
    const http = require('node:http');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(${JSON.stringify(label || 'ok')});
    });
    srv.listen(${port}, '127.0.0.1');
  `;
  const p = path.join(dir, `stub-server-${port}.js`);
  fs.writeFileSync(p, script);
  return p;
}

// Wait for the stub to stop responding. Used to confirm stopDevServer
// actually took the server down. Returns true if the port went quiet
// within the deadline.
async function waitForShutdown(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(200, () => { try { req.destroy(); } catch (e) {} resolve(false); });
    });
    if (!alive) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// --- 1. start returns ready when mock URL responds 200 -------------------

suite('startDevServer', () => {
  test('returns ready when wait_url responds 200', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const port = await getFreePort();
    const stub = makeStubServerScript(forgeDir, port, 'stub-ready');
    writeConfig(forgeDir, {
      dev_server: `"${process.execPath}" "${stub}"`,
      wait_url: `http://127.0.0.1:${port}`,
      wait_timeout_ms: 5000,
    });

    const res = await startDevServer(forgeDir, { pollIntervalMs: 100 });
    assert.strictEqual(res.state, 'ready', `expected ready, got ${res.state}`);
    assert.ok(typeof res.pid === 'number' && res.pid > 0, 'pid present');

    // Cleanup so we don't leak a dev server.
    await stopDevServer(res.pid, { graceMs: 1000 });
  });

  test('returns timeout when wait_url is unreachable', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    // Pick a port we are NOT listening on.
    const deadPort = await getFreePort();
    // Command that does nothing so nothing binds to the port.
    // On Windows the node interpreter path may contain spaces; quote it.
    const idleScript = path.join(forgeDir, 'idle.js');
    fs.writeFileSync(idleScript, 'setInterval(() => {}, 1000);');

    writeConfig(forgeDir, {
      dev_server: `"${process.execPath}" "${idleScript}"`,
      wait_url: `http://127.0.0.1:${deadPort}`,
      wait_timeout_ms: 600,  // short so the test stays fast
    });

    const t0 = Date.now();
    const res = await startDevServer(forgeDir, { pollIntervalMs: 100 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.state, 'timeout', `expected timeout, got ${res.state}`);
    assert.ok(typeof res.pid === 'number' && res.pid > 0, 'pid present even on timeout');
    assert.ok(elapsed >= 500, `elapsed ${elapsed}ms should be >= wait_timeout_ms`);
    assert.ok(elapsed < 3000, `elapsed ${elapsed}ms should be bounded`);

    await stopDevServer(res.pid, { graceMs: 1000 });
  });

  test('returns missing_config when sandbox.dev_server is absent', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    writeNoSandboxConfig(forgeDir);
    const res = await startDevServer(forgeDir, {});
    assert.strictEqual(res.state, 'missing_config');
    assert.strictEqual(res.pid, null);
  });

  test('returns missing_config when sandbox exists but dev_server is empty', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({ sandbox: { dev_server: '  ' } }));
    const res = await startDevServer(forgeDir, {});
    assert.strictEqual(res.state, 'missing_config');
  });

  test('loadSandboxConfig respects default wait_timeout_ms=15000', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    writeConfig(forgeDir, { dev_server: 'echo noop', wait_url: 'http://x' });
    const cfg = _loadSandboxConfig(forgeDir);
    assert.strictEqual(cfg.wait_timeout_ms, 15000);
  });
});

// --- 2. stopDevServer behavior -------------------------------------------

suite('stopDevServer', () => {
  test('sends SIGTERM/taskkill and brings the process down', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const port = await getFreePort();
    const stub = makeStubServerScript(forgeDir, port, 'will-stop');
    writeConfig(forgeDir, {
      dev_server: `"${process.execPath}" "${stub}"`,
      wait_url: `http://127.0.0.1:${port}`,
      wait_timeout_ms: 5000,
    });

    const started = await startDevServer(forgeDir, { pollIntervalMs: 100 });
    assert.strictEqual(started.state, 'ready');
    const pid = started.pid;

    const res = await stopDevServer(pid, { graceMs: 2000 });
    assert.strictEqual(res.killed, true, 'process should be killed');
    // Signal can legitimately be SIGTERM, SIGKILL, or taskkill depending on OS.
    assert.ok(
      ['SIGTERM', 'SIGKILL', 'taskkill'].includes(res.signal),
      `unexpected signal: ${res.signal}`
    );

    // The port should stop answering within a short window.
    const down = await waitForShutdown(port, 3000);
    assert.ok(down, 'dev server should stop responding after stop');
  });

  test('is a no-op when pid does not exist', async () => {
    // Pick a pid that almost certainly does not exist. PID 1 may be init.
    // Use a large pid instead.
    const res = await stopDevServer(999999999, { graceMs: 100 });
    assert.strictEqual(res.killed, false);
    assert.strictEqual(res.signal, null);
  });

  test('returns {killed:false, signal:null} for null pid', async () => {
    const res = await stopDevServer(null, {});
    assert.strictEqual(res.killed, false);
    assert.strictEqual(res.signal, null);
  });

  test('Windows branch uses taskkill signal label (platformOverride)', async () => {
    // We can't actually run taskkill on non-Windows runners, so we only
    // assert the pid-not-alive short-circuit returns null. On Windows the
    // signal label "taskkill" is exercised in the stop-after-start test
    // above.
    if (process.platform === 'win32') {
      const { forgeDir } = makeTempForgeDir({ config: {} });
      const port = await getFreePort();
      const stub = makeStubServerScript(forgeDir, port, 'win-stop');
      writeConfig(forgeDir, {
        dev_server: `"${process.execPath}" "${stub}"`,
        wait_url: `http://127.0.0.1:${port}`,
        wait_timeout_ms: 5000,
      });
      const started = await startDevServer(forgeDir, { pollIntervalMs: 100 });
      const res = await stopDevServer(started.pid, { graceMs: 2000 });
      assert.strictEqual(res.signal, 'taskkill');
    } else {
      // POSIX branch: we just ensure the platformOverride code path does
      // not crash when pid is missing.
      const res = await stopDevServer(null, { platformOverride: 'win32' });
      assert.strictEqual(res.killed, false);
    }
  });
});

// --- 3. Integration: real node server round-trip -------------------------

suite('dev-server integration', () => {
  test('start + probe + stop leaves no orphan', async () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const port = await getFreePort();
    const stub = makeStubServerScript(forgeDir, port, 'round-trip');
    writeConfig(forgeDir, {
      dev_server: `"${process.execPath}" "${stub}"`,
      wait_url: `http://127.0.0.1:${port}`,
      wait_timeout_ms: 5000,
    });

    const started = await startDevServer(forgeDir, { pollIntervalMs: 100 });
    assert.strictEqual(started.state, 'ready');

    // Confirm we actually get content from the stub.
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        let chunks = '';
        res.on('data', (d) => chunks += d.toString());
        res.on('end', () => resolve(chunks));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { try { req.destroy(); } catch (e) {} reject(new Error('req timeout')); });
    });
    assert.strictEqual(body, 'round-trip');

    // Now stop and confirm the port is free.
    await stopDevServer(started.pid, { graceMs: 2000 });
    const down = await waitForShutdown(port, 3000);
    assert.ok(down, 'port should be free after stop');

    // Port rebind sanity check: if the OS really released it, we should
    // be able to listen again.
    await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve());
      });
    });
  });
});

// --- 4. discoverCapabilities includes sandbox section --------------------

suite('capabilities sandbox section', () => {
  test('discoverCapabilities writes caps.sandbox with browser/spawn/network', () => {
    const { projectDir } = makeTempForgeDir({ config: {} });
    // Empty home override so discover doesn't wander the real ~/.claude.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sandbox-home-'));
    try {
      const caps = tools.discoverCapabilities(projectDir, null, {
        homeOverride: fakeHome,
        skillRoots: [],
        pluginCache: null,
      });
      assert.ok(caps.sandbox, 'caps.sandbox present');
      assert.strictEqual(typeof caps.sandbox.browser, 'boolean');
      assert.strictEqual(typeof caps.sandbox.spawn, 'boolean');
      assert.strictEqual(typeof caps.sandbox.network, 'boolean');
      // spawn must always be true in node.
      assert.strictEqual(caps.sandbox.spawn, true, 'spawn should be usable in node');
    } finally {
      try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('probeSandbox browser=true when playwright MCP registered', () => {
    const caps = { mcp_servers: { playwright: { command: 'npx' } } };
    const res = probeSandbox(caps, { networkOverride: true });
    assert.strictEqual(res.browser, true);
    assert.strictEqual(res.spawn, true);
    assert.strictEqual(res.network, true);
  });

  test('probeSandbox browser=false when playwright absent', () => {
    const caps = { mcp_servers: { context7: { command: 'npx' } } };
    const res = probeSandbox(caps, { networkOverride: true });
    assert.strictEqual(res.browser, false);
  });

  test('probeSandbox network=false when override disables it', () => {
    const res = probeSandbox({ mcp_servers: {} }, { networkOverride: false });
    assert.strictEqual(res.network, false);
  });
});

// --- 5. setup-state --record-baselines stamps state.md -------------------

suite('setup-state record_baselines', () => {
  test('--record-baselines lands record_baselines:true in state.md', () => {
    const { projectDir, forgeDir } = makeTempForgeDir({ config: {} });
    // Seed a minimal spec + frontier so the workflow validator is happy.
    const specsDir = path.join(forgeDir, 'specs');
    const plansDir = path.join(forgeDir, 'plans');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'spec-demo.md'),
      '---\nname: demo\nstatus: approved\n---\n\n# demo spec\n');
    fs.writeFileSync(path.join(plansDir, 'demo-frontier.md'),
      '---\nspec: demo\n---\n\n- [T001] one | est: ~1k tokens | maps: R001\n');

    const toolsPath = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');
    const env = Object.assign({}, process.env);
    execFileSync(process.execPath, [
      toolsPath, 'setup-state',
      '--forge-dir', forgeDir,
      '--spec', 'demo',
      '--autonomy', 'gated',
      '--depth', 'standard',
      '--max-iterations', '5',
      '--token-budget', '1000',
      '--completion-promise', 'FORGE_COMPLETE',
      '--record-baselines',
    ], { env, cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });

    const state = tools.readState(forgeDir);
    assert.strictEqual(state.data.record_baselines, true, 'record_baselines flag present');
  });

  test('setup-state without --record-baselines does NOT set the flag', () => {
    const { projectDir, forgeDir } = makeTempForgeDir({ config: {} });
    const specsDir = path.join(forgeDir, 'specs');
    const plansDir = path.join(forgeDir, 'plans');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'spec-demo.md'),
      '---\nname: demo\nstatus: approved\n---\n\n# demo spec\n');
    fs.writeFileSync(path.join(plansDir, 'demo-frontier.md'),
      '---\nspec: demo\n---\n\n- [T001] one | est: ~1k tokens | maps: R001\n');

    const toolsPath = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');
    execFileSync(process.execPath, [
      toolsPath, 'setup-state',
      '--forge-dir', forgeDir,
      '--spec', 'demo',
      '--autonomy', 'gated',
      '--depth', 'standard',
      '--max-iterations', '5',
      '--token-budget', '1000',
      '--completion-promise', 'FORGE_COMPLETE',
    ], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });

    const state = tools.readState(forgeDir);
    assert.ok(state.data.record_baselines === undefined || state.data.record_baselines === false,
      'record_baselines flag should be absent');
  });
});

// --- 6. CLI dev-server subcommand ----------------------------------------

suite('dev-server CLI', () => {
  test('dev-server --action start with missing sandbox returns missing_config', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    writeNoSandboxConfig(forgeDir);
    const toolsPath = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');
    const out = execFileSync(process.execPath, [
      toolsPath, 'dev-server',
      '--forge-dir', forgeDir,
      '--action', 'start',
    ], { encoding: 'utf8', timeout: 5000 });
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.state, 'missing_config');
    assert.strictEqual(parsed.pid, null);
  });
});

runTests();
