// scripts/forge-dev-server.cjs
//
// T016 / R010 -- Sandbox-aware execution with dev-server lifecycle.
//
// Public API:
//   startDevServer(forgeDir, opts)
//       Reads .forge/config.json for `sandbox.dev_server` (command string),
//       `sandbox.wait_url` (URL polled until 200), and
//       `sandbox.wait_timeout_ms` (default 15000). Spawns the command as a
//       detached background process. Polls the wait URL until it returns
//       HTTP 200 OR the timeout elapses.
//       Returns { pid, state: "ready" | "timeout" | "missing_config" }.
//
//   stopDevServer(pid, opts)
//       Sends SIGTERM, waits up to 5 s (`grace_ms`), then escalates to
//       SIGKILL if the process is still alive. On Windows falls back to
//       `taskkill /PID <pid> /T /F` to reap the whole tree (detached
//       processes spawned via a shell don't receive signals cleanly).
//       Returns { killed: boolean, signal: "SIGTERM"|"SIGKILL"|"taskkill"|null }.
//
// Design notes:
//   - No external dependencies. Uses node's built-in `http` client to probe
//     the wait URL so integration tests can spin up a plain http.Server.
//   - `spawn(..., { detached: true, stdio: 'ignore' })` + `child.unref()`
//     so the parent (this node process) can exit without blocking on the
//     dev server.
//   - Cross-platform kill: on win32 we shell out to `taskkill /PID /T /F`
//     because `process.kill(pid, 'SIGTERM')` does not tear down child
//     shells spawned with `shell: true`. On POSIX we use the normal
//     SIGTERM -> grace window -> SIGKILL pattern.
//   - `missing_config` is returned without spawning anything so specs can
//     safely ask for the dev server even when the user hasn't configured
//     one.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');

const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_GRACE_MS = 5000;

function _loadSandboxConfig(forgeDir) {
  const configPath = path.join(forgeDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    return null;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const sandbox = cfg && cfg.sandbox;
  if (!sandbox || typeof sandbox.dev_server !== 'string' || !sandbox.dev_server.trim()) {
    return null;
  }
  return {
    dev_server: sandbox.dev_server,
    wait_url: typeof sandbox.wait_url === 'string' ? sandbox.wait_url : null,
    wait_timeout_ms: typeof sandbox.wait_timeout_ms === 'number'
      ? sandbox.wait_timeout_ms
      : DEFAULT_WAIT_TIMEOUT_MS,
    cwd: typeof sandbox.cwd === 'string' ? sandbox.cwd : null,
  };
}

// Probe a URL once. Resolves with statusCode on any response, rejects on
// socket error. Honors a short per-request timeout so polling doesn't stall.
function _probeOnce(rawUrl, perRequestTimeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(rawUrl, (res) => {
      res.resume(); // drain
      resolve(res.statusCode || 0);
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(perRequestTimeoutMs, () => {
      req.destroy(new Error('probe_timeout'));
    });
  });
}

async function _waitForReady(url, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(100, deadline - Date.now());
      const perReq = Math.min(intervalMs, remaining);
      const status = await _probeOnce(url, perReq);
      if (status === 200) return true;
    } catch (e) {
      // connection refused / dns / socket timeout -- keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return false;
}

// Spawn the dev-server command. On Windows we use `shell: true` so a bare
// `bun dev --port 5174` string resolves through cmd.exe; on POSIX we also
// use shell:true for parity so users can embed env-var expansion and
// semicolons if they need to.
function _spawnDevServer(command, cwd) {
  const opts = {
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
    shell: true,
  };
  // Windows: detached + shell still lets taskkill /T reap the child tree.
  // POSIX: detached: true puts the child in its own process group so we
  // can signal the group (negative pid) if needed; we don't currently
  // rely on that but it keeps kill semantics clean.
  const child = spawn(command, [], opts);
  try { child.unref(); } catch (e) { /* best effort */ }
  return child;
}

async function startDevServer(forgeDir, opts) {
  const options = opts || {};
  const cfg = _loadSandboxConfig(forgeDir);
  if (!cfg) {
    return { pid: null, state: 'missing_config' };
  }
  const waitUrl = options.waitUrlOverride || cfg.wait_url;
  const timeoutMs = typeof options.waitTimeoutMsOverride === 'number'
    ? options.waitTimeoutMsOverride
    : cfg.wait_timeout_ms;
  const intervalMs = typeof options.pollIntervalMs === 'number'
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;

  const child = _spawnDevServer(cfg.dev_server, options.cwd || cfg.cwd);
  const pid = child.pid;

  if (!waitUrl) {
    // No probe URL -- treat as ready after spawn. The executor shouldn't
    // declare victory, but we also shouldn't hang on a missing probe.
    return { pid, state: 'ready' };
  }

  const ready = await _waitForReady(waitUrl, timeoutMs, intervalMs);
  return { pid, state: ready ? 'ready' : 'timeout' };
}

function _pidAlive(pid) {
  try {
    // Signal 0 is a liveness probe on POSIX and (node-emulated) on Windows.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function _taskkill(pid) {
  // Try plain PATH lookup first (real user environments almost always
  // have System32 on PATH). Fall back to the well-known absolute path so
  // sandboxed test runners with a trimmed PATH still reap the tree.
  const candidates = ['taskkill'];
  const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  candidates.push(path.join(sysRoot, 'System32', 'taskkill.exe'));
  candidates.push('C:\\Windows\\System32\\taskkill.exe');
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['/PID', String(pid), '/T', '/F'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch (e) {
      // Try the next candidate.
    }
  }
  return false;
}

async function stopDevServer(pid, opts) {
  const options = opts || {};
  const graceMs = typeof options.graceMs === 'number' ? options.graceMs : DEFAULT_GRACE_MS;
  const platform = options.platformOverride || process.platform;

  if (pid == null || !_pidAlive(pid)) {
    return { killed: false, signal: null };
  }

  if (platform === 'win32') {
    // Windows: SIGTERM is emulated and does not reach the full process tree
    // of a `shell: true` detached child. Go straight to taskkill which
    // also handles child processes (/T) and forces (/F).
    const ok = _taskkill(pid);
    // Give the OS a beat to reap.
    await new Promise((r) => setTimeout(r, 100));
    return { killed: ok || !_pidAlive(pid), signal: 'taskkill' };
  }

  // POSIX: SIGTERM, wait up to graceMs, escalate to SIGKILL.
  try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!_pidAlive(pid)) {
      return { killed: true, signal: 'SIGTERM' };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (_pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    await new Promise((r) => setTimeout(r, 100));
    return { killed: !_pidAlive(pid), signal: 'SIGKILL' };
  }
  return { killed: true, signal: 'SIGTERM' };
}

// Sandbox affordance probes for capabilities discovery (R010 AC3). Each
// probe runs with a hard 1 s ceiling so discover never blocks. The
// function is synchronous because discoverCapabilities is synchronous.
function probeSandbox(caps, opts) {
  const options = opts || {};
  const timeoutMs = typeof options.networkTimeoutMs === 'number' ? options.networkTimeoutMs : 1000;
  const result = {
    browser: false,
    spawn: false,
    network: false,
  };

  // browser: true iff Playwright MCP server is registered in capabilities.
  try {
    if (caps && caps.mcp_servers) {
      const names = Object.keys(caps.mcp_servers);
      result.browser = names.some((n) => /playwright/i.test(n));
    }
  } catch (e) { /* best effort */ }

  // spawn: true iff child_process module exposes spawn.
  try {
    const cp = require('node:child_process');
    result.spawn = typeof cp.spawn === 'function';
  } catch (e) {
    result.spawn = false;
  }

  // network: delegate to a tiny subprocess that does the actual socket
  // probe. Keeps this function synchronous and bounded by its timeout
  // without having to spin the main event loop. The child connects to
  // 127.0.0.1:1 (no listener expected) -- we count ECONNREFUSED or any
  // connected event as "network up" because the loopback stack is
  // working. Only a dead/missing network stack would hang past the
  // timeout.
  if (options.networkOverride === true) {
    result.network = true;
  } else if (options.networkOverride === false) {
    result.network = false;
  } else {
    try {
      const probeSrc = `
        const net = require('node:net');
        const s = net.createConnection({ host: '127.0.0.1', port: 1 });
        const done = (ok) => { process.stdout.write(ok ? '1' : '0'); process.exit(0); };
        s.on('connect', () => done(true));
        s.on('error', (e) => done(e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EADDRNOTAVAIL')));
        setTimeout(() => done(false), ${Math.max(50, timeoutMs - 50)});
      `;
      const out = execFileSync(process.execPath, ['-e', probeSrc], {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      result.network = out === '1';
    } catch (e) {
      result.network = false;
    }
  }

  return result;
}

module.exports = {
  startDevServer,
  stopDevServer,
  probeSandbox,
  // Exposed for tests:
  _loadSandboxConfig,
  _probeOnce,
  _waitForReady,
  _pidAlive,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_GRACE_MS,
};
