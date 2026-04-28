// tests/tool-cache-head-pinning.test.cjs
//
// Integration tests for hooks/tool-cache.js -- Wave 2 R004.AC2..AC5 (T006).
// HEAD-SHA pinning of the head_pinned cache class.
//
// Coverage map:
//   - Match a head_pinned pattern twice in the same git repo (same HEAD)
//     → second is a hit (key includes HEAD).
//   - Match → `git commit --allow-empty` (different HEAD) → second match
//     resolves a different key → cache miss.
//   - Match in a non-git directory → falls back to volatile (no _head_
//     suffix in key, class='volatile', 120s TTL).
//   - Match in a freshly-init'd repo with no commits (initial state) →
//     falls back to volatile.
//   - getHeadSha errors don't propagate out of the hook (defensive).
//   - FORGE_TOKEN_OPT=0 disables head_pinned classification entirely
//     (everything resolves to volatile + flat 120s TTL via v1 path).
//   - Cache entry's stored `class` field is 'head_pinned' on success and
//     'volatile' on fallback (mirroring the writer's behavior).
//   - End-to-end hook spawn: recordCacheEvent called with correct
//     pattern_class on hit and miss (head_pinned on git-OK, volatile on
//     fallback).
//
// Note on test isolation: every test uses its own temp directory + temp
// session-id, and any git-state mutation happens inside a temp dir. We
// never touch the host repo's .git or cache state.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');

// Clear inherited FORGE_TOKEN_OPT before requiring the module under test.
const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const cacheMod = require('../hooks/tool-cache.js');
const { resolveHeadPinnedKey, hashInput, TTL_BY_CLASS } = cacheMod;
const headCache = require('../scripts/forge-head-cache.cjs');

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

// --- Test fixtures ----------------------------------------------------------

const _tempDirs = [];
function makeTempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-headpin-'));
  _tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of _tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

// withGitRepo(prefix, fn): creates temp dir, runs `git init` + `git
// commit --allow-empty -m initial`, calls fn(repoPath, headSha), returns
// fn's result. Skips (returns null) if git is not on PATH; suite-level
// tests should already check gitAvailable() to skip.
function withGitRepo(prefix, fn) {
  if (!gitAvailable()) return null;
  const repo = makeTempDir(prefix || 'forge-headpin-repo-');
  // Configure a local user for the commits so `git commit` doesn't fail on
  // a host without a global user.email/user.name. Quiet to avoid stderr noise.
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 'Forge Test',
    GIT_AUTHOR_EMAIL: 'test@forge.local',
    GIT_COMMITTER_NAME: 'Forge Test',
    GIT_COMMITTER_EMAIL: 'test@forge.local',
  });
  function git(args) {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
    }
    return (r.stdout || '').trim();
  }
  git(['init', '-q']);
  git(['config', 'user.email', 'test@forge.local']);
  git(['config', 'user.name', 'Forge Test']);
  git(['commit', '--allow-empty', '-q', '-m', 'initial']);
  const headSha = git(['rev-parse', 'HEAD']);
  return fn(repo, headSha, git);
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

// --- resolveHeadPinnedKey unit tests ---------------------------------------

suite('R004 resolveHeadPinnedKey -- unit', () => {
  test('returns key with _head_<sha> suffix and class=head_pinned in a git repo', () => {
    if (!gitAvailable()) return; // skip silently when git not on PATH
    withGitRepo('forge-headpin-unit-', (repo, sha) => {
      headCache.resetCache();
      const toolInput = { command: 'git ls-files' };
      const r = resolveHeadPinnedKey('Bash', toolInput, repo);
      assert.strictEqual(r.class, 'head_pinned');
      assert.strictEqual(r.sha, sha);
      const baseHash = hashInput('Bash', toolInput);
      assert.strictEqual(r.key, baseHash + '_head_' + sha);
    });
  });

  test('demotes to volatile + bare hash when not a git repo', () => {
    headCache.resetCache();
    const dir = makeTempDir('forge-headpin-nongit-');
    const toolInput = { command: 'git ls-files' };
    const r = resolveHeadPinnedKey('Bash', toolInput, dir);
    assert.strictEqual(r.class, 'volatile');
    assert.strictEqual(r.sha, null);
    assert.strictEqual(r.key, hashInput('Bash', toolInput));
  });

  test('demotes to volatile in a fresh-init repo with no commits', () => {
    if (!gitAvailable()) return;
    headCache.resetCache();
    const repo = makeTempDir('forge-headpin-nocommits-');
    const r0 = spawnSync('git', ['init', '-q'], { cwd: repo });
    assert.strictEqual(r0.status, 0, 'git init must succeed');
    const toolInput = { command: 'git ls-files' };
    const res = resolveHeadPinnedKey('Bash', toolInput, repo);
    assert.strictEqual(res.class, 'volatile');
    assert.strictEqual(res.sha, null);
    assert.strictEqual(res.key, hashInput('Bash', toolInput));
  });

  test('different HEADs produce different keys (key-based invalidation)', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-twoheads-', (repo, sha1, git) => {
      headCache.resetCache();
      const toolInput = { command: 'git ls-files' };
      const k1 = resolveHeadPinnedKey('Bash', toolInput, repo).key;
      // Move HEAD with an empty commit.
      git(['commit', '--allow-empty', '-q', '-m', 'second']);
      const sha2 = git(['rev-parse', 'HEAD']);
      assert.notStrictEqual(sha1, sha2, 'sanity: HEAD moved');
      headCache.resetCache(); // clear memo so we re-spawn git
      const k2 = resolveHeadPinnedKey('Bash', toolInput, repo).key;
      assert.notStrictEqual(k1, k2, 'different HEADs must produce different keys');
      assert.match(k1, /_head_[0-9a-f]{40}$/i);
      assert.match(k2, /_head_[0-9a-f]{40}$/i);
    });
  });

  test('NEVER throws on getHeadSha errors (path containing junk)', () => {
    headCache.resetCache();
    // A path that does not exist on the filesystem. _spawnGitHead's
    // execFileSync will fail (cwd ENOENT or git exit 128). The helper
    // catches and surfaces fallback; resolveHeadPinnedKey must accept it.
    const bogus = path.join(os.tmpdir(), 'forge-nonexistent-' + Date.now());
    let r;
    assert.doesNotThrow(() => {
      r = resolveHeadPinnedKey('Bash', { command: 'git ls-files' }, bogus);
    });
    assert.strictEqual(r.class, 'volatile');
    assert.strictEqual(r.sha, null);
  });
});

// --- End-to-end hook spawn tests -------------------------------------------

suite('R004 hook spawn -- head_pinned hits & misses', () => {
  test('write+read in same repo same HEAD: second lookup hits with class=head_pinned', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-hit-', (repo, sha) => {
      const sessionId = freshSession('headpin-hit');
      rmCacheDir(sessionId);
      const toolInput = { command: 'git ls-files' };

      // Post-hook: write entry under HEAD-aware key.
      const wr = spawnPostHook({
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_output: '(no files)',
        session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(wr.status, 0);

      // The cache file's name must include _head_<sha>.
      const files = listCacheFiles(sessionId);
      assert.strictEqual(files.length, 1);
      assert.match(files[0], new RegExp('_head_' + sha + '\\.json$', 'i'));

      // Verify entry.class is 'head_pinned'.
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDirFor(sessionId), files[0]), 'utf8'));
      assert.strictEqual(entry.class, 'head_pinned');

      // Pre-hook: same input + same repo HEAD → hit.
      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(rr.status, 0);
      const out = (rr.stdout || '').trim();
      assert.ok(out.length > 0, 'second lookup must hit');
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.systemMessage || '', /Cached result/);

      // Cache-stats event records pattern_class='head_pinned'.
      const events = readEvents(repo);
      assert.ok(events.length >= 1);
      const last = events[events.length - 1];
      assert.strictEqual(last.tool, 'Bash');
      assert.strictEqual(last.pattern_class, 'head_pinned');
      assert.strictEqual(last.hit, true);

      rmCacheDir(sessionId);
    });
  });

  test('write → git commit (HEAD moves) → second lookup misses (key-based invalidation)', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-miss-', (repo, sha1, git) => {
      const sessionId = freshSession('headpin-miss');
      rmCacheDir(sessionId);
      const toolInput = { command: 'git ls-files' };

      // Write entry under HEAD#1.
      const wr = spawnPostHook({
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_output: 'old-output',
        session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(wr.status, 0);
      const filesBefore = listCacheFiles(sessionId);
      assert.strictEqual(filesBefore.length, 1);
      assert.match(filesBefore[0], new RegExp('_head_' + sha1 + '\\.json$', 'i'));

      // Move HEAD with an empty commit.
      git(['commit', '--allow-empty', '-q', '-m', 'second']);
      const sha2 = git(['rev-parse', 'HEAD']);
      assert.notStrictEqual(sha1, sha2);

      // Pre-hook: same input + new HEAD → key is now <hash>_head_<sha2>,
      // but only <hash>_head_<sha1>.json exists → miss (no stdout, exit 0).
      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(rr.status, 0);
      assert.strictEqual(
        (rr.stdout || '').trim(), '',
        'cache must miss after HEAD moved (key-based invalidation)'
      );

      // Cache-stats event records pattern_class='head_pinned' + hit=false.
      const events = readEvents(repo);
      const last = events[events.length - 1];
      assert.strictEqual(last.pattern_class, 'head_pinned');
      assert.strictEqual(last.hit, false);

      rmCacheDir(sessionId);
    });
  });
});

// --- Fallback paths (not a git repo, no commits) ---------------------------

suite('R004 hook spawn -- fallback paths', () => {
  test('non-git directory: head_pinned demotes to volatile (120s TTL, bare hash key)', () => {
    const dir = makeTempDir('forge-headpin-nongit-e2e-');
    fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
    const sessionId = freshSession('headpin-nongit');
    rmCacheDir(sessionId);
    const toolInput = { command: 'git ls-files' };

    // Post-hook from a non-git dir: cls demotes to volatile, bare hash key.
    const wr = spawnPostHook({
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_output: 'fake-out',
      session_id: sessionId,
    }, {}, dir);
    assert.strictEqual(wr.status, 0);
    const files = listCacheFiles(sessionId);
    assert.strictEqual(files.length, 1);
    const baseHash = hashInput('Bash', toolInput);
    assert.strictEqual(files[0], baseHash + '.json', 'no _head_ suffix in non-git fallback');
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDirFor(sessionId), files[0]), 'utf8'));
    assert.strictEqual(entry.class, 'volatile', 'class demotes to volatile when not in a git repo');

    // Pre-hook from same non-git dir: matches bare hash, hits as volatile.
    const rr = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, dir);
    assert.strictEqual(rr.status, 0);
    const out = (rr.stdout || '').trim();
    assert.ok(out.length > 0, 'volatile fallback must still hit fresh');
    const events = readEvents(dir);
    const last = events[events.length - 1];
    assert.strictEqual(last.pattern_class, 'volatile');
    assert.strictEqual(last.hit, true);

    rmCacheDir(sessionId);
  });

  test('fresh-init repo with no commits: head_pinned demotes to volatile', () => {
    if (!gitAvailable()) return;
    const repo = makeTempDir('forge-headpin-nocommits-e2e-');
    fs.mkdirSync(path.join(repo, '.forge'), { recursive: true });
    const r0 = spawnSync('git', ['init', '-q'], { cwd: repo });
    assert.strictEqual(r0.status, 0);
    const sessionId = freshSession('headpin-nocommits');
    rmCacheDir(sessionId);
    const toolInput = { command: 'git ls-files' };

    const wr = spawnPostHook({
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_output: 'empty',
      session_id: sessionId,
    }, {}, repo);
    assert.strictEqual(wr.status, 0);
    const files = listCacheFiles(sessionId);
    assert.strictEqual(files.length, 1);
    const baseHash = hashInput('Bash', toolInput);
    assert.strictEqual(files[0], baseHash + '.json');
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDirFor(sessionId), files[0]), 'utf8'));
    assert.strictEqual(entry.class, 'volatile');

    rmCacheDir(sessionId);
  });

  test('hook does not throw when git is unreachable from cwd', () => {
    // Bogus cwd: spawnSync inherits and process.cwd() inside the child is
    // the bogus path. getHeadSha catches; resolveHeadPinnedKey demotes to
    // volatile. The hook itself must exit 0 and write a valid stats event.
    // Use an existing temp dir but rmrf its contents to keep cwd legit.
    const dir = makeTempDir('forge-headpin-nothrow-');
    fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
    const sessionId = freshSession('headpin-nothrow');
    rmCacheDir(sessionId);
    const toolInput = { command: 'git ls-files' };

    const wr = spawnPostHook({
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_output: 'x',
      session_id: sessionId,
    }, {}, dir);
    assert.strictEqual(wr.status, 0, 'post-hook must not crash');

    const rr = spawnPreHook({
      tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
    }, {}, dir);
    assert.strictEqual(rr.status, 0, 'pre-hook must not crash');

    rmCacheDir(sessionId);
  });
});

// --- FORGE_TOKEN_OPT=0: head_pinned classification disabled ----------------

suite('R004 FORGE_TOKEN_OPT=0 disables head_pinned', () => {
  test('kill-switch on: write + read uses bare hash + class=volatile', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-killsw-', (repo) => {
      const sessionId = freshSession('headpin-killsw');
      rmCacheDir(sessionId);
      const toolInput = { command: 'git ls-files' };

      // Post-hook with kill-switch: NO HEAD lookup, bare hash, class=volatile.
      const wr = spawnPostHook({
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_output: 'kill',
        session_id: sessionId,
      }, { FORGE_TOKEN_OPT: '0' }, repo);
      assert.strictEqual(wr.status, 0);
      const files = listCacheFiles(sessionId);
      assert.strictEqual(files.length, 1);
      const baseHash = hashInput('Bash', toolInput);
      assert.strictEqual(files[0], baseHash + '.json',
        'kill-switch must use bare hash, no _head_ suffix');
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDirFor(sessionId), files[0]), 'utf8'));
      assert.strictEqual(entry.class, 'volatile',
        'kill-switch forces class=volatile (forward compat per T004)');

      // Pre-hook with kill-switch: bare hash, volatile/120s TTL.
      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, { FORGE_TOKEN_OPT: '0' }, repo);
      assert.strictEqual(rr.status, 0);
      const out = (rr.stdout || '').trim();
      assert.ok(out.length > 0, 'kill-switch fresh entry must still hit');
      // Note: kill-switch suppresses cache-stats logging entirely (R005),
      // so we don't read events here.

      rmCacheDir(sessionId);
    });
  });

  test('kill-switch on: HEAD move does NOT invalidate (because no head_pinned classification)', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-killsw-headmove-', (repo, sha1, git) => {
      const sessionId = freshSession('headpin-killsw-mv');
      rmCacheDir(sessionId);
      const toolInput = { command: 'git ls-files' };

      // Write under kill-switch (bare hash).
      const wr = spawnPostHook({
        tool_name: 'Bash', tool_input: toolInput, tool_output: 'first',
        session_id: sessionId,
      }, { FORGE_TOKEN_OPT: '0' }, repo);
      assert.strictEqual(wr.status, 0);

      // Move HEAD.
      git(['commit', '--allow-empty', '-q', '-m', 'second']);

      // Read still hits because kill-switch's bare hash key is HEAD-agnostic.
      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, { FORGE_TOKEN_OPT: '0' }, repo);
      assert.strictEqual(rr.status, 0);
      const out = (rr.stdout || '').trim();
      assert.ok(out.length > 0,
        'kill-switch lookup must still hit after HEAD move (no per-HEAD invalidation)');

      rmCacheDir(sessionId);
    });
  });
});

// --- TTL behavior: head_pinned entry past v1's 120s window still hits ------

suite('R004 head_pinned TTL: 24h safety cap, key-based invalidation', () => {
  test('entry @ 130s old still hits when HEAD has not moved', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-ttl-', (repo, sha) => {
      const sessionId = freshSession('headpin-ttl');
      rmCacheDir(sessionId);
      const cacheDir = cacheDirFor(sessionId);
      fs.mkdirSync(cacheDir, { recursive: true });
      const toolInput = { command: 'git ls-files' };
      const baseHash = hashInput('Bash', toolInput);
      const headKey = baseHash + '_head_' + sha;

      // Pre-seed an entry @ 130s old (past v1's 120s volatile TTL).
      fs.writeFileSync(
        path.join(cacheDir, headKey + '.json'),
        JSON.stringify({
          timestamp: Date.now() - 130000,
          output: 'cached-files-list',
          class: 'head_pinned',
        })
      );

      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(rr.status, 0);
      const out = (rr.stdout || '').trim();
      assert.ok(out.length > 0,
        'head_pinned @ 130s must hit (24h TTL, HEAD unchanged)');
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.systemMessage, /cached-files-list/);

      rmCacheDir(sessionId);
    });
  });

  test('entry past 24h safety cap still misses (TTL acts as ultimate bound)', () => {
    if (!gitAvailable()) return;
    withGitRepo('forge-headpin-ttl-cap-', (repo, sha) => {
      const sessionId = freshSession('headpin-ttl-cap');
      rmCacheDir(sessionId);
      const cacheDir = cacheDirFor(sessionId);
      fs.mkdirSync(cacheDir, { recursive: true });
      const toolInput = { command: 'git ls-files' };
      const baseHash = hashInput('Bash', toolInput);
      const headKey = baseHash + '_head_' + sha;

      // Pre-seed an entry > 24h old.
      fs.writeFileSync(
        path.join(cacheDir, headKey + '.json'),
        JSON.stringify({
          timestamp: Date.now() - (TTL_BY_CLASS.head_pinned + 60000),
          output: 'ancient',
          class: 'head_pinned',
        })
      );

      const rr = spawnPreHook({
        tool_name: 'Bash', tool_input: toolInput, session_id: sessionId,
      }, {}, repo);
      assert.strictEqual(rr.status, 0);
      assert.strictEqual((rr.stdout || '').trim(), '',
        'entry past 24h cap must miss');

      rmCacheDir(sessionId);
    });
  });
});

_restoreOpt();
runTests();
