// tests/token-cache-smoke.test.cjs -- Wave 2 close-out smoke (T008 / R007.AC5)
//
// End-to-end smoke test for the Wave 2 token-cache stack. Spawns the actual
// PreToolUse and PostToolUse hook subprocesses against a fresh temp project
// dir (with a real git repo so HEAD pinning resolves) and asserts the full
// pipeline:
//
//   1. PreToolUse hook for an unseen command -> miss (allow execution).
//   2. PostToolUse hook for that command -> writes a cache entry.
//   3. PreToolUse hook for the same command -> hit (deny + cached output).
//
// Repeated for two cacheable commands -- one v1 pattern (`git status`) and one
// v2 pattern (`cat README.md`) -- so the smoke covers both the original v1
// surface and Wave 2's pattern broadening (R001).
//
// Cross-wave contract (this is the load-bearing assertion of T008):
//   The cache events emitted by the hooks (Wave 2 cache-stats.jsonl) must
//   surface via Wave 1's queryHeadlessState() under tokens.cache. We assert
//   that tokens.schema_version === 2 (Wave 1 R004 bump) AND tokens.cache.hits
//   matches the aggregator output for the same cache-stats.jsonl (Wave 2 R005).
//
// Kill-switch path:
//   With FORGE_TOKEN_OPT=0 set, the same workflow must NOT create
//   cache-stats.jsonl AND tokens.cache.hits must be 0. This proves T007's
//   end-to-end rollback contract holds when driven by real subprocesses
//   (not just the unit-level guards already covered in tool-cache-kill-
//   switch.test.cjs).
//
// Does NOT spawn real LLM agents or tasks. Hook subprocesses are pure node:*
// I/O over stdin/stdout, no API cost.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');
const { queryHeadlessState, aggregateCacheStats } = require('../scripts/forge-tools.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRE_HOOK = path.join(REPO_ROOT, 'hooks', 'tool-cache.js');
const POST_HOOK = path.join(REPO_ROOT, 'hooks', 'tool-cache-store.js');

// --- Temp-dir bookkeeping ---------------------------------------------------

const _tempDirs = [];
const _sessionIds = [];

function makeTempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-w2-smoke-'));
  _tempDirs.push(d);
  return d;
}

function freshSession(label) {
  const sid = label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  _sessionIds.push(sid);
  return sid;
}

function cacheDirFor(sessionId) {
  return path.join(os.tmpdir(), 'forge-tool-cache-' + sessionId);
}

process.on('exit', () => {
  for (const d of _tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  for (const sid of _sessionIds) {
    try { fs.rmSync(cacheDirFor(sid), { recursive: true, force: true }); } catch (_) {}
  }
});

// --- Project / git setup ---------------------------------------------------

function makeProjectWithGitRepo(prefix) {
  if (!gitAvailable()) return null;
  const proj = makeTempDir(prefix || 'forge-w2-smoke-proj-');
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 'Forge Test',
    GIT_AUTHOR_EMAIL: 'test@forge.local',
    GIT_COMMITTER_NAME: 'Forge Test',
    GIT_COMMITTER_EMAIL: 'test@forge.local',
  });
  function git(args) {
    const r = spawnSync('git', args, { cwd: proj, env, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || '').trim());
    }
    return (r.stdout || '').trim();
  }
  git(['init', '-q']);
  git(['config', 'user.email', 'test@forge.local']);
  git(['config', 'user.name', 'Forge Test']);
  // Seed a README so `cat README.md` has a real file to read.
  fs.writeFileSync(path.join(proj, 'README.md'), '# smoke fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(proj, '.forge'), { recursive: true });
  return proj;
}

// --- Hook spawn helpers ----------------------------------------------------

function spawnPre(payload, env, cwd) {
  // Strip inherited FORGE_TOKEN_OPT first so each test gets the env it asked for.
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [PRE_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign(baseEnv, env || {}),
  });
}

function spawnPost(payload, env, cwd) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.FORGE_TOKEN_OPT;
  return spawnSync(process.execPath, [POST_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: cwd || process.cwd(),
    env: Object.assign(baseEnv, env || {}),
  });
}

// --- Helpers ---------------------------------------------------------------

function readStatsLog(proj) {
  const p = path.join(proj, '.forge', 'cache-stats.jsonl');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function countNonEmptyLines(buf) {
  if (!buf) return 0;
  return buf.split('\n').filter(Boolean).length;
}

// Drive one full miss->write->hit cycle for a given Bash command. Returns
// { missResult, postResult, hitResult } so callers can assert per-step
// behavior. Uses the same session id throughout so the cache dir is shared.
function missWriteHit(opts) {
  const { command, output, sessionId, env, cwd } = opts;
  const toolInput = { command };

  const missResult = spawnPre(
    { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
    env, cwd
  );
  const postResult = spawnPost(
    {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_output: output,
      session_id: sessionId,
    },
    env, cwd
  );
  const hitResult = spawnPre(
    { tool_name: 'Bash', tool_input: toolInput, session_id: sessionId },
    env, cwd
  );
  return { missResult, postResult, hitResult };
}

// --- Tests -----------------------------------------------------------------

suite('Wave 2 token-cache smoke (R007.AC5)', () => {
  test('full miss -> write -> hit cycle for git status (v1 pattern)', () => {
    const proj = makeProjectWithGitRepo('w2-smoke-gitstat-');
    if (!proj) return; // git unavailable -- skip.
    const sid = freshSession('w2-smoke-gitstat');

    const r = missWriteHit({
      command: 'git status',
      output: 'on branch main\nnothing to commit\n',
      sessionId: sid,
      env: {},
      cwd: proj,
    });

    // Miss: hook exits 0 with no stdout (allow execution).
    assert.strictEqual(r.missResult.status, 0,
      'miss: pre-hook should exit 0');
    assert.strictEqual((r.missResult.stdout || '').trim(), '',
      'miss: pre-hook should produce no stdout (allow execution)');

    // Post-hook: writes cache entry, exits 0.
    assert.strictEqual(r.postResult.status, 0,
      'post-hook should exit 0');

    // Hit: hook returns a JSON deny result.
    assert.strictEqual(r.hitResult.status, 0,
      'hit: pre-hook should exit 0');
    const parsed = JSON.parse(r.hitResult.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny',
      'hit: must deny execution and serve cached output');
    assert.match(parsed.systemMessage || '', /Cached result/);
  });

  test('full miss -> write -> hit cycle for cat README.md (v2 pattern)', () => {
    const proj = makeProjectWithGitRepo('w2-smoke-catreadme-');
    if (!proj) return;
    const sid = freshSession('w2-smoke-catreadme');

    const r = missWriteHit({
      command: 'cat README.md',
      output: '# smoke fixture\n',
      sessionId: sid,
      env: {},
      cwd: proj,
    });

    assert.strictEqual((r.missResult.stdout || '').trim(), '',
      'cat README.md: miss expected on first call');
    assert.strictEqual(r.postResult.status, 0);

    const parsed = JSON.parse(r.hitResult.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny',
      'cat README.md: must hit on second call (proves v2 pattern broadening)');
  });

  test('5-event workflow produces 5 cache-stats lines and >= 3 hits', () => {
    // Spec scenario: `cat README.md` x3 + `git status` x2 -> at least 3 hits.
    // We model it as: miss, hit, hit (cat), miss, hit (git status). That's 3
    // hits across 5 total events.
    const proj = makeProjectWithGitRepo('w2-smoke-5event-');
    if (!proj) return;
    const sid = freshSession('w2-smoke-5event');

    // cat README.md -- miss, then write, then hit, then hit again.
    const cmdCat = 'cat README.md';
    const outCat = '# smoke fixture\n';
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: cmdCat }, session_id: sid },
      {}, proj
    ); // miss event 1
    spawnPost(
      { tool_name: 'Bash', tool_input: { command: cmdCat }, tool_output: outCat, session_id: sid },
      {}, proj
    );
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: cmdCat }, session_id: sid },
      {}, proj
    ); // hit event 2
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: cmdCat }, session_id: sid },
      {}, proj
    ); // hit event 3

    // git status -- miss, write, hit.
    const cmdGit = 'git status';
    const outGit = 'on branch main\n';
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: cmdGit }, session_id: sid },
      {}, proj
    ); // miss event 4
    spawnPost(
      { tool_name: 'Bash', tool_input: { command: cmdGit }, tool_output: outGit, session_id: sid },
      {}, proj
    );
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: cmdGit }, session_id: sid },
      {}, proj
    ); // hit event 5

    // 5 lookups -> 5 lines in cache-stats.jsonl.
    const buf = readStatsLog(proj);
    assert.ok(buf, 'cache-stats.jsonl must exist after a default-on workflow');
    const lineCount = countNonEmptyLines(buf);
    assert.strictEqual(lineCount, 5,
      `expected 5 cache-stats lines (one per pre-hook lookup), got ${lineCount}`);

    // Aggregator output: 3 hits, 2 misses.
    const stats = aggregateCacheStats(path.join(proj, '.forge'));
    assert.strictEqual(stats.hits, 3,
      `expected 3 hits across the 5-event workflow, got ${stats.hits}`);
    assert.strictEqual(stats.misses, 2,
      `expected 2 misses across the 5-event workflow, got ${stats.misses}`);
    assert.ok(stats.hits >= 3,
      'spec floor: tokens.cache.hits >= 3 after 5-event smoke');
  });

  test('cross-wave contract: queryHeadlessState surfaces cache.hits matching aggregator', () => {
    const proj = makeProjectWithGitRepo('w2-smoke-xwave-');
    if (!proj) return;
    const sid = freshSession('w2-smoke-xwave');

    // Run the same 5-event workflow.
    const events = [
      { kind: 'pre',  cmd: 'cat README.md' },
      { kind: 'post', cmd: 'cat README.md', out: '# smoke fixture\n' },
      { kind: 'pre',  cmd: 'cat README.md' },
      { kind: 'pre',  cmd: 'cat README.md' },
      { kind: 'pre',  cmd: 'git status' },
      { kind: 'post', cmd: 'git status', out: 'on branch main\n' },
      { kind: 'pre',  cmd: 'git status' },
    ];
    for (const e of events) {
      if (e.kind === 'pre') {
        spawnPre(
          { tool_name: 'Bash', tool_input: { command: e.cmd }, session_id: sid },
          {}, proj
        );
      } else {
        spawnPost(
          {
            tool_name: 'Bash',
            tool_input: { command: e.cmd },
            tool_output: e.out,
            session_id: sid,
          },
          {}, proj
        );
      }
    }

    // queryHeadlessState() reads from the project's .forge dir.
    const snap = queryHeadlessState(path.join(proj, '.forge'));

    // Cross-wave contract surfaces:
    //   1. tokens block exists at all (Wave 1 R004 added it).
    //   2. tokens.schema_version === 2 (Wave 1 R004 bump).
    //   3. tokens.cache.hits matches aggregator output (Wave 2 R005 wire-up).
    assert.ok(snap.tokens && typeof snap.tokens === 'object',
      'queryHeadlessState must surface a tokens block (Wave 1 contract)');
    assert.strictEqual(snap.tokens.schema_version, 2,
      'tokens.schema_version must be 2 (Wave 1 R004 bump)');
    assert.ok(snap.tokens.cache && typeof snap.tokens.cache === 'object',
      'tokens.cache block must be present (Wave 2 R005)');

    const direct = aggregateCacheStats(path.join(proj, '.forge'));
    assert.strictEqual(snap.tokens.cache.hits, direct.hits,
      'tokens.cache.hits must equal aggregateCacheStats(...).hits');
    assert.strictEqual(snap.tokens.cache.misses, direct.misses,
      'tokens.cache.misses must equal aggregateCacheStats(...).misses');
    assert.strictEqual(snap.tokens.cache.savings_estimate_tokens,
      direct.savings_estimate_tokens,
      'tokens.cache.savings_estimate_tokens must equal aggregator output');

    // Spec floor: at least 3 hits surface to the headless snapshot.
    assert.ok(snap.tokens.cache.hits >= 3,
      `headless snapshot must surface tokens.cache.hits >= 3; got ${snap.tokens.cache.hits}`);
  });

  test('FORGE_TOKEN_OPT=0: same workflow produces no stats log and zero hits', () => {
    const proj = makeProjectWithGitRepo('w2-smoke-killswitch-');
    if (!proj) return;
    const sid = freshSession('w2-smoke-killswitch');

    // Same 5-event workflow, but with FORGE_TOKEN_OPT=0 on every spawn.
    const env = { FORGE_TOKEN_OPT: '0' };
    const events = [
      { kind: 'pre',  cmd: 'git status' },
      { kind: 'post', cmd: 'git status', out: 'on branch main\n' },
      { kind: 'pre',  cmd: 'git status' },
      { kind: 'pre',  cmd: 'git status' },
      { kind: 'pre',  cmd: 'git status' },
    ];
    for (const e of events) {
      if (e.kind === 'pre') {
        spawnPre(
          { tool_name: 'Bash', tool_input: { command: e.cmd }, session_id: sid },
          env, proj
        );
      } else {
        spawnPost(
          {
            tool_name: 'Bash',
            tool_input: { command: e.cmd },
            tool_output: e.out,
            session_id: sid,
          },
          env, proj
        );
      }
    }

    // Stats log must NOT exist under env=0.
    const buf = readStatsLog(proj);
    assert.strictEqual(buf, null,
      'cache-stats.jsonl must NOT be created when FORGE_TOKEN_OPT=0 across the entire workflow');

    // queryHeadlessState surfaces zero cache hits even though the cache itself
    // worked (entries are still served on disk; we just don't count them in
    // the aggregator under env=0).
    const prev = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const snap = queryHeadlessState(path.join(proj, '.forge'));
      assert.strictEqual(snap.tokens.cache.hits, 0,
        'tokens.cache.hits must be 0 under FORGE_TOKEN_OPT=0');
      assert.strictEqual(snap.tokens.cache.misses, 0,
        'tokens.cache.misses must be 0 under FORGE_TOKEN_OPT=0');
      assert.strictEqual(snap.tokens.cache.savings_estimate_tokens, 0,
        'tokens.cache.savings_estimate_tokens must be 0 under FORGE_TOKEN_OPT=0');
    } finally {
      if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prev;
    }
  });

  test('cross-wave: tokens.cache fields are well-typed numbers, not undefined', () => {
    // Belt-and-braces shape check so a future refactor that accidentally drops
    // the cache field from queryHeadlessState (or breaks its typing) trips
    // here loud and early.
    const proj = makeProjectWithGitRepo('w2-smoke-shape-');
    if (!proj) return;
    const sid = freshSession('w2-smoke-shape');

    // One miss-then-write so cache-stats.jsonl exists.
    spawnPre(
      { tool_name: 'Bash', tool_input: { command: 'git status' }, session_id: sid },
      {}, proj
    );
    spawnPost(
      {
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_output: 'on branch main\n',
        session_id: sid,
      },
      {}, proj
    );

    const snap = queryHeadlessState(path.join(proj, '.forge'));
    assert.strictEqual(typeof snap.tokens.cache.hits, 'number');
    assert.strictEqual(typeof snap.tokens.cache.misses, 'number');
    assert.strictEqual(typeof snap.tokens.cache.savings_estimate_tokens, 'number');
    assert.ok(Number.isFinite(snap.tokens.cache.hits));
    assert.ok(Number.isFinite(snap.tokens.cache.misses));
    assert.ok(Number.isFinite(snap.tokens.cache.savings_estimate_tokens));
    assert.ok(snap.tokens.cache.hits >= 0);
    assert.ok(snap.tokens.cache.misses >= 0);
    assert.ok(snap.tokens.cache.savings_estimate_tokens >= 0);
  });
});

runTests();
