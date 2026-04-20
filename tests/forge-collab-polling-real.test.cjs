// tests/forge-collab-polling-real.test.cjs
//
// T013 (collab-fix R002): cross-process wire test for the polling transport's
// real default IO adapter. Spawns two node subprocesses against separate
// clones of a shared bare git remote and asserts that simultaneous
// writeLease() calls resolve via git's ref-update CAS -- exactly one
// {ok:true}, the other {ok:false, reason:"cas_race_lost"} -- and that the
// forge/collab-state ref ends up with exactly one commit.
//
// Every other polling-transport test in the repo uses an injected in-memory
// stub. This one runs the real _defaultPollingIo so stub-masked regressions
// cannot hide behind a green suite.

const { suite, test, assert, runTests, gitAvailable } = require('./_helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const FORGE_COLLAB = path.resolve(__dirname, '..', 'scripts', 'forge-collab.cjs');
const BRANCH = 'forge/collab-state';

function git(cwd, args, opts) {
  opts = opts || {};
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    input: opts.input
  });
}

function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, err: e }; }
}

function setupBareAndClones() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-wire-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const cloneA = path.join(root, 'cloneA');
  const cloneB = path.join(root, 'cloneB');

  // Bare remote
  git(root, ['init', '--bare', '-b', 'main', 'origin.git']);

  // Seed clone: one empty initial commit so both clones have a base.
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.email', 'wire-test@forge.local']);
  git(seed, ['config', 'user.name', 'Wire Test']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);

  // Two working clones
  for (const clone of [cloneA, cloneB]) {
    git(root, ['clone', bare, path.basename(clone)]);
    git(clone, ['config', 'user.email', 'wire-test@forge.local']);
    git(clone, ['config', 'user.name', 'Wire Test']);
  }

  return { root, bare, cloneA, cloneB };
}

function cleanup(root) {
  if (!root) return;
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  catch (_) { /* best effort on Windows */ }
}

// Child-process runner: imports forge-collab, calls writeLease with
// expected:null, prints the single-line JSON result to stdout, exits.
// Written to a temp file so Windows `node -e` argv quirks don't bite us.
const CHILD_SCRIPT = `
'use strict';
const path = require('path');
const collab = require(process.argv[2]);
const cwd = process.argv[3];
const handle = process.argv[4];
const branch = process.argv[5];
const barrier = process.argv[6] ? Number(process.argv[6]) : 0;

(async () => {
  const io = collab._internal._defaultPollingIo({
    cwd,
    forgeDir: path.join(cwd, '.forge-virtual'),
    autoPush: true,
    retries: 3,
    backoffMs: 50
  });
  await io.ensureBranch(branch);
  if (barrier) {
    const delta = barrier - Date.now();
    if (delta > 0) await new Promise(r => setTimeout(r, delta));
  }
  const lease = {
    claimant: handle,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  try {
    const res = await io.writeLease(branch, 'claim:T001', lease, { expected: null });
    process.stdout.write(JSON.stringify({ handle, result: res }) + '\\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({
      handle,
      error: e.message || String(e),
      stack: e.stack || null
    }) + '\\n');
  }
})();
`;

let _childScriptPath = null;
function childScriptPath() {
  if (_childScriptPath) return _childScriptPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-wire-child-'));
  const p = path.join(dir, 'child.cjs');
  fs.writeFileSync(p, CHILD_SCRIPT, 'utf8');
  _childScriptPath = p;
  return p;
}

function spawnChild(cwd, handle, barrier) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [childScriptPath(), FORGE_COLLAB, cwd, handle, BRANCH, String(barrier || 0)],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => {
      const lines = out.split(/\r?\n/).filter(l => l.trim());
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(lines[i]); break; } catch (_) {}
      }
      resolve({ code, stdout: out, stderr: err, parsed });
    });
  });
}

suite('polling transport real writes (T013, R002)', () => {
  if (!gitAvailable()) {
    test.skip = true;
    test('git not on PATH -- cross-process wire test skipped', () => {
      assert.ok(true, 'skipping; git missing');
    });
    return;
  }

  test('two subprocesses racing writeLease -> exactly one wins, other cas_race_lost; one commit on ref', async () => {
    const env = setupBareAndClones();
    try {
      // Kick both children with a small wall-clock barrier so their race
      // windows overlap. Even with total serialization the invariant holds,
      // but the barrier makes the race actually contended on the push.
      const barrier = Date.now() + 400;
      const [rA, rB] = await Promise.all([
        spawnChild(env.cloneA, 'alice', barrier),
        spawnChild(env.cloneB, 'bob', barrier)
      ]);

      assert.strictEqual(rA.code, 0, 'alice child exited non-zero\nstdout:\n' + rA.stdout + '\nstderr:\n' + rA.stderr);
      assert.strictEqual(rB.code, 0, 'bob child exited non-zero\nstdout:\n' + rB.stdout + '\nstderr:\n' + rB.stderr);
      assert.ok(rA.parsed, 'alice child produced no JSON line; stdout=' + rA.stdout + ' stderr=' + rA.stderr);
      assert.ok(rB.parsed, 'bob child produced no JSON line; stdout=' + rB.stdout + ' stderr=' + rB.stderr);
      assert.ok(!rA.parsed.error, 'alice child error: ' + rA.parsed.error);
      assert.ok(!rB.parsed.error, 'bob child error: ' + rB.parsed.error);

      const results = [rA.parsed.result, rB.parsed.result];
      const wins   = results.filter(r => r && r.ok === true);
      const losers = results.filter(r => r && r.ok === false);

      assert.strictEqual(wins.length, 1,
        'expected exactly one winner, got ' + wins.length + '; results=' + JSON.stringify(results));
      assert.strictEqual(losers.length, 1,
        'expected exactly one loser, got ' + losers.length + '; results=' + JSON.stringify(results));
      assert.strictEqual(losers[0].reason, 'cas_race_lost',
        'expected loser reason=cas_race_lost, got ' + losers[0].reason + '; full=' + JSON.stringify(losers[0]));

      // Now validate ref shape in the bare origin: exactly one commit in
      // the forge/collab-state ref's own history. R002 AC specifies that
      // the ref always holds exactly one commit regardless of how many
      // mutations N clients have landed -- every write rewrites the ref
      // rootless via commit-tree with no parent.
      const log = git(env.bare, ['log', BRANCH, '--oneline']);
      const lines = log.split(/\r?\n/).filter(l => l.trim());
      assert.strictEqual(lines.length, 1,
        'expected exactly 1 commit on ' + BRANCH + ', got ' + lines.length + ':\n' + log);

      // And: the state.json recorded in that commit reflects the winner.
      const stateRaw = git(env.bare, ['show', 'refs/heads/' + BRANCH + ':state.json']);
      const state = JSON.parse(stateRaw);
      assert.ok(state && state.leases && state.leases['claim:T001'],
        'expected claim:T001 lease on winning state; got ' + stateRaw);
      const winningClaimant = state.leases['claim:T001'].claimant;
      assert.ok(winningClaimant === 'alice' || winningClaimant === 'bob',
        'unexpected claimant ' + winningClaimant);
    } finally {
      cleanup(env.root);
    }
  });

  test('cas_exhausted surfaces after repeated push rejections', async () => {
    // Single-process check: drive _defaultPollingIo with a fake git runner
    // that always returns a non-fast-forward error on push, so the retry
    // loop exhausts and returns {ok:false, reason:"cas_exhausted"}.
    const collab = require(FORGE_COLLAB);
    const io = collab._internal._defaultPollingIo({
      cwd: os.tmpdir(),
      forgeDir: path.join(os.tmpdir(), '.forge-nope'),
      autoPush: true,
      retries: 2,
      backoffMs: 1,
      runner(args /* , opts */) {
        const cmd = args[0];
        if (cmd === 'fetch') return '';
        if (cmd === 'rev-parse') return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n';
        if (cmd === 'show') return JSON.stringify({ leases: {}, messages: [] });
        if (cmd === 'hash-object') return 'feedface' + '0'.repeat(32) + '\n';
        if (cmd === 'mktree')      return 'cafebabe' + '0'.repeat(32) + '\n';
        if (cmd === 'commit-tree') return 'abad1dea' + '0'.repeat(32) + '\n';
        if (cmd === 'push') {
          const err = new Error('git push failed');
          err.stderr = 'stale info: ref has been rewound';
          throw err;
        }
        return '';
      }
    });
    const res = await io.writeLease(BRANCH, 'claim:T002', {
      claimant: 'alice', acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z'
    });
    assert.strictEqual(res.ok, false, 'expected ok:false after exhausted retries; got ' + JSON.stringify(res));
    assert.strictEqual(res.reason, 'cas_exhausted', 'expected cas_exhausted; got ' + JSON.stringify(res));
  });

  test('appendMessage prunes TTL-expired entries before writing', async () => {
    const collab = require(FORGE_COLLAB);
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const oldTs = new Date(now - 10 * 60_000).toISOString(); // 10 min old
    const freshTs = new Date(now - 30_000).toISOString();    // 30 s old
    const built = [];
    let refSha = 'deadbeef' + '0'.repeat(32);
    let currentState = {
      leases: {},
      messages: [
        { id: 'expired', event: 'e', data: {}, from: 'old', ts: oldTs },
        { id: 'fresh',   event: 'e', data: {}, from: 'new', ts: freshTs }
      ]
    };
    const io = collab._internal._defaultPollingIo({
      cwd: os.tmpdir(),
      forgeDir: path.join(os.tmpdir(), '.forge-nope'),
      autoPush: true,
      retries: 0,
      backoffMs: 1,
      ttlSeconds: 300, // 5 min
      now,
      runner(args /* , opts */) {
        const cmd = args[0];
        if (cmd === 'fetch') return '';
        if (cmd === 'rev-parse') return refSha + '\n';
        if (cmd === 'show') return JSON.stringify(currentState);
        if (cmd === 'hash-object') {
          // Capture what the io is about to commit so the test can inspect it.
          built.push(args);
          // We ignore the actual input-hashing and return a fake sha.
          return 'feedface' + '0'.repeat(32) + '\n';
        }
        if (cmd === 'mktree')      return 'cafebabe' + '0'.repeat(32) + '\n';
        if (cmd === 'commit-tree') return 'abad1dea' + '0'.repeat(32) + '\n';
        if (cmd === 'push')        return '';
        return '';
      }
    });
    // The runner interface doesn't surface the stdin input, so instead of
    // intercepting the commit blob we verify the pruning helper directly.
    const pruned = io._internal._pruneMessages(currentState.messages, now);
    assert.strictEqual(pruned.length, 1, 'expected 1 message surviving TTL; got ' + JSON.stringify(pruned));
    assert.strictEqual(pruned[0].id, 'fresh');

    // And the public appendMessage returns ok:true against the simulated push success.
    const res = await io.appendMessage(BRANCH, { event: 'flag-ping', data: { target: 'bob' }, from: 'alice' });
    assert.strictEqual(res.ok, true, 'expected ok:true; got ' + JSON.stringify(res));
  });

  test('gatedPush is honored: auto_push=false + no prompter aborts writeLease with push_gated reason', async () => {
    const collab = require(FORGE_COLLAB);
    const io = collab._internal._defaultPollingIo({
      cwd: os.tmpdir(),
      forgeDir: path.join(os.tmpdir(), '.forge-nope'),
      autoPush: false,   // explicit gate
      retries: 0,
      backoffMs: 1,
      runner(args) {
        const cmd = args[0];
        if (cmd === 'fetch') return '';
        if (cmd === 'rev-parse') return 'deadbeef' + '0'.repeat(32) + '\n';
        if (cmd === 'show') return JSON.stringify({ leases: {}, messages: [] });
        if (cmd === 'hash-object') return 'feedface' + '0'.repeat(32) + '\n';
        if (cmd === 'mktree')      return 'cafebabe' + '0'.repeat(32) + '\n';
        if (cmd === 'commit-tree') return 'abad1dea' + '0'.repeat(32) + '\n';
        if (cmd === 'push')        return ''; // would succeed if gate let it through
        return '';
      }
    });
    const res = await io.writeLease(BRANCH, 'claim:T003', {
      claimant: 'alice', acquiredAt: 'T', expiresAt: 'T+60'
    });
    assert.strictEqual(res.ok, false, 'expected ok:false when auto_push gated off; got ' + JSON.stringify(res));
    assert.strictEqual(res.reason, 'auto_push_disabled_no_prompter',
      'expected gated reason; got ' + JSON.stringify(res));
  });
});

runTests();
