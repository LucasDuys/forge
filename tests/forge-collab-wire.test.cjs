// tests/forge-collab-wire.test.cjs
//
// T026 (collab-fix R006): full cross-process wire test covering the real
// adapters end-to-end. Spawns two node subprocesses against two clones of
// a shared bare git remote and drives the polling transport with the
// default IO adapter -- no injected stubs, no mocks, real git plumbing.
//
// This is the integration test that all prior collab tests lacked. Every
// other collab test in the repo either (a) injects an in-memory IO stub
// (tests/forge-collab.test.cjs, forge-collab-bounded-queue.test.cjs,
// forge-collab-target-filter.test.cjs, forge-collab-ably-cas.test.cjs) or
// (b) races two subprocesses on a single API (forge-collab-polling-real
// only exercises writeLease CAS). None of them run a realistic alice/bob
// flow -- brainstorm -> claim -> flag-ping -> read-on-the-other-side.
//
// Scenario:
//   1. Bare remote + two clones (alice, bob) under os.tmpdir().
//   2. Alice subprocess:
//      - brainstormDump to .forge/collab/brainstorm/inputs-lucas.md
//      - git add + commit + push that artifact to origin/main
//      - connect polling transport with clientId='lucas' -> claimTask T001
//        (writes to forge/collab-state on origin via writeLease)
//      - writeForwardMotionFlag with source_contributors=['sarah']; the
//        flag write also sendTargeted's a flag-ping addressed to sarah
//        (writes to forge/collab-state as a queued message).
//   3. Bob subprocess (as 'sarah'):
//      - git pull origin main -> alice's inputs-lucas.md appears
//      - assert inputs file exists
//      - connect polling transport with clientId='sarah'
//      - claimTask T001 as 'sarah' -> asserts acquired:false,
//        reason:'held_by_lucas' (R006 AC).
//      - subscribe('flag-ping', ...) with clientId='sarah', then _refresh()
//        to pull down the message alice published.
//      - assert >=1 message received (R004 target filter lets this through
//        because target==='sarah').
//   4. Test level asserts:
//      - both subprocesses exited 0.
//      - origin's forge/collab-state branch has exactly 1 commit (T013 /
//        R002 invariant preserved even under brainstorm+claim+flag load).
//      - .forge/collab/brainstorm/inputs-lucas.md exists in bob's clone.
//      - bob's child reported >=1 flag-ping received and 0 non-target
//        messages (R004 target filter).
//   5. Cleanup removes temp dirs on every exit path, including failure.

const { suite, test, assert, runTests, gitAvailable } = require('./_helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const FORGE_COLLAB = path.resolve(__dirname, '..', 'scripts', 'forge-collab.cjs');
const STATE_BRANCH = 'forge/collab-state';
const TEST_TIMEOUT_MS = 30_000;

function git(cwd, args, opts) {
  opts = opts || {};
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    input: opts.input
  });
}

function setupBareAndClones() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-wire-t026-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const alice = path.join(root, 'alice');
  const bob = path.join(root, 'bob');

  // Bare remote with `main` as the initial branch.
  git(root, ['init', '--bare', '-b', 'main', 'origin.git']);

  // Seed: one empty initial commit so the clones have a base ref.
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.email', 'wire-test@forge.local']);
  git(seed, ['config', 'user.name', 'Wire Test']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# forge-collab wire test seed\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);

  // Two working clones -- alice and bob.
  for (const clone of [alice, bob]) {
    git(root, ['clone', bare, path.basename(clone)]);
    git(clone, ['config', 'user.email', 'wire-test@forge.local']);
    git(clone, ['config', 'user.name', 'Wire Test']);
    // Seed .forge/collab scaffold in each clone. Both clones need the
    // directory to exist locally even before alice commits content; the
    // polling transport writes via its own branch, not main.
    fs.mkdirSync(path.join(clone, '.forge', 'collab'), { recursive: true });
  }

  return { root, bare, alice, bob };
}

function cleanup(root) {
  if (!root) return;
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  catch (_) { /* best effort on Windows */ }
}

// --- alice's child script: brainstorm -> commit/push -> claim -> flag -> targeted ping
//
// Prints one final JSON line to stdout so the parent can inspect outcome:
//   { role:'alice', brainstormed:<path>, claimed:{...}, flagWritten:<bool>, flagId, notified:{mode,target}, error?:string }
const ALICE_SCRIPT = `
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const collab = require(process.argv[2]);
const cwd = process.argv[3];
const handle = process.argv[4];

function g(args, input) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    input: input
  });
}

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

(async () => {
  try {
    const collabDir = path.join(cwd, '.forge', 'collab');

    // 1. brainstormDump: write per-user inputs markdown.
    const inputsPath = collab.brainstormDump(collabDir, handle, [
      '# Lucas brainstorm',
      '',
      'Use redis pubsub for the flag queue. Alternatively nats jetstream.',
      ''
    ].join('\\n'), { timestamp: '2026-04-20T10:00:00.000Z' });

    // 2. git add + commit + push the brainstorm artifact on main.
    // The R001 gitignore carve-out lets .forge/collab/ escape the
    // default .forge/ ignore; we add the file explicitly (-f is also
    // safe in case some clones don't have the carve-out applied).
    g(['add', '-f', path.relative(cwd, inputsPath)]);
    g(['commit', '-m', 'alice: brainstorm dump']);
    g(['push', 'origin', 'main']);

    // 3. Polling transport for lease/msg state on forge/collab-state.
    const transport = collab.createPollingTransport({
      cwd,
      forgeDir: path.join(cwd, '.forge'),
      autoPush: true,
      clientId: handle,
      retries: 3,
      backoffMs: 50,
      intervalMs: 60_000 // disable auto-poll chatter; we call _refresh() manually
    });
    await transport.connect();
    // Give the write-through time to settle: claimTask -> transport.cas()
    // which writes locally and fires io.writeLease() asynchronously.
    const claimed = collab.claimTask(transport, 'T001', handle, { ttlSeconds: 120 });
    // Wait for the async writeLease to finish before proceeding so bob
    // sees alice's lease on his fetch. 300ms is a generous upper bound
    // for the fetch+hash-object+mktree+commit-tree+push cycle locally.
    await new Promise(r => setTimeout(r, 300));
    // Round-trip _refresh to confirm our own claim is visible on origin.
    await transport._internal._refresh();

    // 4. writeForwardMotionFlag during executing phase, source_contributors=['sarah']
    //    -- routes to sarah and fires sendTargeted('flag-ping') via transport.
    // sarah's contributions must share at least one token with the flag
    // decision text so the heuristic scorer scores her > 0. Without token
    // overlap routeToParticipant falls back to broadcast, which breaks
    // the R015/R006 targeted flag-ping guarantee we want to verify.
    const participants = [
      { handle: 'lucas', contributions: 'chose redis pubsub for queue', active_tasks: 0 },
      { handle: 'sarah', contributions: 'redis stack already in place', active_tasks: 0 }
    ];
    const flag = await collab.writeForwardMotionFlag({
      phase: 'executing',
      collabDir,
      task_id: 'T001',
      author: handle,
      decision: 'redis',
      alternatives: ['nats'],
      rationale: 'already in our stack',
      source_contributors: ['sarah'],
      participants,
      transport
    });

    // Let the flag's sendTargeted write-through settle on origin too.
    await new Promise(r => setTimeout(r, 300));

    // 5. Commit + push any remaining collab artifacts (flag doc, logs).
    //    flag-emit-log-<handle>.jsonl is gitignored per R001, so we
    //    stage the flag doc explicitly.
    try {
      const flagRel = path.relative(cwd, flag.path);
      g(['add', '-f', flagRel]);
      g(['commit', '-m', 'alice: flag T001 decision=redis']);
      g(['push', 'origin', 'main']);
    } catch (e) {
      // If there was nothing to commit (shouldn't happen here, but be
      // defensive), surface it in the result rather than crashing.
    }

    await transport.disconnect();

    out({
      role: 'alice',
      brainstormed: inputsPath,
      claimed: claimed,
      flagWritten: flag.written,
      flagId: flag.id,
      notified: flag.notified
    });
    process.exit(0);
  } catch (e) {
    out({ role: 'alice', error: e && (e.message || String(e)), stack: e && e.stack });
    process.exit(1);
  }
})();
`;

// --- bob's child script: pull -> read inputs -> try-claim -> subscribe -> refresh
//
// Prints one final JSON line to stdout:
//   { role:'bob', inputsFileFound:<bool>, inputsBody:<string-prefix>,
//     claimAttempt:{acquired,reason,...}, pings:[{event,data,from}...],
//     nonTargetDelivered:<bool>, error?:string }
const BOB_SCRIPT = `
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const collab = require(process.argv[2]);
const cwd = process.argv[3];
const handle = process.argv[4];

function g(args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
}

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

(async () => {
  try {
    const collabDir = path.join(cwd, '.forge', 'collab');

    // 1. Pick up alice's brainstorm commit from origin/main.
    g(['pull', 'origin', 'main', '--ff-only']);

    // 2. Read inputs-lucas.md via the public readAllInputs() surface.
    const inputsPath = path.join(collabDir, 'brainstorm', 'inputs-lucas.md');
    const inputsFileFound = fs.existsSync(inputsPath);
    let inputsBody = '';
    if (inputsFileFound) {
      const all = collab.readAllInputs(collabDir);
      const lucas = all.find(x => x.handle === 'lucas');
      inputsBody = lucas ? String(lucas.body || '').slice(0, 200) : '';
    }

    // 3. Polling transport as 'sarah'. intervalMs high so only our
    //    explicit _refresh calls drive state.
    const transport = collab.createPollingTransport({
      cwd,
      forgeDir: path.join(cwd, '.forge'),
      autoPush: true,
      clientId: handle,
      retries: 3,
      backoffMs: 50,
      intervalMs: 60_000
    });

    // 4. Register subscribers BEFORE connect(). The polling transport
    //    fires _refresh() eagerly during connect() and marks incoming
    //    messages as seen in its per-process dedupe Set; a subscriber
    //    registered after connect() would miss every message already
    //    on origin. Standard pub/sub idiom anyway.
    //
    //    R004 target filter: messages with data.target===handle go to
    //    the sarah-scoped callback; non-target subscribers on the same
    //    transport must receive zero invocations for that message.
    const pings = [];
    let nonTargetDelivered = false;
    transport.subscribe('flag-ping', (env) => {
      pings.push({ event: env.event, data: env.data, from: env.from });
    }, { clientId: handle });
    transport.subscribe('flag-ping', (env) => {
      // Anything delivered here is a target-filter leak: the message
      // carries target==='sarah' and this subscriber is scoped to a
      // different clientId.
      if (env && env.data && env.data.target) nonTargetDelivered = true;
    }, { clientId: 'someone-else' });

    await transport.connect(); // ensureBranch fetches forge/collab-state + _refresh

    // 5. Try to claim T001 -- alice should already hold it.
    const claimAttempt = collab.claimTask(transport, 'T001', handle, { ttlSeconds: 120 });

    // 6. If connect()'s _refresh already delivered the ping we're done;
    //    otherwise retry a few times in case alice's appendMessage push
    //    hadn't fully propagated at connect time (on CI, slower disks).
    let attempts = 0;
    while (pings.length === 0 && attempts < 10) {
      attempts++;
      await transport._internal._refresh();
      if (pings.length === 0) await new Promise(r => setTimeout(r, 200));
    }

    await transport.disconnect();

    out({
      role: 'bob',
      inputsFileFound,
      inputsBodyPrefix: inputsBody,
      claimAttempt,
      pings,
      nonTargetDelivered,
      refreshAttempts: attempts
    });
    process.exit(0);
  } catch (e) {
    out({ role: 'bob', error: e && (e.message || String(e)), stack: e && e.stack });
    process.exit(1);
  }
})();
`;

function writeChildScript(content, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collab-wire-child-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function spawnChild(scriptPath, cwd, handle) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [scriptPath, FORGE_COLLAB, cwd, handle],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const kill = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ code: -1, stdout, stderr, parsed: null, timedOut: true });
    };
    // Per-child wall-clock safety: even though the suite has its own
    // overall 30s ceiling, we cap each child at ~25s so the parent has
    // room to run assertions + cleanup.
    const hardTimer = setTimeout(kill, 25_000);
    if (hardTimer.unref) hardTimer.unref();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      const lines = stdout.split(/\r?\n/).filter(l => l.trim());
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(lines[i]); break; } catch (_) {}
      }
      resolve({ code, stdout, stderr, parsed, timedOut: false });
    });
  });
}

suite('cross-process wire test, real adapters (T026, R006)', () => {
  if (!gitAvailable()) {
    test('git not on PATH -- wire test skipped', () => {
      assert.ok(true, 'skipping; git missing');
    });
    return;
  }

  test('alice brainstorm+claim+flag pushes; bob pulls and sees everything end-to-end', async () => {
    const env = setupBareAndClones();
    const aliceScript = writeChildScript(ALICE_SCRIPT, 'alice.cjs');
    const bobScript = writeChildScript(BOB_SCRIPT, 'bob.cjs');

    // Overall suite-level safety -- if either child is stuck we still
    // fail the assertion rather than hanging the whole runner.
    let suiteTimedOut = false;
    const suiteTimer = setTimeout(() => { suiteTimedOut = true; }, TEST_TIMEOUT_MS);
    if (suiteTimer.unref) suiteTimer.unref();

    try {
      // Phase 1: alice must finish before bob starts. bob's polling
      // transport fetches at connect() time; if alice is still pushing
      // we get a race against the fetch. Serializing keeps the test
      // deterministic and still exercises real cross-process git wire.
      const rAlice = await spawnChild(aliceScript, env.alice, 'lucas');

      assert.strictEqual(rAlice.code, 0,
        'alice child exited non-zero (code=' + rAlice.code + ', timedOut=' + rAlice.timedOut + ')' +
        '\nstdout:\n' + rAlice.stdout + '\nstderr:\n' + rAlice.stderr);
      assert.ok(rAlice.parsed, 'alice produced no JSON line; stdout=' + rAlice.stdout);
      assert.ok(!rAlice.parsed.error, 'alice error: ' + rAlice.parsed.error + '\nstack: ' + rAlice.parsed.stack);
      assert.ok(rAlice.parsed.claimed && rAlice.parsed.claimed.acquired === true,
        'alice should have acquired T001; got ' + JSON.stringify(rAlice.parsed.claimed));
      assert.strictEqual(rAlice.parsed.flagWritten, true,
        'alice should have written the forward-motion flag');
      assert.ok(rAlice.parsed.notified && rAlice.parsed.notified.mode === 'targeted',
        'alice flag-ping should be targeted; got ' + JSON.stringify(rAlice.parsed.notified));
      assert.strictEqual(rAlice.parsed.notified.target, 'sarah',
        'target should be sarah (sole source_contributor); got ' + rAlice.parsed.notified.target);

      // Phase 2: bob pulls main (alice's brainstorm commit) and then
      // fetches forge/collab-state via the polling transport.
      const rBob = await spawnChild(bobScript, env.bob, 'sarah');

      assert.strictEqual(rBob.code, 0,
        'bob child exited non-zero (code=' + rBob.code + ', timedOut=' + rBob.timedOut + ')' +
        '\nstdout:\n' + rBob.stdout + '\nstderr:\n' + rBob.stderr);
      assert.ok(rBob.parsed, 'bob produced no JSON line; stdout=' + rBob.stdout);
      assert.ok(!rBob.parsed.error, 'bob error: ' + rBob.parsed.error + '\nstack: ' + rBob.parsed.stack);

      // R006 AC: inputs-lucas.md reached bob's clone via git pull.
      assert.strictEqual(rBob.parsed.inputsFileFound, true,
        'inputs-lucas.md should exist in bob clone after pull; body=' + rBob.parsed.inputsBodyPrefix);
      assert.ok(/redis pubsub/.test(rBob.parsed.inputsBodyPrefix || ''),
        'inputs-lucas.md should contain alice brainstorm content; got: ' + rBob.parsed.inputsBodyPrefix);

      // R006 AC: bob's claim attempt is rejected with reason=held_by_lucas.
      assert.ok(rBob.parsed.claimAttempt, 'bob claim result missing');
      assert.strictEqual(rBob.parsed.claimAttempt.acquired, false,
        'bob should NOT acquire T001 (held by lucas); got ' + JSON.stringify(rBob.parsed.claimAttempt));
      assert.strictEqual(rBob.parsed.claimAttempt.reason, 'held_by_lucas',
        'bob claim reason should be held_by_lucas; got ' + JSON.stringify(rBob.parsed.claimAttempt));

      // R006 AC: bob received the targeted flag-ping (>=1 message) and
      // R004 target filter suppressed delivery to the 'someone-else'
      // subscriber on the same transport.
      assert.ok(Array.isArray(rBob.parsed.pings), 'bob pings should be an array');
      assert.ok(rBob.parsed.pings.length >= 1,
        'bob should have received >=1 flag-ping; got ' + JSON.stringify(rBob.parsed.pings) +
        ' (refreshAttempts=' + rBob.parsed.refreshAttempts + ')');
      assert.strictEqual(rBob.parsed.pings[0].event, 'flag-ping');
      assert.strictEqual(rBob.parsed.pings[0].data && rBob.parsed.pings[0].data.task_id, 'T001');
      assert.strictEqual(rBob.parsed.pings[0].data && rBob.parsed.pings[0].data.target, 'sarah',
        'ping envelope should carry target=sarah');
      assert.strictEqual(rBob.parsed.nonTargetDelivered, false,
        'R004 target filter: non-sarah subscriber must receive zero messages');

      // Test-level invariant: R002 guarantees forge/collab-state always
      // holds exactly 1 commit regardless of how many mutations landed
      // (brainstorm write + claim lease + flag message = 2 collab-state
      // pushes from alice plus the ensureBranch seed, all collapsed).
      const stateLog = git(env.bare, ['log', STATE_BRANCH, '--oneline']);
      const commits = stateLog.split(/\r?\n/).filter(l => l.trim());
      assert.strictEqual(commits.length, 1,
        'forge/collab-state must hold exactly 1 commit after alice writes; got ' +
        commits.length + ':\n' + stateLog);

      assert.strictEqual(suiteTimedOut, false,
        'wire test should complete within ' + TEST_TIMEOUT_MS + 'ms');
    } finally {
      clearTimeout(suiteTimer);
      cleanup(env.root);
      // Clean up child-script temp dirs too.
      try { fs.rmSync(path.dirname(aliceScript), { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(path.dirname(bobScript), { recursive: true, force: true }); } catch (_) {}
    }
  });
});

runTests();
