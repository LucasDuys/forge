// tests/tool-cache-ttl.test.cjs
//
// Unit + integration tests for hooks/tool-cache.js -- Wave 2 R002 tiered TTL
// classes (stable / volatile / head_pinned) + operator config overrides.
//
// Coverage map:
//   - classifyPattern: at least 3 representative patterns per class
//   - getTtl: defaults resolve to TTL_BY_CLASS, overrides take precedence
//   - loadCacheConfig: reads .forge/config.json::hooks_config.tool_cache_ttl_overrides
//     (memoized per forgeDir, malformed config falls back to defaults)
//   - Backward compat: cache entry without `class` field reads as volatile
//   - FORGE_TOKEN_OPT=0: TTL collapses to flat v1 120s regardless of class;
//     stored class field is 'volatile' for forward compat
//   - Cache-write integration: tool-cache-store writes entry.class
//   - head_pinned: T006 wires per-HEAD invalidation. The 24h safety-cap TTL
//     and the HEAD-aware key shape are exercised in tool-cache-head-pinning;
//     this file's head_pinned tests cover only the class-routing + default
//     TTL constant, not the end-to-end key/invalidation behavior.
//
// Note on file location:
//   Top-level tests/ per scripts/run-tests.cjs:32 (non-recursive readdir).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

// Clear inherited FORGE_TOKEN_OPT before requiring the module under test.
const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const cacheMod = require('../hooks/tool-cache.js');
const {
  classifyPattern,
  loadCacheConfig,
  getTtl,
  TTL_BY_CLASS,
  DEFAULT_TTL_MS,
  _resetCacheConfig,
} = cacheMod;

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

// --- classifyPattern: 3+ patterns per class -----------------------------

suite('R002 classifyPattern -- stable class', () => {
  test('stable: version queries (>= 3 reps)', () => {
    const cases = [
      'node -v',
      'node --version',
      'python --version',
      'python3 --version',
      'bun --version',
      'cargo --version',
      'go version',
      'rustc --version',
    ];
    for (const c of cases) {
      assert.strictEqual(
        classifyPattern(c),
        'stable',
        `expected stable for: ${JSON.stringify(c)}`
      );
    }
  });

  test('stable: immutable git refs (sha-pinned, >= 3 reps)', () => {
    const cases = [
      'git show abc1234',                                  // 7-char sha
      'git show abcdef0',                                  // 7-char sha
      'git show 1234567890abcdef',                         // 16-char sha
      'git show 1234567890abcdef1234567890abcdef12345678', // 40-char sha
    ];
    for (const c of cases) {
      assert.strictEqual(
        classifyPattern(c),
        'stable',
        `expected stable for sha-ref: ${JSON.stringify(c)}`
      );
    }
  });
});

suite('R002 classifyPattern -- volatile class', () => {
  test('volatile: status quo patterns (>= 3 reps)', () => {
    const cases = [
      'git status',
      'git diff',
      'git diff HEAD',
      'git log --oneline -10',
      'git branch',
      'ls',
      'ls -la',
      'find . -name foo',
      'cat README.md',
      'gh repo view',
      'gh pr view 7',
    ];
    for (const c of cases) {
      assert.strictEqual(
        classifyPattern(c),
        'volatile',
        `expected volatile for: ${JSON.stringify(c)}`
      );
    }
  });

  test('volatile: short non-sha "git show" args fall through to volatile', () => {
    // Only 7-40 char hex matches STABLE_GIT_SHA_RE; shorter or non-hex should
    // not be classified as stable.
    assert.strictEqual(classifyPattern('git show abcd'), 'volatile');     // < 7 chars
    assert.strictEqual(classifyPattern('git show v1.0.0'), 'volatile');   // tag, not sha
    assert.strictEqual(classifyPattern('git show origin/main'), 'volatile');
  });
});

suite('R002 classifyPattern -- head_pinned class', () => {
  test('head_pinned: HEAD-bound git queries (>= 3 reps)', () => {
    const cases = [
      'git ls-files',
      'git ls-files src',
      'git show HEAD',
      'git show HEAD~1',
      'git show HEAD^',
      'git rev-parse HEAD',
    ];
    for (const c of cases) {
      assert.strictEqual(
        classifyPattern(c),
        'head_pinned',
        `expected head_pinned for: ${JSON.stringify(c)}`
      );
    }
  });
});

suite('R002 classifyPattern -- defensive', () => {
  test('non-string input falls back to volatile', () => {
    assert.strictEqual(classifyPattern(undefined), 'volatile');
    assert.strictEqual(classifyPattern(null), 'volatile');
    assert.strictEqual(classifyPattern(42), 'volatile');
  });
});

// --- TTL_BY_CLASS defaults --------------------------------------------------

suite('R002 TTL_BY_CLASS defaults', () => {
  test('stable = 1800000 ms (30 min)', () => {
    assert.strictEqual(TTL_BY_CLASS.stable, 1800000);
  });
  test('volatile = 120000 ms (2 min, status quo)', () => {
    assert.strictEqual(TTL_BY_CLASS.volatile, 120000);
  });
  test('head_pinned = 86400000 ms (24h safety cap; T006 per-HEAD invalidation)', () => {
    // T006 wired per-HEAD invalidation: head_pinned entries fold the current
    // HEAD SHA into the cache filename, so a HEAD move produces a brand-new
    // key (natural invalidation, no time-based check needed). The 24h TTL is
    // a safety bound only -- under normal use, HEAD invalidation fires long
    // before this cap. End-to-end key/invalidation behavior is exercised in
    // tests/tool-cache-head-pinning.test.cjs.
    assert.strictEqual(TTL_BY_CLASS.head_pinned, 86400000);
  });
});

// --- getTtl: defaults + overrides ------------------------------------------

suite('R002 getTtl', () => {
  test('with no overrides, returns TTL_BY_CLASS values', () => {
    assert.strictEqual(getTtl('stable'), 1800000);
    assert.strictEqual(getTtl('volatile'), 120000);
    assert.strictEqual(getTtl('head_pinned'), 86400000);
  });

  test('unknown class falls back to volatile default', () => {
    assert.strictEqual(getTtl('made-up-class'), 120000);
    assert.strictEqual(getTtl(undefined), 120000);
  });

  test('overrides take precedence over baked-in defaults', () => {
    const ov = { stable: 600000, volatile: 60000, head_pinned: 30000 };
    assert.strictEqual(getTtl('stable', ov), 600000);
    assert.strictEqual(getTtl('volatile', ov), 60000);
    assert.strictEqual(getTtl('head_pinned', ov), 30000);
  });

  test('partial override only affects specified class', () => {
    const ov = { stable: 7200000 };  // 2h override for stable only
    assert.strictEqual(getTtl('stable', ov), 7200000);
    assert.strictEqual(getTtl('volatile', ov), 120000);     // default
    assert.strictEqual(getTtl('head_pinned', ov), 86400000); // default 24h
  });
});

// --- loadCacheConfig: reads .forge/config.json -----------------------------

function makeForgeDir(config) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tc-ttl-'));
  const forgeDir = path.join(projectDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(forgeDir, 'config.json'), config);
  }
  return forgeDir;
}

suite('R002 loadCacheConfig', () => {
  test('missing config.json -> empty overrides', () => {
    _resetCacheConfig();
    const dir = makeForgeDir(/* no config */);
    const ov = loadCacheConfig(dir);
    assert.deepStrictEqual({ ...ov }, {});
  });

  test('config without hooks_config.tool_cache_ttl_overrides -> empty', () => {
    _resetCacheConfig();
    const dir = makeForgeDir(JSON.stringify({ unrelated: 'value' }));
    const ov = loadCacheConfig(dir);
    assert.deepStrictEqual({ ...ov }, {});
  });

  test('valid overrides converted from seconds to ms', () => {
    _resetCacheConfig();
    const cfg = {
      hooks_config: {
        tool_cache_ttl_overrides: {
          stable: 3600,      // 1h
          volatile: 60,      // 1 min
          head_pinned: 300,  // 5 min
        },
      },
    };
    const dir = makeForgeDir(JSON.stringify(cfg));
    const ov = loadCacheConfig(dir);
    assert.strictEqual(ov.stable, 3600 * 1000);
    assert.strictEqual(ov.volatile, 60 * 1000);
    assert.strictEqual(ov.head_pinned, 300 * 1000);
  });

  test('partial overrides: only specified classes are present', () => {
    _resetCacheConfig();
    const cfg = {
      hooks_config: {
        tool_cache_ttl_overrides: { stable: 900 },
      },
    };
    const dir = makeForgeDir(JSON.stringify(cfg));
    const ov = loadCacheConfig(dir);
    assert.strictEqual(ov.stable, 900 * 1000);
    assert.strictEqual(ov.volatile, undefined);
    assert.strictEqual(ov.head_pinned, undefined);
  });

  test('malformed config (invalid JSON) -> empty overrides, no throw', () => {
    _resetCacheConfig();
    const dir = makeForgeDir('not valid json {{{');
    const ov = loadCacheConfig(dir);
    assert.deepStrictEqual({ ...ov }, {});
  });

  test('invalid override values are dropped (negative, zero, NaN, string)', () => {
    _resetCacheConfig();
    const cfg = {
      hooks_config: {
        tool_cache_ttl_overrides: {
          stable: -1,
          volatile: 0,
          head_pinned: 'not a number',
        },
      },
    };
    const dir = makeForgeDir(JSON.stringify(cfg));
    const ov = loadCacheConfig(dir);
    assert.strictEqual(ov.stable, undefined);
    assert.strictEqual(ov.volatile, undefined);
    assert.strictEqual(ov.head_pinned, undefined);
  });

  test('memoization: same forgeDir returns same object (per-process cache)', () => {
    _resetCacheConfig();
    const cfg = {
      hooks_config: { tool_cache_ttl_overrides: { stable: 1234 } },
    };
    const dir = makeForgeDir(JSON.stringify(cfg));
    const ov1 = loadCacheConfig(dir);
    // Mutate config.json on disk; memoized result should NOT see it.
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ hooks_config: { tool_cache_ttl_overrides: { stable: 9999 } } })
    );
    const ov2 = loadCacheConfig(dir);
    assert.strictEqual(ov1, ov2, 'same object reference (memoized)');
    assert.strictEqual(ov2.stable, 1234 * 1000, 'memoized value still 1234s');
    // After explicit reset, the new value is picked up.
    _resetCacheConfig();
    const ov3 = loadCacheConfig(dir);
    assert.strictEqual(ov3.stable, 9999 * 1000);
  });
});

// --- End-to-end hook spawn: cache write/read with class field --------------

function spawnPreHook(payload, env, cwd) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'tool-cache.js');
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign({}, process.env, env || {}),
  });
}

function spawnPostHook(payload, env, cwd) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'tool-cache-store.js');
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign({}, process.env, env || {}),
  });
}

function makeWorkdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tc-ttl-e2e-'));
  fs.mkdirSync(path.join(d, '.forge'), { recursive: true });
  return d;
}

function hashOf(toolName, toolInput) {
  return crypto.createHash('md5')
    .update(JSON.stringify({ toolName, toolInput }))
    .digest('hex');
}

suite('R002 cache-write stores class field (PostToolUse)', () => {
  test('stable command writes entry with class=stable', () => {
    const sessionId = 'ttl-e2e-stable-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    const r = spawnPostHook({
      tool_name: 'Bash',
      tool_input: { command: 'node -v' },
      tool_output: 'v20.0.0',
      session_id: sessionId,
    });
    assert.strictEqual(r.status, 0);
    const hash = hashOf('Bash', { command: 'node -v' });
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, hash + '.json'), 'utf8'));
    assert.strictEqual(entry.class, 'stable', 'entry.class should be stable');
    assert.strictEqual(entry.output, 'v20.0.0');
    assert.ok(typeof entry.timestamp === 'number');
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('volatile command writes entry with class=volatile', () => {
    const sessionId = 'ttl-e2e-volatile-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    const r = spawnPostHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_output: 'On branch main',
      session_id: sessionId,
    });
    assert.strictEqual(r.status, 0);
    const hash = hashOf('Bash', { command: 'git status' });
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, hash + '.json'), 'utf8'));
    assert.strictEqual(entry.class, 'volatile');
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('head_pinned command writes entry with class=head_pinned (or volatile if not in a git repo)', () => {
    // T006: the writer folds HEAD SHA into the cache filename when in a git
    // repo. When not in a git repo, the class demotes to 'volatile' and the
    // bare hash is used. The test runner's process.cwd() is the repo root
    // (a real git repo), so we expect the 'head_pinned' branch normally; we
    // tolerate the volatile fallback for environments without git on PATH.
    const sessionId = 'ttl-e2e-headpin-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    const r = spawnPostHook({
      tool_name: 'Bash',
      tool_input: { command: 'git ls-files' },
      tool_output: 'src/foo.js\nsrc/bar.js',
      session_id: sessionId,
    });
    assert.strictEqual(r.status, 0);
    // Find whatever file the post-hook wrote (we don't assume the head
    // suffix because that depends on whether git is reachable from cwd).
    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, 'exactly one cache file written');
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
    assert.ok(
      entry.class === 'head_pinned' || entry.class === 'volatile',
      'entry.class must be head_pinned (git OK) or volatile (fallback); got ' + entry.class
    );
    if (entry.class === 'head_pinned') {
      // Filename must include the _head_<sha> suffix.
      assert.match(files[0], /_head_[0-9a-f]{40}\.json$/i);
    } else {
      // Volatile fallback: bare hash filename.
      const baseHash = hashOf('Bash', { command: 'git ls-files' });
      assert.strictEqual(files[0], baseHash + '.json');
    }
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('FORGE_TOKEN_OPT=0 forces class=volatile on write (forward compat)', () => {
    const sessionId = 'ttl-e2e-killsw-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    const r = spawnPostHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'node -v' },  // would be 'stable' in v2
        tool_output: 'v20.0.0',
        session_id: sessionId,
      },
      { FORGE_TOKEN_OPT: '0' }
    );
    assert.strictEqual(r.status, 0);
    const hash = hashOf('Bash', { command: 'node -v' });
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, hash + '.json'), 'utf8'));
    assert.strictEqual(
      entry.class,
      'volatile',
      'FORGE_TOKEN_OPT=0 must force volatile for forward compat'
    );
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });
});

// --- Read-side TTL resolution: backward compat + per-class behavior --------

suite('R002 cache-read TTL resolution', () => {
  test('entry without class field reads as volatile (backward compat with v1)', () => {
    const cwd = makeWorkdir();
    const sessionId = 'ttl-e2e-v1back-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'cat README.md' };
    const hash = hashOf('Bash', toolInput);
    // Pre-seed a v1-style entry: NO `class` field, age 1s.
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({ timestamp: Date.now() - 1000, output: 'old-v1-cache' })
    );

    const r = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, cwd);
    assert.strictEqual(r.status, 0);
    // Hit (age 1s < 120s volatile TTL) -> JSON on stdout with deny.
    const out = (r.stdout || '').trim();
    assert.ok(out.length > 0, 'v1 entry should still hit within 120s window');
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');

    // Stats record should report pattern_class='volatile' (the entry's
    // resolved class, which is the v1 fallback).
    const log = path.join(cwd, '.forge', 'cache-stats.jsonl');
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(ev.hit, true);
    assert.strictEqual(ev.pattern_class, 'volatile');

    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('stable entry with age > 120s but < 1800s still hits (long TTL applied)', () => {
    const cwd = makeWorkdir();
    const sessionId = 'ttl-e2e-stable-hit-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'node -v' };
    const hash = hashOf('Bash', toolInput);
    // Age 5 minutes (300s). Volatile would be expired (>120s); stable should
    // still be live (<1800s).
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 300000,
        output: 'v20.0.0',
        class: 'stable',
      })
    );
    const r = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, cwd);
    assert.strictEqual(r.status, 0);
    const out = (r.stdout || '').trim();
    assert.ok(out.length > 0, 'stable entry @ 5min should still hit (TTL=30min)');
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
    // Stats record should report pattern_class='stable'
    const log = path.join(cwd, '.forge', 'cache-stats.jsonl');
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(ev.pattern_class, 'stable');
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('stable entry with age > 1800s misses (TTL expired)', () => {
    const cwd = makeWorkdir();
    const sessionId = 'ttl-e2e-stable-miss-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'node -v' };
    const hash = hashOf('Bash', toolInput);
    // Age 31 minutes (>1800s).
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 1860000,
        output: 'v20.0.0',
        class: 'stable',
      })
    );
    const r = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, cwd);
    assert.strictEqual(r.status, 0);
    // Miss -> exit(0) with no stdout.
    assert.strictEqual((r.stdout || '').trim(), '');
    const log = path.join(cwd, '.forge', 'cache-stats.jsonl');
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(ev.hit, false);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('FORGE_TOKEN_OPT=0: stable entry > 120s misses (flat v1 TTL applied)', () => {
    const cwd = makeWorkdir();
    const sessionId = 'ttl-e2e-killsw-stable-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    // Use a v1-cacheable cmd (`git show <sha>`) so kill-switch path lets it
    // through. Also covers backward compat: kill switch ignores entry.class
    // and applies the flat 120s TTL regardless.
    const toolInput = { command: 'git show abc1234' };
    const hash = hashOf('Bash', toolInput);
    // Age 5 min (300s). With class=stable + v2 path, this would be a hit.
    // With kill-switch on, flat 120s TTL applies → miss.
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 300000,
        output: 'commit abc1234\n...',
        class: 'stable',
      })
    );
    const r = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      cwd
    );
    assert.strictEqual(r.status, 0);
    // Kill-switch + age>120s → miss.
    assert.strictEqual((r.stdout || '').trim(), '');
    // No stats logging in kill-switch (R005 store kill-switch).
    const log = path.join(cwd, '.forge', 'cache-stats.jsonl');
    assert.strictEqual(fs.existsSync(log), false);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('FORGE_TOKEN_OPT=0: stable entry < 120s still hits (flat v1 TTL)', () => {
    const cwd = makeWorkdir();
    const sessionId = 'ttl-e2e-killsw-stable-hit-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'git show abc1234' };
    const hash = hashOf('Bash', toolInput);
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 1000,  // 1 second old
        output: 'commit abc1234\n...',
        class: 'stable',
      })
    );
    const r = spawnPreHook(
      { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
      { FORGE_TOKEN_OPT: '0' },
      cwd
    );
    assert.strictEqual(r.status, 0);
    const out = (r.stdout || '').trim();
    assert.ok(out.length > 0, 'kill-switch within 120s should still hit');
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  // --- T006: head_pinned now uses key-based invalidation, not time-based ---
  // T006 wired per-HEAD invalidation: head_pinned entries fold HEAD SHA into
  // the cache filename, so a HEAD move produces a brand-new key (natural
  // invalidation, no time-based check). The TTL constant is now a 24h
  // safety cap only -- end-to-end git-mutation coverage and key-based
  // invalidation tests live in tests/tool-cache-head-pinning.test.cjs to
  // keep this file focused on R002 TTL semantics. See that file for the
  // T006 acceptance criteria.
  test('T006 head_pinned TTL constant: 24h (was 120s in T004 stub)', () => {
    // Sanity: TTL_BY_CLASS.head_pinned is now 24h. Past T004 callers that
    // assumed a 120s expiry must have been updated; if any survive, they
    // will fail here loudly rather than silently rotting.
    assert.strictEqual(TTL_BY_CLASS.head_pinned, 86400000);
    // Without overrides, getTtl mirrors TTL_BY_CLASS.
    assert.strictEqual(getTtl('head_pinned'), 86400000);
    // With override, override wins.
    assert.strictEqual(getTtl('head_pinned', { head_pinned: 60000 }), 60000);
  });
});

// --- Operator config override end-to-end -----------------------------------

suite('R002 operator override end-to-end', () => {
  test('config override extends volatile TTL, entry hits past v1 120s', () => {
    _resetCacheConfig();
    const cwd = makeWorkdir();
    // Override volatile to 600s (10 min).
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      JSON.stringify({
        hooks_config: { tool_cache_ttl_overrides: { volatile: 600 } },
      })
    );
    const sessionId = 'ttl-e2e-override-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'git status' };
    const hash = hashOf('Bash', toolInput);
    // Age 5 minutes (300s) -- past default volatile (120s) but within
    // overridden volatile (600s).
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 300000,
        output: 'On branch main',
        class: 'volatile',
      })
    );
    const r = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, cwd);
    assert.strictEqual(r.status, 0);
    const out = (r.stdout || '').trim();
    assert.ok(out.length > 0, 'override should let volatile hit at 5min');
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('config override shrinks stable TTL, entry misses sooner', () => {
    _resetCacheConfig();
    const cwd = makeWorkdir();
    // Override stable to 60s (1 min) -- much shorter than default 1800s.
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      JSON.stringify({
        hooks_config: { tool_cache_ttl_overrides: { stable: 60 } },
      })
    );
    const sessionId = 'ttl-e2e-shrink-' + Date.now();
    const cacheDir = path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
    fs.mkdirSync(cacheDir, { recursive: true });
    const toolInput = { command: 'node -v' };
    const hash = hashOf('Bash', toolInput);
    // Age 90s -- past overridden stable (60s).
    fs.writeFileSync(
      path.join(cacheDir, hash + '.json'),
      JSON.stringify({
        timestamp: Date.now() - 90000,
        output: 'v20.0.0',
        class: 'stable',
      })
    );
    const r = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, cwd);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(
      (r.stdout || '').trim(),
      '',
      'shrunk stable TTL should miss at 90s'
    );
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
  });
});

_restoreOpt();
runTests();
