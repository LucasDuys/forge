// tests/headless.test.cjs -- headless dispatcher (T011)

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { queryHeadlessState, HEADLESS_EXIT } = tools;

const REQUIRED_FIELDS = [
  'phase',
  'current_task',
  'completed_tasks',
  'remaining_tasks',
  'token_budget_used',
  'token_budget_remaining',
  'last_error',
  'lock_status',
  'active_checkpoints'
];

suite('HEADLESS_EXIT constants', () => {
  test('exposes the documented exit codes 0..4', () => {
    assert.strictEqual(HEADLESS_EXIT.COMPLETE, 0);
    assert.strictEqual(HEADLESS_EXIT.FAILED, 1);
    assert.strictEqual(HEADLESS_EXIT.BUDGET_EXHAUSTED, 2);
    assert.strictEqual(HEADLESS_EXIT.BLOCKED_NEEDS_HUMAN, 3);
    assert.strictEqual(HEADLESS_EXIT.LOCK_CONFLICT, 4);
  });
});

suite('queryHeadlessState', () => {
  test('returns all 9 required fields', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in snap, `missing field: ${field}`);
    }
  });

  test('completes in under 100ms on a fresh forge dir', () => {
    const { forgeDir } = makeTempForgeDir();
    const start = Date.now();
    queryHeadlessState(forgeDir);
    const duration = Date.now() - start;
    assert.ok(duration < 100, `query took ${duration}ms (>100ms)`);
  });

  test('lock_status reports free when no lock present', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    assert.strictEqual(snap.lock_status, 'free');
  });

  test('phase pulled from state.md frontmatter', () => {
    const { forgeDir } = makeTempForgeDir();
    const snap = queryHeadlessState(forgeDir);
    // Helper seeds state.md with phase: ready
    assert.strictEqual(snap.phase, 'ready');
  });
});

suite('runHeadless smoke test', () => {
  test('query subcommand does not crash via child process', () => {
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const { forgeDir } = makeTempForgeDir();
    const toolsPath = path.resolve(__dirname, '..', 'scripts', 'forge-tools.cjs');
    const r = spawnSync(process.execPath, ['-e', `
      const t = require(${JSON.stringify(toolsPath)});
      const code = t.runHeadless(['headless', 'query', '--forge-dir', ${JSON.stringify(forgeDir)}, '--json']);
      process.exit(code || 0);
    `], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'runHeadless query exited non-zero: ' + (r.stderr || ''));
    assert.ok(r.stdout.includes('phase'), 'expected phase in headless query output');
  });
});

runTests();
