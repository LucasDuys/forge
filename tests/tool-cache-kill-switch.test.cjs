// tests/tool-cache-kill-switch.test.cjs
//
// Wave 2 R006 / T007 -- end-to-end FORGE_TOKEN_OPT=0 parity contract.
//
// Each prior wave-2 task (T002, T003, T004, T005, T006) added its own
// FORGE_TOKEN_OPT guard. This file is the master rollback contract:
// with FORGE_TOKEN_OPT=0, the entire wave-2 cache stack must revert to
// byte-for-byte v1 behavior. We verify the contract end-to-end by spawning
// the actual hook processes and inspecting cache files, cache-stats logs,
// and aggregator output.
//
// Coverage map (R006.AC1..AC4):
//   AC1: Only original 6 v1 patterns match under env=0.
//   AC2: TTL is flat 120s under env=0 (no per-class tiering).
//   AC3: No mtime keying (Read), no HEAD pinning (Bash), no stats log writes.
//   AC4: Default-on bias -- env unset, env="", env="1", env="true" all
//        leave wave-2 ON. The guard checks `=== "0"` strictly, not falsy.
//
// Snapshot fixture: tests/fixtures/tool-cache-v1-snapshot.json documents
// the parity contract characteristics; this file enforces them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');

// Clear inherited FORGE_TOKEN_OPT before requiring the module under test
// so default-on tests get the unset baseline.
const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const cacheMod = require('../hooks/tool-cache.js');
const storeMod = require('../hooks/tool-cache-store.js');
const headCache = require('../scripts/forge-head-cache.cjs');
const forgeTools = require('../scripts/forge-tools.cjs');

const {
  isCacheableCommand,
  hashInput,
  DEFAULT_TTL_MS,
  V1_CACHEABLE_COMMANDS,
} = cacheMod;

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

// --- Snapshot fixture loader -----------------------------------------------

const SNAPSHOT_PATH = path.join(__dirname, 'fixtures', 'tool-cache-v1-snapshot.json');
function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

// --- Test fixtures ----------------------------------------------------------

const _tempDirs = [];
function makeTempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-killswitch-'));
  _tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of _tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeProjectWithForgeDir(prefix) {
  const dir = makeTempDir(prefix || 'forge-killswitch-proj-');
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  return dir;
}

function withGitRepo(prefix, fn) {
  if (!gitAvailable()) return null;
  const repo = makeTempDir(prefix || 'forge-killswitch-repo-');
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 'Forge Test',
    GIT_AUTHOR_EMAIL: 'test@forge.local',
    GIT_COMMITTER_NAME: 'Forge Test',
    GIT_COMMITTER_EMAIL: 'test@forge.local',
  });
  function git(args) {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || '').trim());
    }
    return (r.stdout || '').trim();
  }
  git(['init', '-q']);
  git(['config', 'user.email', 'test@forge.local']);
  git(['config', 'user.name', 'Forge Test']);
  git(['commit', '--allow-empty', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.forge'), { recursive: true });
  const headSha = git(['rev-parse', 'HEAD']);
  return fn(repo, headSha, git);
}

function spawnPreHook(payload, env, cwd) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'tool-cache.js');
  // Strip inherited FORGE_TOKEN_OPT before merging caller's env so each test
  // gets the exact env it asked for.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign(baseEnv, env || {}),
  });
}

function spawnPostHook(payload, env, cwd) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'tool-cache-store.js');
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign(baseEnv, env || {}),
  });
}

function freshSession(label) {
  return label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function cacheDirFor(sessionId) {
  return path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
}

function listCacheFiles(sessionId) {
  const dir = cacheDirFor(sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
}

function rmCacheDir(sessionId) {
  const dir = cacheDirFor(sessionId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function readEvents(workdir) {
  const log = path.join(workdir, '.forge', 'cache-stats.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

// --- Snapshot validation ----------------------------------------------------

suite('R006 v1 parity snapshot fixture', () => {
  test('fixture file exists and is well-formed', () => {
    const snap = loadSnapshot();
    assert.strictEqual(snap.version, 'v1');
    assert.ok(Array.isArray(snap.characteristics.cacheable_patterns));
    assert.strictEqual(snap.characteristics.flat_ttl_ms, 120000);
    assert.strictEqual(snap.characteristics.no_mtime_keying, true);
    assert.strictEqual(snap.characteristics.no_head_pinning, true);
    assert.strictEqual(snap.characteristics.no_stats_log, true);
  });

  test('fixture flat_ttl_ms matches DEFAULT_TTL_MS in tool-cache.js', () => {
    const snap = loadSnapshot();
    assert.strictEqual(snap.characteristics.flat_ttl_ms, DEFAULT_TTL_MS);
  });

  test('fixture cacheable_patterns count matches V1_CACHEABLE_COMMANDS length', () => {
    const snap = loadSnapshot();
    assert.strictEqual(
      snap.characteristics.cacheable_patterns.length,
      V1_CACHEABLE_COMMANDS.length,
      'fixture must enumerate exactly the v1 patterns'
    );
  });
});

// --- AC1: only v1 patterns match under env=0 -------------------------------

suite('R006.AC1 kill-switch -- only v1 patterns match', () => {
  test('isCacheableCommand under killSwitchOff=true accepts v1 patterns', () => {
    const v1Cases = [
      'git status',
      'git log --oneline',
      'git diff HEAD',
      'git branch -a',
      'git ls-files',
      'git show HEAD',
      'ls -la',
      'find . -name "*.js"',
      'which node',
      'wc -l file.txt',
    ];
    for (const cmd of v1Cases) {
      assert.strictEqual(
        isCacheableCommand(cmd, true), true,
        'kill-switch must still accept v1 pattern: ' + cmd
      );
    }
  });

  test('isCacheableCommand under killSwitchOff=true rejects v2-only patterns', () => {
    const v2OnlyCases = [
      'cat README.md',
      'head -n 10 package.json',
      'tail file.log',
      'tree src',
      'file binary',
      'node --version',
      'python3 --version',
      'bun --version',
      'cargo --version',
      'go version',
      'rustc --version',
      'gh repo view',
      'gh issue view 1',
      'gh pr view',
      'npm list',
      'npm list --depth 0',
      'pip list',
    ];
    for (const cmd of v2OnlyCases) {
      assert.strictEqual(
        isCacheableCommand(cmd, true), false,
        'kill-switch must reject v2-only pattern: ' + cmd
      );
    }
  });

  test('isCacheableCommand under killSwitchOff=false accepts v2 patterns (default-on contrast)', () => {
    // Sanity: same v2 inputs are cacheable when wave-2 is ON.
    assert.strictEqual(isCacheableCommand('cat README.md', false), true);
    assert.strictEqual(isCacheableCommand('node --version', false), true);
    assert.strictEqual(isCacheableCommand('gh repo view', false), true);
    assert.strictEqual(isCacheableCommand('npm list', false), true);
  });

  test('hook spawn: cat README.md under FORGE_TOKEN_OPT=0 produces no cache entry on miss', () => {
    const sessionId = freshSession('killswitch-no-v2');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('killswitch-no-v2-');

    // Pre-hook with FORGE_TOKEN_OPT=0: not cacheable -> exit 0, no stdout, no cache.
    const pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: { command: 'cat README.md' }, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.strictEqual((pre.stdout || '').trim(), '');
    assert.strictEqual(listCacheFiles(sessionId).length, 0);

    rmCacheDir(sessionId);
  });
});

// --- AC2: flat 120s TTL under env=0 ----------------------------------------

suite('R006.AC2 kill-switch -- flat 120s TTL', () => {
  test('git status entry 119s old hits, 121s old misses (flat 120s under env=0)', () => {
    const sessionId = freshSession('killswitch-ttl');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('killswitch-ttl-');
    const cacheDir = cacheDirFor(sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });

    const toolInput = { command: 'git status' };
    const hash = hashInput('Bash', toolInput);
    const entryPath = path.join(cacheDir, hash + '.json');

    // Write a forward-compat entry with class='stable' (1800s class TTL).
    // Under FORGE_TOKEN_OPT=0, the read-side must IGNORE the class and apply
    // the flat 120s v1 TTL. Test at 119s (under) -> hit; 121s (over) -> miss.
    const baseTime = Date.now();

    // Entry 119s old: should HIT under flat 120s.
    fs.writeFileSync(entryPath, JSON.stringify({
      timestamp: baseTime - 119000,
      output: 'on branch main',
      class: 'stable', // forward-compat: even with stable class, env=0 caps at 120s
    }));

    let pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0,
      'entry 119s old must hit under flat 120s v1 TTL');
    const parsed = JSON.parse(pre.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.systemMessage || '', /Cached result/);

    // Entry 121s old: should MISS under flat 120s (v2 'stable' class TTL of
    // 1800s would have hit; v1 path correctly expires it).
    fs.writeFileSync(entryPath, JSON.stringify({
      timestamp: baseTime - 121000,
      output: 'on branch main',
      class: 'stable',
    }));

    pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.strictEqual((pre.stdout || '').trim(), '',
      'entry 121s old must miss under flat 120s v1 TTL (NOT use stable class 1800s)');

    rmCacheDir(sessionId);
  });

  test('FORGE_TOKEN_OPT=0 ignores tool_cache_ttl_overrides config', () => {
    // Even with overrides set in config, env=0 must use flat 120s.
    const sessionId = freshSession('killswitch-override');
    rmCacheDir(sessionId);
    const proj = makeTempDir('killswitch-override-');
    fs.mkdirSync(path.join(proj, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.forge', 'config.json'),
      JSON.stringify({
        hooks_config: { tool_cache_ttl_overrides: { volatile: 60, stable: 3600 } },
      })
    );
    const cacheDir = cacheDirFor(sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });

    const toolInput = { command: 'git status' };
    const hash = hashInput('Bash', toolInput);
    const entryPath = path.join(cacheDir, hash + '.json');

    // 90s old: under v1's 120s -> hit. Under override-volatile=60s -> would miss.
    fs.writeFileSync(entryPath, JSON.stringify({
      timestamp: Date.now() - 90000,
      output: 'cached',
      class: 'volatile',
    }));

    const pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0,
      'kill-switch must use flat 120s, ignoring volatile=60s override');

    rmCacheDir(sessionId);
  });
});

// --- AC3: no mtime keying, no HEAD pinning, no stats log -------------------

suite('R006.AC3 kill-switch -- no mtime keying for Read', () => {
  test('Read tool under FORGE_TOKEN_OPT=0 uses bare hash (no _mtime_size suffix)', () => {
    const sessionId = freshSession('killswitch-readkey');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('killswitch-readkey-');

    // Create a real file so stat would otherwise succeed.
    const filePath = path.join(proj, 'data.txt');
    fs.writeFileSync(filePath, 'hello');

    const toolInput = { file_path: filePath };

    // Post-hook writes the entry under FORGE_TOKEN_OPT=0 path (bare hash).
    const post = spawnPostHook({
      tool_name: 'Read',
      tool_input: toolInput,
      tool_output: 'hello',
      session_id: sessionId,
    }, { FORGE_TOKEN_OPT: '0' }, proj);
    assert.strictEqual(post.status, 0);

    const files = listCacheFiles(sessionId);
    assert.strictEqual(files.length, 1);
    // Bare hash: 32 hex chars + .json. NO _<mtime>_<size> suffix.
    assert.match(files[0], /^[0-9a-f]{32}\.json$/,
      'kill-switch must produce bare md5 cache filename (no mtime suffix)');
    assert.ok(!/_\d+_\d+\.json$/.test(files[0]),
      'no _mtime_size suffix expected under env=0');

    // Sanity: pre-hook with same env reads the same key.
    const pre = spawnPreHook(
      { tool_name: 'Read', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0, 'kill-switch read should hit on bare hash');

    rmCacheDir(sessionId);
  });

  test('default-on contrast: Read tool with env unset produces _mtime_size suffix', () => {
    const sessionId = freshSession('default-on-readkey');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('default-on-readkey-');

    const filePath = path.join(proj, 'data2.txt');
    fs.writeFileSync(filePath, 'hello-v2');

    const post = spawnPostHook({
      tool_name: 'Read',
      tool_input: { file_path: filePath },
      tool_output: 'hello-v2',
      session_id: sessionId,
    }, {}, proj); // env unset -> wave-2 ON
    assert.strictEqual(post.status, 0);

    const files = listCacheFiles(sessionId);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}_\d+_\d+\.json$/,
      'wave-2 ON must produce _<mtime>_<size> suffix');

    rmCacheDir(sessionId);
  });
});

suite('R006.AC3 kill-switch -- no HEAD pinning for git ls-files', () => {
  test('git ls-files under FORGE_TOKEN_OPT=0 uses bare hash (no _head_<sha> suffix)', () => {
    if (!gitAvailable()) return;
    withGitRepo('killswitch-headpin-', (repo, sha) => {
      const sessionId = freshSession('killswitch-headpin');
      rmCacheDir(sessionId);

      const toolInput = { command: 'git ls-files' };
      const post = spawnPostHook({
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_output: '(empty)',
        session_id: sessionId,
      }, { FORGE_TOKEN_OPT: '0' }, repo);
      assert.strictEqual(post.status, 0);

      const files = listCacheFiles(sessionId);
      assert.strictEqual(files.length, 1);
      assert.match(files[0], /^[0-9a-f]{32}\.json$/,
        'kill-switch must produce bare md5 (no _head_ suffix) for git ls-files');
      assert.ok(!files[0].includes('_head_'),
        'no _head_ suffix expected under env=0');

      rmCacheDir(sessionId);
    });
  });

  test('default-on contrast: git ls-files with env unset has _head_<sha> suffix', () => {
    if (!gitAvailable()) return;
    headCache.resetCache();
    withGitRepo('default-on-headpin-', (repo, sha) => {
      const sessionId = freshSession('default-on-headpin');
      rmCacheDir(sessionId);

      const post = spawnPostHook({
        tool_name: 'Bash',
        tool_input: { command: 'git ls-files' },
        tool_output: '(empty)',
        session_id: sessionId,
      }, {}, repo); // env unset -> wave-2 ON
      assert.strictEqual(post.status, 0);

      const files = listCacheFiles(sessionId);
      assert.strictEqual(files.length, 1);
      assert.match(files[0], new RegExp('_head_' + sha + '\\.json$', 'i'),
        'wave-2 ON must include _head_<sha> in the filename');

      rmCacheDir(sessionId);
    });
  });
});

suite('R006.AC3 kill-switch -- no cache-stats log writes', () => {
  test('recordCacheEvent returns disabled and never creates the log file', () => {
    const proj = makeProjectWithForgeDir('killswitch-stats-');
    const log = path.join(proj, '.forge', 'cache-stats.jsonl');

    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const r = storeMod.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'volatile', hit: true, age_ms: 100, output_bytes: 256 },
        { forgeDir: path.join(proj, '.forge') }
      );
      assert.strictEqual(r.written, false);
      assert.strictEqual(r.disabled, true);
      assert.strictEqual(fs.existsSync(log), false,
        'kill-switch must NOT create cache-stats.jsonl');
    } finally {
      _restoreOpt();
    }
  });

  test('hook spawn: full miss+hit cycle under env=0 writes no stats log', () => {
    const sessionId = freshSession('killswitch-no-stats');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('killswitch-no-stats-');
    const log = path.join(proj, '.forge', 'cache-stats.jsonl');

    const toolInput = { command: 'git status' };
    // Miss (no entry yet).
    let pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.strictEqual(fs.existsSync(log), false,
      'no stats log after miss under kill-switch');

    // Write entry, then hit.
    const post = spawnPostHook({
      tool_name: 'Bash', tool_input: toolInput, tool_output: 'on branch main', session_id: sessionId,
    }, { FORGE_TOKEN_OPT: '0' }, proj);
    assert.strictEqual(post.status, 0);

    pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0, 'should hit second time');
    assert.strictEqual(fs.existsSync(log), false,
      'no stats log after hit under kill-switch either');

    rmCacheDir(sessionId);
  });

  test('aggregateCacheStats under env=0 returns zeros even when log file exists from prior run', () => {
    // Simulate a stale log from a previous default-on run.
    const proj = makeProjectWithForgeDir('killswitch-aggregator-');
    const forgeDir = path.join(proj, '.forge');
    const log = path.join(forgeDir, 'cache-stats.jsonl');
    fs.writeFileSync(log, [
      JSON.stringify({ ts: Date.now(), tool: 'Bash', pattern_class: 'volatile', hit: true, age_ms: 100, output_bytes: 4000 }),
      JSON.stringify({ ts: Date.now(), tool: 'Bash', pattern_class: 'volatile', hit: false, age_ms: 0, output_bytes: 0 }),
    ].join('\n') + '\n');

    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const agg = forgeTools.aggregateCacheStats(forgeDir);
      assert.deepStrictEqual(agg, { hits: 0, misses: 0, savings_estimate_tokens: 0 },
        'kill-switch must zero the aggregator regardless of file contents');
    } finally {
      _restoreOpt();
    }

    // Sanity: with env unset, the same log produces non-zero counts.
    const aggOn = forgeTools.aggregateCacheStats(forgeDir);
    assert.strictEqual(aggOn.hits, 1);
    assert.strictEqual(aggOn.misses, 1);
    assert.ok(aggOn.savings_estimate_tokens > 0);
  });

  test('getHeadSha under env=0 returns disabled without spawning git', () => {
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      headCache.resetCache();
      const r = headCache.getHeadSha(process.cwd());
      assert.strictEqual(r.source, 'disabled');
      assert.strictEqual(r.sha, null);
      // Must not have populated the memo cache (different impls may or may
      // not memoize disabled; what matters is the contract: source='disabled').
    } finally {
      _restoreOpt();
      headCache.resetCache();
    }
  });
});

// --- AC4: default-on bias (guard checks === '0', not falsy) ----------------

suite('R006.AC4 default-on bias -- guard checks "=== \\"0\\""', () => {
  // Each of these envs (unset, "", "1", "true", "anything") must leave
  // wave-2 features ON.  We exercise this through three independent
  // surfaces: aggregateCacheStats (file IO), recordCacheEvent (file IO),
  // and getHeadSha (disabled check).

  function assertWave2On(envValueLabel, envOverlay) {
    // Use a fresh project for each so we can detect file creation.
    const proj = makeProjectWithForgeDir('default-on-' + envValueLabel + '-');
    const forgeDir = path.join(proj, '.forge');
    const log = path.join(forgeDir, 'cache-stats.jsonl');

    // 1. recordCacheEvent must WRITE (not return disabled).
    const origOpt = process.env.FORGE_TOKEN_OPT;
    if (envOverlay.FORGE_TOKEN_OPT === undefined) {
      delete process.env.FORGE_TOKEN_OPT;
    } else {
      process.env.FORGE_TOKEN_OPT = envOverlay.FORGE_TOKEN_OPT;
    }
    try {
      const r = storeMod.recordCacheEvent(
        { tool: 'Bash', pattern_class: 'volatile', hit: false, age_ms: 0, output_bytes: 0 },
        { forgeDir }
      );
      assert.strictEqual(r.written, true,
        envValueLabel + ': recordCacheEvent must WRITE under wave-2 ON');
      assert.notStrictEqual(r.disabled, true);
      assert.ok(fs.existsSync(log),
        envValueLabel + ': cache-stats.jsonl must exist after a write');

      // 2. aggregateCacheStats must read the file (non-zero misses).
      const agg = forgeTools.aggregateCacheStats(forgeDir);
      assert.strictEqual(agg.misses, 1,
        envValueLabel + ': aggregator must read the log under wave-2 ON');

      // 3. getHeadSha source must NOT be 'disabled'.
      headCache.resetCache();
      const head = headCache.getHeadSha(process.cwd());
      assert.notStrictEqual(head.source, 'disabled',
        envValueLabel + ': getHeadSha must not short-circuit under wave-2 ON');
    } finally {
      if (origOpt === undefined) {
        delete process.env.FORGE_TOKEN_OPT;
      } else {
        process.env.FORGE_TOKEN_OPT = origOpt;
      }
      headCache.resetCache();
    }
  }

  test('FORGE_TOKEN_OPT unset -> wave-2 ON', () => {
    assertWave2On('unset', {});
  });

  test('FORGE_TOKEN_OPT="" (empty string) -> wave-2 ON (guard is === "0", empty != "0")', () => {
    assertWave2On('empty', { FORGE_TOKEN_OPT: '' });
  });

  test('FORGE_TOKEN_OPT="1" -> wave-2 ON', () => {
    assertWave2On('one', { FORGE_TOKEN_OPT: '1' });
  });

  test('FORGE_TOKEN_OPT="true" -> wave-2 ON', () => {
    assertWave2On('true', { FORGE_TOKEN_OPT: 'true' });
  });

  test('FORGE_TOKEN_OPT="anything-else" -> wave-2 ON (default-on bias)', () => {
    assertWave2On('anything', { FORGE_TOKEN_OPT: 'anything-else' });
  });

  test('hook spawn cross-check: FORGE_TOKEN_OPT="1" still enables v2 patterns', () => {
    const sessionId = freshSession('default-on-v2-pattern');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('default-on-v2-pattern-');

    // cat README.md is a v2-only pattern. Under env="1" wave-2 stays ON,
    // so post-hook must store an entry.
    const post = spawnPostHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat README.md' },
      tool_output: 'readme content',
      session_id: sessionId,
    }, { FORGE_TOKEN_OPT: '1' }, proj);
    assert.strictEqual(post.status, 0);

    // The post-hook stores anything not on the mutating list, but the
    // pre-hook is what gates by isCacheableCommand. Verify the pre-hook
    // hits on this v2 pattern under env="1".
    const pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: { command: 'cat README.md' }, session_id: sessionId },
      { FORGE_TOKEN_OPT: '1' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0,
      'wave-2 ON under env="1" must accept cat README.md as cacheable');

    rmCacheDir(sessionId);
  });

  test('hook spawn cross-check: FORGE_TOKEN_OPT="0" rejects v2 patterns (negative control)', () => {
    const sessionId = freshSession('killswitch-rejects-v2');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('killswitch-rejects-v2-');

    // Pre-fill the cache as if a prior wave-2 run wrote an entry. Under
    // FORGE_TOKEN_OPT=0, the pre-hook should refuse to even check the
    // entry because cat README.md is not a v1 pattern -> exit 0, no stdout.
    const cacheDir = cacheDirFor(sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const hash = hashInput('Bash', { command: 'cat README.md' });
    fs.writeFileSync(path.join(cacheDir, hash + '.json'), JSON.stringify({
      timestamp: Date.now(),
      output: 'should-not-be-served',
      class: 'volatile',
    }));

    const pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: { command: 'cat README.md' }, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.strictEqual((pre.stdout || '').trim(), '',
      'kill-switch must refuse to serve cached v2-pattern entry');

    rmCacheDir(sessionId);
  });
});

// --- Behavioral parity summary -- one test that touches all 5 invariants ---

suite('R006 behavioral parity end-to-end', () => {
  test('full cycle under FORGE_TOKEN_OPT=0 satisfies all 5 v1 characteristics', () => {
    const sessionId = freshSession('parity-e2e');
    rmCacheDir(sessionId);
    const proj = makeProjectWithForgeDir('parity-e2e-');
    const log = path.join(proj, '.forge', 'cache-stats.jsonl');
    const toolInput = { command: 'git status' };

    // 1. Only v1 patterns match -> git status (v1) writes; cat (v2) does not.
    let post = spawnPostHook({
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_output: 'on branch main',
      session_id: sessionId,
    }, { FORGE_TOKEN_OPT: '0' }, proj);
    assert.strictEqual(post.status, 0);

    // 2. Cache key components: bare md5 hash, no mtime/head suffix.
    let files = listCacheFiles(sessionId);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}\.json$/,
      'cache key under env=0 must be bare md5 (no mtime, no head suffix)');

    // 3. TTL flat 120s -> verified in dedicated AC2 tests; here just confirm hit.
    const pre = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      proj
    );
    assert.strictEqual(pre.status, 0);
    assert.ok((pre.stdout || '').length > 0, 'fresh entry must hit under flat 120s');

    // 4. No cache-stats log written across miss + write + hit.
    assert.strictEqual(fs.existsSync(log), false,
      'no cache-stats.jsonl must be created under env=0');

    // 5. Aggregator zeros even with no log file.
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const agg = forgeTools.aggregateCacheStats(path.join(proj, '.forge'));
      assert.deepStrictEqual(agg, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
    } finally {
      _restoreOpt();
    }

    rmCacheDir(sessionId);
  });
});

runTests();
