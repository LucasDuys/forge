// tests/locks.test.cjs -- lock primitives (T007, R007)

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { acquireLock, releaseLock, heartbeat, detectStaleLock, readLock } = tools;
const LOCK_FILE = '.forge-loop.lock';

suite('readLock', () => {
  test('returns null when no lock file exists', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(readLock(forgeDir), null);
  });
});

suite('acquireLock', () => {
  test('acquires fresh lock when none exists', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = acquireLock(forgeDir, 'T001');
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.lock.task, 'T001');
    assert.strictEqual(r.lock.pid, process.pid);
    assert.ok(fs.existsSync(path.join(forgeDir, LOCK_FILE)));
    releaseLock(forgeDir);
  });

  test('fails when live lock held by another pid', () => {
    const { forgeDir } = makeTempForgeDir();
    // Forge a fresh foreign lock
    const lockText = [
      'pid: 999999',
      `started: ${new Date().toISOString()}`,
      'task: T_other',
      `heartbeat: ${new Date().toISOString()}`,
      ''
    ].join('\n');
    fs.writeFileSync(path.join(forgeDir, LOCK_FILE), lockText);

    const r = acquireLock(forgeDir, 'T002');
    assert.strictEqual(r.acquired, false);
    assert.match(r.reason, /held_by_pid_999999/);
    assert.strictEqual(r.holder.pid, 999999);
  });

  test('takes over a stale lock', () => {
    const { forgeDir } = makeTempForgeDir();
    // Forge a stale lock (heartbeat 10 minutes ago)
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const lockText = [
      'pid: 999998',
      `started: ${oldTs}`,
      'task: T_stale',
      `heartbeat: ${oldTs}`,
      ''
    ].join('\n');
    fs.writeFileSync(path.join(forgeDir, LOCK_FILE), lockText);

    const r = acquireLock(forgeDir, 'T003');
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.tookOverStale, true);
    assert.strictEqual(r.lock.pid, process.pid);
    releaseLock(forgeDir);
  });
});

suite('detectStaleLock', () => {
  test('returns null when no lock file', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.strictEqual(detectStaleLock(forgeDir), null);
  });

  test('flags >5 min old heartbeat as stale', () => {
    const { forgeDir } = makeTempForgeDir();
    const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(forgeDir, LOCK_FILE),
      `pid: 555\nstarted: ${oldTs}\ntask: x\nheartbeat: ${oldTs}\n`
    );
    const result = detectStaleLock(forgeDir);
    assert.strictEqual(result.is_stale, true);
  });

  test('fresh heartbeat reported as not stale', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = acquireLock(forgeDir, 'T004');
    assert.strictEqual(r.acquired, true);
    const stale = detectStaleLock(forgeDir);
    assert.strictEqual(stale.is_stale, false);
    releaseLock(forgeDir);
  });
});

suite('heartbeat', () => {
  test('updates heartbeat timestamp for owner', () => {
    const { forgeDir } = makeTempForgeDir();
    const acq = acquireLock(forgeDir, 'T005');
    const before = acq.lock.heartbeat;
    // Brief synchronous spin to ensure ISO timestamp tick
    const until = Date.now() + 15;
    while (Date.now() < until) { /* spin */ }
    const r = heartbeat(forgeDir);
    assert.strictEqual(r.ok, true);
    assert.ok(r.heartbeat >= before);
    releaseLock(forgeDir);
  });

  test('refused if not lock owner', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(
      path.join(forgeDir, LOCK_FILE),
      `pid: 88888\nstarted: ${new Date().toISOString()}\ntask: x\nheartbeat: ${new Date().toISOString()}\n`
    );
    const r = heartbeat(forgeDir);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not_owner/);
  });

  test('refused if no lock present', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = heartbeat(forgeDir);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_lock');
  });
});

suite('releaseLock', () => {
  test('removes lock file for owner', () => {
    const { forgeDir } = makeTempForgeDir();
    acquireLock(forgeDir, 'T006');
    const r = releaseLock(forgeDir);
    assert.strictEqual(r.released, true);
    assert.ok(!fs.existsSync(path.join(forgeDir, LOCK_FILE)));
  });

  test('idempotent when no lock exists', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = releaseLock(forgeDir);
    assert.strictEqual(r.released, false);
    assert.strictEqual(r.reason, 'no_lock');
  });

  test('refuses to release lock owned by other pid', () => {
    const { forgeDir } = makeTempForgeDir();
    fs.writeFileSync(
      path.join(forgeDir, LOCK_FILE),
      `pid: 77777\nstarted: ${new Date().toISOString()}\ntask: x\nheartbeat: ${new Date().toISOString()}\n`
    );
    const r = releaseLock(forgeDir);
    assert.strictEqual(r.released, false);
    assert.match(r.reason, /not_owner/);
  });
});

runTests();
