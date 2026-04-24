#!/usr/bin/env node
// tests/collab-polling-branch.test.cjs
//
// Regression test for forge-self-fixes-2 R011. lateJoinBootstrap used to
// hardcode `git pull origin main`, which fails on any repo whose default
// branch is `master` (or anything else). The 2026-04-22 Tier-2 collab
// test surfaced this when the Daisy subagent joined a master-branch
// origin and got `{joined:false, reason:'git_pull_failed', error:"fatal:
// couldn't find remote ref main"}`.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const cp = require('node:child_process');

const { lateJoinBootstrap, _resolvePollingBranch, createMemoryTransport } = require('../scripts/forge-collab.cjs');

function mktmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function run(cmd, args, cwd) {
  return cp.execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// Test 1: _resolvePollingBranch returns the repo's actual default branch,
// not a hardcoded value. Uses a stub runner so the test is deterministic.
// ---------------------------------------------------------------------------
function testResolveFromSymbolicRef() {
  const stubRunner = (args) => {
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return 'origin/master\n';
    }
    throw new Error('not called');
  };
  const branch = _resolvePollingBranch({ runner: stubRunner, cwd: '/nowhere' });
  assert.strictEqual(branch, 'master', 'should strip origin/ prefix');
  console.log('PASS  testResolveFromSymbolicRef');
}

function testFallbackChain() {
  const stubRunner = (args) => {
    if (args[0] === 'symbolic-ref') throw new Error('no origin/HEAD');
    if (args[0] === 'rev-parse' && args.includes('HEAD@{upstream}')) {
      return 'origin/trunk\n';
    }
    throw new Error('not reached');
  };
  assert.strictEqual(_resolvePollingBranch({ runner: stubRunner }), 'trunk');
  console.log('PASS  testFallbackChain');
}

function testUltimateFallback() {
  const stubRunner = () => { throw new Error('git not available'); };
  assert.strictEqual(_resolvePollingBranch({ runner: stubRunner }), 'main');
  console.log('PASS  testUltimateFallback');
}

function testExplicitBranchWins() {
  const neverRunner = () => { throw new Error('should not run when branch provided'); };
  assert.strictEqual(
    _resolvePollingBranch({ branch: 'develop', runner: neverRunner }),
    'develop'
  );
  console.log('PASS  testExplicitBranchWins');
}

// ---------------------------------------------------------------------------
// Test 5: end-to-end — repo with master default. lateJoinBootstrap must
// pull master, not main. Uses a real git repo on tmpfs.
// ---------------------------------------------------------------------------
async function testMasterBranchEndToEnd() {
  const base = mktmpdir('collab-polling-master');
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  try {
    run('git', ['init', '--bare', '--initial-branch=master', origin]);
    run('git', ['clone', origin, work]);
    run('git', ['config', 'user.email', 'test@local'], work);
    run('git', ['config', 'user.name', 'Test'], work);
    fs.writeFileSync(path.join(work, 'README.md'), 'seed');
    run('git', ['add', 'README.md'], work);
    run('git', ['commit', '-m', 'seed'], work);
    run('git', ['push', 'origin', 'master'], work);
    // Some git versions don't auto-set origin/HEAD after clone; set it
    // explicitly so _resolvePollingBranch's first fallback returns master.
    try { run('git', ['remote', 'set-head', 'origin', 'master'], work); } catch (_) {}

    // Pre-R011 this would call git pull origin main and fail.
    const r = await lateJoinBootstrap({
      transport: createMemoryTransport(),
      unblockedTaskIds: [],
      cwd: work
    });
    assert.strictEqual(r.joined, true, `pull should succeed on master repo; got ${JSON.stringify(r)}`);
    console.log('PASS  testMasterBranchEndToEnd');
  } finally {
    cleanup(base);
  }
}

async function run_all() {
  const tests = [
    testResolveFromSymbolicRef,
    testFallbackChain,
    testUltimateFallback,
    testExplicitBranchWins,
    testMasterBranchEndToEnd
  ];
  let failed = 0;
  for (const t of tests) {
    try { await t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run_all();
