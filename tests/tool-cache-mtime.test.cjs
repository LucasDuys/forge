// tests/tool-cache-mtime.test.cjs
//
// Wave 2 R003 (T005): Read-tool mtime+size cache keying.
//
// Verifies:
//   - getReadFileStat returns { mtime_ms, size_bytes } on success and
//     { null, null } on stat error -- never throws.
//   - computeReadCacheKey produces a stat-suffixed filename when stat is
//     available, and a bare md5 hash (v1 shape) when it isn't.
//   - 5 mtime cases via end-to-end PreToolUse hook spawn:
//       1. hit on unchanged file
//       2. miss on touched file (mtime changed via writeFile)
//       3. miss on truncated file (size shrinks)
//       4. miss on extended file (size grows)
//       5. miss on deleted file (stat throws → key falls back to v1; no
//          live-file → v1 entry not present → miss)
//   - Stat errors (deleted, permission-denied, non-string path) never throw.
//   - TTL on Read entries is 600s (read_stat_pinned) when stat-keyed and
//     120s (volatile) when stat unavailable.
//   - FORGE_TOKEN_OPT=0 reverts to v1: no stat call, hash matches v1 shape,
//     flat 120s TTL.
//   - Backward compat: a v1 Read entry (no stat suffix, no class field)
//     still serves on lookup if within 120s.
//   - Stat hot-path budget: ≤ 1ms per call (asserted by timing 100 calls).

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
  getReadFileStat,
  computeReadCacheKey,
  hashInput,
  TTL_BY_CLASS,
} = cacheMod;

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

// --- Helpers ---------------------------------------------------------------

// withTempFile(content, fn): create a temp file with `content`, call fn(path),
// clean up. Returns whatever fn returns. Cleanup is best-effort.
function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tc-mtime-'));
  const filePath = path.join(dir, 'sample.txt');
  fs.writeFileSync(filePath, content);
  try {
    return fn(filePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

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

function makeWorkdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tc-mtime-cwd-'));
  fs.mkdirSync(path.join(d, '.forge'), { recursive: true });
  return d;
}

function makeSession(label) {
  return 'tc-mtime-' + label + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

function cacheDirFor(sessionId) {
  return path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
}

function v1HashForRead(toolInput) {
  return crypto.createHash('md5')
    .update(JSON.stringify({ toolName: 'Read', toolInput }))
    .digest('hex');
}

// Pre-seed a cache entry directly. Used to verify read-side behavior without
// going through the PostToolUse path.
function seedEntry(sessionId, hash, entry) {
  const dir = cacheDirFor(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, hash + '.json'), JSON.stringify(entry));
}

function readCacheEntry(sessionId, hash) {
  const p = path.join(cacheDirFor(sessionId), hash + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cleanupSession(sessionId) {
  try { fs.rmSync(cacheDirFor(sessionId), { recursive: true, force: true }); } catch (_) {}
}

// --- getReadFileStat: pure unit tests --------------------------------------

suite('R003 getReadFileStat -- happy path', () => {
  test('returns { mtime_ms, size_bytes } for an existing file', () => {
    withTempFile('hello world', (p) => {
      const r = getReadFileStat(p);
      assert.strictEqual(typeof r.mtime_ms, 'number');
      assert.strictEqual(typeof r.size_bytes, 'number');
      assert.strictEqual(r.size_bytes, 'hello world'.length);
      assert.ok(r.mtime_ms > 0);
    });
  });

  test('reflects the live file size after writeFileSync', () => {
    withTempFile('a', (p) => {
      const before = getReadFileStat(p);
      fs.writeFileSync(p, 'aaaaaaaa');
      const after = getReadFileStat(p);
      assert.strictEqual(before.size_bytes, 1);
      assert.strictEqual(after.size_bytes, 8);
    });
  });
});

suite('R003 getReadFileStat -- defensive (never throws)', () => {
  test('non-existent file returns null fields, no throw', () => {
    const phantom = path.join(os.tmpdir(), 'forge-tc-mtime-no-such-file-' + Date.now());
    let r;
    assert.doesNotThrow(() => { r = getReadFileStat(phantom); });
    assert.strictEqual(r.mtime_ms, null);
    assert.strictEqual(r.size_bytes, null);
  });

  test('null path returns null fields, no throw', () => {
    let r;
    assert.doesNotThrow(() => { r = getReadFileStat(null); });
    assert.strictEqual(r.mtime_ms, null);
    assert.strictEqual(r.size_bytes, null);
  });

  test('undefined path returns null fields, no throw', () => {
    let r;
    assert.doesNotThrow(() => { r = getReadFileStat(undefined); });
    assert.strictEqual(r.mtime_ms, null);
    assert.strictEqual(r.size_bytes, null);
  });

  test('empty string path returns null fields, no throw', () => {
    let r;
    assert.doesNotThrow(() => { r = getReadFileStat(''); });
    assert.strictEqual(r.mtime_ms, null);
    assert.strictEqual(r.size_bytes, null);
  });

  test('non-string (number) path returns null fields, no throw', () => {
    let r;
    assert.doesNotThrow(() => { r = getReadFileStat(42); });
    assert.strictEqual(r.mtime_ms, null);
    assert.strictEqual(r.size_bytes, null);
  });
});

suite('R003 getReadFileStat -- hot-path budget', () => {
  test('100 stat calls average <= 1ms per call', () => {
    withTempFile('budget probe', (p) => {
      // Warm up
      for (let i = 0; i < 5; i++) getReadFileStat(p);
      const N = 100;
      const start = process.hrtime.bigint();
      for (let i = 0; i < N; i++) getReadFileStat(p);
      const end = process.hrtime.bigint();
      const totalMs = Number(end - start) / 1e6;
      const avgMs = totalMs / N;
      assert.ok(
        avgMs <= 1,
        'avg stat duration exceeded budget: ' + avgMs.toFixed(4) + ' ms/call'
      );
    });
  });
});

// --- computeReadCacheKey: shape tests --------------------------------------

suite('R003 computeReadCacheKey', () => {
  test('with stat available, key has _mtime_size suffix', () => {
    const toolInput = { file_path: '/tmp/x.txt' };
    const baseHash = hashInput('Read', toolInput);
    const key = computeReadCacheKey(toolInput, { mtime_ms: 1700000000000, size_bytes: 42 });
    assert.strictEqual(key, baseHash + '_1700000000000_42');
  });

  test('with stat null, key matches v1 shape (bare hash)', () => {
    const toolInput = { file_path: '/tmp/x.txt' };
    const v1 = v1HashForRead(toolInput);
    const key = computeReadCacheKey(toolInput, { mtime_ms: null, size_bytes: null });
    assert.strictEqual(key, v1);
  });

  test('mtime_ms is floored to int (filesystem float dust)', () => {
    const toolInput = { file_path: '/tmp/x.txt' };
    const baseHash = hashInput('Read', toolInput);
    const k1 = computeReadCacheKey(toolInput, { mtime_ms: 1700000000123.789, size_bytes: 10 });
    const k2 = computeReadCacheKey(toolInput, { mtime_ms: 1700000000123.001, size_bytes: 10 });
    assert.strictEqual(k1, baseHash + '_1700000000123_10');
    assert.strictEqual(k1, k2, 'sub-millisecond float dust must not perturb the key');
  });

  test('different file content -> different size -> different key', () => {
    withTempFile('a', (p) => {
      const toolInput = { file_path: p };
      const s1 = getReadFileStat(p);
      const k1 = computeReadCacheKey(toolInput, s1);
      fs.writeFileSync(p, 'aa');
      const s2 = getReadFileStat(p);
      const k2 = computeReadCacheKey(toolInput, s2);
      assert.notStrictEqual(k1, k2);
    });
  });
});

// --- TTL classes -----------------------------------------------------------

suite('R003 TTL_BY_CLASS includes read_stat_pinned', () => {
  test('read_stat_pinned = 600000 ms (10 min)', () => {
    assert.strictEqual(TTL_BY_CLASS.read_stat_pinned, 600000);
  });
});

// --- End-to-end PreToolUse hook: 5 mtime cases -----------------------------
//
// The hook spawns as a child process so we exercise the real stdin/stdout
// path that Claude Code uses. After a write (PostToolUse simulation via
// direct seedEntry), a second PreToolUse call should hit-or-miss based on
// whether the file's (mtime, size) matches the seeded entry's key.

suite('R003 end-to-end mtime keying (5 cases)', () => {
  test('CASE 1 -- hit on unchanged file', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('hit-unchanged');
    try {
      withTempFile('hit-target', (filePath) => {
        const stat = getReadFileStat(filePath);
        const key = computeReadCacheKey({ file_path: filePath }, stat);
        seedEntry(sessionId, key, {
          timestamp: Date.now() - 1000,
          output: 'cached-content',
          class: 'read_stat_pinned',
        });
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        const out = (r.stdout || '').trim();
        assert.ok(out.length > 0, 'unchanged file should hit (got empty stdout)');
        const parsed = JSON.parse(out);
        assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('CASE 2 -- miss on touched file (write changes mtime+size)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('miss-touched');
    try {
      withTempFile('original', (filePath) => {
        // Seed an entry keyed on the ORIGINAL stat.
        const origStat = getReadFileStat(filePath);
        const origKey = computeReadCacheKey({ file_path: filePath }, origStat);
        seedEntry(sessionId, origKey, {
          timestamp: Date.now() - 1000,
          output: 'stale-content',
          class: 'read_stat_pinned',
        });
        // Mutate the file: new content, different size.
        fs.writeFileSync(filePath, 'something completely different');
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        // Different (mtime, size) → different cache filename → miss.
        assert.strictEqual((r.stdout || '').trim(), '', 'touched file must miss');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('CASE 3 -- miss on truncated file (size shrinks)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('miss-truncated');
    try {
      withTempFile('long content here for truncation', (filePath) => {
        const origStat = getReadFileStat(filePath);
        const origKey = computeReadCacheKey({ file_path: filePath }, origStat);
        seedEntry(sessionId, origKey, {
          timestamp: Date.now() - 1000,
          output: 'pre-trunc-content',
          class: 'read_stat_pinned',
        });
        // Truncate to empty.
        fs.writeFileSync(filePath, '');
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        assert.strictEqual((r.stdout || '').trim(), '', 'truncated file must miss');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('CASE 4 -- miss on extended file (size grows)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('miss-extended');
    try {
      withTempFile('short', (filePath) => {
        const origStat = getReadFileStat(filePath);
        const origKey = computeReadCacheKey({ file_path: filePath }, origStat);
        seedEntry(sessionId, origKey, {
          timestamp: Date.now() - 1000,
          output: 'pre-extend-content',
          class: 'read_stat_pinned',
        });
        // Append to extend.
        fs.appendFileSync(filePath, ' extra bytes appended');
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        assert.strictEqual((r.stdout || '').trim(), '', 'extended file must miss');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('CASE 5 -- miss on deleted file (stat throws -> v1 fallback key, no entry)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('miss-deleted');
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tc-mtime-del-'));
      const filePath = path.join(dir, 'will-be-deleted.txt');
      fs.writeFileSync(filePath, 'doomed');
      const origStat = getReadFileStat(filePath);
      const origKey = computeReadCacheKey({ file_path: filePath }, origStat);
      seedEntry(sessionId, origKey, {
        timestamp: Date.now() - 1000,
        output: 'pre-delete-content',
        class: 'read_stat_pinned',
      });
      // Delete the file. Subsequent stat returns null fields → key falls
      // back to v1 (no _mtime_size suffix). No v1-shape entry exists, so
      // the lookup misses.
      fs.rmSync(filePath, { force: true });
      try { fs.rmdirSync(dir); } catch (_) {}
      const r = spawnPreHook({
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        session_id: sessionId,
      }, {}, cwd);
      assert.strictEqual(r.status, 0);
      assert.strictEqual((r.stdout || '').trim(), '', 'deleted file must miss');
    } finally {
      cleanupSession(sessionId);
    }
  });
});

// --- Stat error never throws out of the hook -------------------------------

suite('R003 stat errors never throw out of the hook', () => {
  test('Read on non-existent file -> hook exits cleanly (no crash, no stdout)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('stat-err');
    try {
      const phantom = path.join(os.tmpdir(), 'forge-tc-mtime-phantom-' + Date.now() + '.txt');
      const r = spawnPreHook({
        tool_name: 'Read',
        tool_input: { file_path: phantom },
        session_id: sessionId,
      }, {}, cwd);
      // Hook must NOT crash. status 0, no JSON deny on stdout.
      assert.strictEqual(r.status, 0);
      assert.strictEqual((r.stdout || '').trim(), '');
      // No throw means stderr should not contain an unhandled exception trace.
      assert.ok(!/UnhandledException|TypeError: Cannot/.test(r.stderr || ''),
        'hook stderr should not contain crash trace: ' + r.stderr);
    } finally {
      cleanupSession(sessionId);
    }
  });
});

// --- TTL: 600s when stat-keyed, 120s when not ------------------------------

suite('R003 TTL = 600s when stat-keyed, 120s when stat unavailable', () => {
  test('stat-keyed entry @ 5min still hits (read_stat_pinned TTL = 600s)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('ttl-600');
    try {
      withTempFile('ttl probe', (filePath) => {
        const stat = getReadFileStat(filePath);
        const key = computeReadCacheKey({ file_path: filePath }, stat);
        // Age = 5 minutes. Volatile (120s) would be expired; read_stat_pinned
        // (600s) should still be live.
        seedEntry(sessionId, key, {
          timestamp: Date.now() - 300000,
          output: 'cached-5min-old',
          class: 'read_stat_pinned',
        });
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        const out = (r.stdout || '').trim();
        assert.ok(out.length > 0, 'read_stat_pinned @ 5min should hit (TTL=10min)');
        // Verify the entry's class on disk is read_stat_pinned (write-side
        // assertion lives in another test; this verifies read-time TTL
        // resolution honors the entry's class).
        const entry = readCacheEntry(sessionId, key);
        assert.strictEqual(entry.class, 'read_stat_pinned');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('stat-keyed entry @ 11min misses (past 600s TTL)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('ttl-600-expired');
    try {
      withTempFile('ttl probe expired', (filePath) => {
        const stat = getReadFileStat(filePath);
        const key = computeReadCacheKey({ file_path: filePath }, stat);
        seedEntry(sessionId, key, {
          timestamp: Date.now() - 660000, // 11 min
          output: 'too-old',
          class: 'read_stat_pinned',
        });
        const r = spawnPreHook({
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: sessionId,
        }, {}, cwd);
        assert.strictEqual(r.status, 0);
        assert.strictEqual((r.stdout || '').trim(), '',
          'read_stat_pinned @ 11min must miss (TTL=10min)');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('stat unavailable -> v1 hash + volatile/120s TTL applies', () => {
    // Seed a v1-shape entry (no stat suffix, class=volatile, age<120s).
    // For a NON-EXISTENT file, the hook's stat call will return null fields
    // and fall back to the v1 hash → the seeded entry is found and served.
    const cwd = makeWorkdir();
    const sessionId = makeSession('ttl-fallback');
    try {
      const phantom = path.join(os.tmpdir(), 'forge-tc-mtime-phantom-fb-' + Date.now() + '.txt');
      const v1Key = v1HashForRead({ file_path: phantom });
      seedEntry(sessionId, v1Key, {
        timestamp: Date.now() - 1000,
        output: 'v1-fallback-content',
        class: 'volatile',
      });
      const r = spawnPreHook({
        tool_name: 'Read',
        tool_input: { file_path: phantom },
        session_id: sessionId,
      }, {}, cwd);
      assert.strictEqual(r.status, 0);
      const out = (r.stdout || '').trim();
      assert.ok(out.length > 0, 'v1 entry should hit when stat unavailable');
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('stat unavailable + v1 entry @ 121s misses (volatile/120s TTL)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('ttl-fallback-expired');
    try {
      const phantom = path.join(os.tmpdir(), 'forge-tc-mtime-phantom-fb2-' + Date.now() + '.txt');
      const v1Key = v1HashForRead({ file_path: phantom });
      seedEntry(sessionId, v1Key, {
        timestamp: Date.now() - 121000, // just past 120s
        output: 'too-old-v1',
        class: 'volatile',
      });
      const r = spawnPreHook({
        tool_name: 'Read',
        tool_input: { file_path: phantom },
        session_id: sessionId,
      }, {}, cwd);
      assert.strictEqual(r.status, 0);
      assert.strictEqual((r.stdout || '').trim(), '',
        'v1 fallback @ 121s must miss (volatile TTL = 120s)');
    } finally {
      cleanupSession(sessionId);
    }
  });
});

// --- FORGE_TOKEN_OPT=0 reverts to v1 ---------------------------------------

suite('R003 FORGE_TOKEN_OPT=0 reverts to v1 (no stat call)', () => {
  test('kill-switch path matches v1 cache filename shape', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('killsw');
    try {
      withTempFile('killswitch test', (filePath) => {
        const v1Key = v1HashForRead({ file_path: filePath });
        // Seed a v1-shape entry.
        seedEntry(sessionId, v1Key, {
          timestamp: Date.now() - 1000,
          output: 'v1-killswitch-content',
        });
        const r = spawnPreHook(
          {
            tool_name: 'Read',
            tool_input: { file_path: filePath },
            session_id: sessionId,
          },
          { FORGE_TOKEN_OPT: '0' },
          cwd
        );
        assert.strictEqual(r.status, 0);
        const out = (r.stdout || '').trim();
        assert.ok(out.length > 0, 'kill-switch should hit on v1-shape entry');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('kill-switch + entry @ 121s misses (flat 120s TTL applied)', () => {
    const cwd = makeWorkdir();
    const sessionId = makeSession('killsw-expired');
    try {
      withTempFile('killswitch ttl', (filePath) => {
        const v1Key = v1HashForRead({ file_path: filePath });
        seedEntry(sessionId, v1Key, {
          timestamp: Date.now() - 121000,
          output: 'too-old-killswitch',
        });
        const r = spawnPreHook(
          {
            tool_name: 'Read',
            tool_input: { file_path: filePath },
            session_id: sessionId,
          },
          { FORGE_TOKEN_OPT: '0' },
          cwd
        );
        assert.strictEqual(r.status, 0);
        assert.strictEqual((r.stdout || '').trim(), '',
          'kill-switch @ 121s must miss (flat 120s TTL)');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });

  test('kill-switch ignores stat-keyed entry (different filename shape)', () => {
    // Pre-seed a stat-keyed entry (read_stat_pinned). Under kill-switch,
    // the hook computes the v1 hash → does NOT find the stat-keyed entry →
    // miss. This proves kill-switch does not consult stat-keyed entries.
    const cwd = makeWorkdir();
    const sessionId = makeSession('killsw-ignores-stat');
    try {
      withTempFile('killswitch ignores stat-keyed', (filePath) => {
        const stat = getReadFileStat(filePath);
        const statKey = computeReadCacheKey({ file_path: filePath }, stat);
        seedEntry(sessionId, statKey, {
          timestamp: Date.now() - 1000,
          output: 'stat-keyed-content',
          class: 'read_stat_pinned',
        });
        const r = spawnPreHook(
          {
            tool_name: 'Read',
            tool_input: { file_path: filePath },
            session_id: sessionId,
          },
          { FORGE_TOKEN_OPT: '0' },
          cwd
        );
        assert.strictEqual(r.status, 0);
        assert.strictEqual((r.stdout || '').trim(), '',
          'kill-switch must not find stat-keyed entry');
      });
    } finally {
      cleanupSession(sessionId);
    }
  });
});

// --- Backward compat: v1 entry without class field ------------------------

suite('R003 backward compat: v1 entry without stat suffix or class', () => {
  test('v1-shape entry (no stat suffix, no class) hits within 120s when stat unavailable', () => {
    // Stat unavailable (phantom file) -> hook falls back to v1 hash. Entry
    // has no `class` field -> resolves to volatile (120s). Age 1s -> hit.
    const cwd = makeWorkdir();
    const sessionId = makeSession('v1-back-compat');
    try {
      const phantom = path.join(os.tmpdir(), 'forge-tc-mtime-phantom-bc-' + Date.now() + '.txt');
      const v1Key = v1HashForRead({ file_path: phantom });
      // No `class` field -- exactly the v1 shape pre-Wave-2.
      seedEntry(sessionId, v1Key, {
        timestamp: Date.now() - 1000,
        output: 'v1-no-class-content',
      });
      const r = spawnPreHook({
        tool_name: 'Read',
        tool_input: { file_path: phantom },
        session_id: sessionId,
      }, {}, cwd);
      assert.strictEqual(r.status, 0);
      const out = (r.stdout || '').trim();
      assert.ok(out.length > 0, 'v1 entry without class should still hit (volatile fallback)');
    } finally {
      cleanupSession(sessionId);
    }
  });
});

_restoreOpt();
runTests();
