// tests/worktrees.test.cjs -- worktree primitives (T008, R004)

const { suite, test, assert, makeTempForgeDir, gitAvailable, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { createTaskWorktree, listTaskWorktrees, removeTaskWorktree } = tools;

suite('createTaskWorktree skip rules', () => {
  test('skipped when use_worktrees: false', () => {
    const { forgeDir } = makeTempForgeDir({ config: { use_worktrees: false } });
    const r = createTaskWorktree(forgeDir, 'T001', { depth: 'standard', filesTouched: ['a.js', 'b.js'] });
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.reason, 'disabled_by_config');
    assert.strictEqual(r.fallback, 'in-place');
  });

  test('skipped when 0 files touched', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = createTaskWorktree(forgeDir, 'T002', { depth: 'standard', filesTouched: [] });
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.reason, 'no_files_touched');
  });

  test('skipped when depth=quick + 1 file', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = createTaskWorktree(forgeDir, 'T003', { depth: 'quick', filesTouched: ['only.js'] });
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.reason, 'quick_single_file');
  });
});

suite('createTaskWorktree git failure handling', () => {
  test('graceful failure when not a git repo (returns fallback, no throw)', () => {
    const { forgeDir } = makeTempForgeDir();
    if (!gitAvailable()) {
      // Without git on PATH, the inner _runGit returns ok:false anyway, which
      // is the fallback path we want to verify. Skip with a clear reason.
      console.log('  SKIP: git not on PATH; create fallback path still exercised');
    }
    let r;
    assert.doesNotThrow(() => {
      r = createTaskWorktree(forgeDir, 'T_no_repo', {
        depth: 'standard',
        filesTouched: ['x.js', 'y.js']
      });
    });
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.fallback, 'in-place');
    assert.strictEqual(r.reason, 'git_error');
  });
});

suite('listTaskWorktrees shape', () => {
  test('returns an array even with no worktrees / no git', () => {
    const { forgeDir } = makeTempForgeDir();
    const list = listTaskWorktrees(forgeDir);
    assert.ok(Array.isArray(list));
  });
});

suite('removeTaskWorktree safety', () => {
  test('does not throw when nothing to remove', () => {
    const { forgeDir } = makeTempForgeDir();
    let r;
    assert.doesNotThrow(() => {
      r = removeTaskWorktree(forgeDir, 'T_phantom');
    });
    // Either removed:true (filesystem fallback succeeded with nothing to do)
    // or removed:false with a reason. Both are acceptable; we just want no
    // throw and a stable shape.
    assert.ok(typeof r === 'object');
    assert.ok('removed' in r);
  });
});

runTests();
