// Scenario tests for performForensicRecovery (T020).
// Run: node tests/forensic-recovery-test.cjs
// Standalone -- creates temp .forge dirs, calls the function, prints results.

const fs = require('fs');
const path = require('path');
const os = require('os');
const tools = require('../scripts/forge-tools.cjs');

let pass = 0;
let fail = 0;

function setup(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-t020-${name}-`));
  const forgeDir = path.join(root, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(forgeDir, 'progress'), { recursive: true });
  // minimal state.md
  fs.writeFileSync(path.join(forgeDir, 'state.md'),
    '---\nphase: idle\nspec: test\ncurrent_task: T001\n---\n# State\n');
  // minimal frontier
  fs.writeFileSync(path.join(forgeDir, 'plans', 'test-frontier.md'),
    '---\nspec: test\n---\n## Tier 1\n- [T001] First | est: ~5k\n- [T002] Second | depends: T001 | est: ~5k\n- [T003] Third | depends: T002 | est: ~5k\n');
  fs.writeFileSync(path.join(forgeDir, 'task-status.json'),
    JSON.stringify({ tasks: {}, last_updated: null }));
  return forgeDir;
}

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name} -- ${detail || ''}`);
  }
}

// Scenario A: Clean state -- recovery is a no-op style call.
console.log('\n--- Scenario A: clean state ---');
{
  const fd = setup('A');
  const r = tools.performForensicRecovery(fd);
  check('no checkpoints', r.reconstructed.active_checkpoints.length === 0);
  check('no orphans', r.reconstructed.orphan_worktrees.length === 0);
  check('resume point picks T001', r.reconstructed.resume_point && r.reconstructed.resume_point.task_id === 'T001',
    JSON.stringify(r.reconstructed.resume_point));
  check('not needs_human', r.needs_human === false);
}

// Scenario B: Stale lock only.
console.log('\n--- Scenario B: stale lock only ---');
{
  const fd = setup('B');
  // Write a stale lock manually (heartbeat 10 minutes ago).
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(fd, '.forge-loop.lock'),
    `pid: 99999\nstarted: ${old}\ntask: T001\nheartbeat: ${old}\n`);
  const r = tools.performForensicRecovery(fd);
  check('stale lock warning emitted', r.warnings.some(w => w.startsWith('stale_lock')));
  check('takeover action recorded', r.actions_taken.some(a => a.includes('taken over')));
  check('not needs_human after takeover', r.needs_human === false);
}

// Scenario C: Stale lock + checkpoint -- resume from checkpoint.
console.log('\n--- Scenario C: stale lock + checkpoint ---');
{
  const fd = setup('C');
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(fd, '.forge-loop.lock'),
    `pid: 99998\nstarted: ${old}\ntask: T002\nheartbeat: ${old}\n`);
  // Active checkpoint for T002 mid-implementation
  tools.writeCheckpoint(fd, 'T002', {
    task_name: 'Second',
    current_step: 'implementation_started',
    next_step: 'tests_written'
  });
  const r = tools.performForensicRecovery(fd);
  check('one active checkpoint', r.reconstructed.active_checkpoints.length === 1);
  check('resume point is T002', r.reconstructed.resume_point && r.reconstructed.resume_point.task_id === 'T002',
    JSON.stringify(r.reconstructed.resume_point));
  check('resume source is checkpoint', r.reconstructed.resume_point && r.reconstructed.resume_point.source === 'checkpoint');
}

// Scenario D: Stale lock + checkpoint + orphan worktree (synthetic).
// We can't realistically create a git worktree without git+repo, but we can
// verify the cross-reference logic by stubbing listTaskWorktrees output via
// monkey-patching. Skip if not feasible -- instead test that an unknown
// task in registry without frontier presence does not crash.
console.log('\n--- Scenario D: orphan worktree detection ---');
{
  const fd = setup('D');
  // Pre-mark T999 (not in frontier) as completed in registry to simulate
  // a leftover entry. The orphan path is exercised via listTaskWorktrees
  // returning empty in this env, but we still verify the resume point logic
  // skips committed tasks.
  const reg = { tasks: { T001: { status: 'complete', completed_at: 'x', commit: 'abc' } }, last_updated: 'x' };
  fs.writeFileSync(path.join(fd, 'task-status.json'), JSON.stringify(reg));
  tools.writeCheckpoint(fd, 'T002', {
    task_name: 'Second',
    current_step: 'implementation_started',
    next_step: 'tests_written'
  });
  const r = tools.performForensicRecovery(fd);
  check('T001 in committed list', r.reconstructed.committed_tasks.includes('T001'));
  check('resume point skips committed T001', r.reconstructed.resume_point && r.reconstructed.resume_point.task_id === 'T002');
}

// Scenario E: budget_exhausted phase.
console.log('\n--- Scenario E: budget_exhausted ---');
{
  const fd = setup('E');
  fs.writeFileSync(path.join(fd, 'state.md'),
    '---\nphase: budget_exhausted\nspec: test\ncurrent_task: T002\n---\n# State\n');
  fs.writeFileSync(path.join(fd, 'resume.md'),
    '# resume.md -- budget exhausted\nreason -> session_budget_exhausted\n');
  const r = tools.performForensicRecovery(fd);
  check('budget handoff captured', typeof r.budget_handoff === 'string' && r.budget_handoff.includes('budget exhausted'));
  check('needs_human flagged', r.needs_human === true);
  check('budget warning emitted', r.warnings.some(w => w.includes('budget exhausted')));
}

// Scenario F: We can't synthesize git log inside a non-git temp dir, but we
// verify that registry-based committed tasks are merged correctly.
console.log('\n--- Scenario F: registry-based committed tasks ---');
{
  const fd = setup('F');
  const reg = {
    tasks: {
      T001: { status: 'complete', completed_at: 'x', commit: 'abc1234' },
      T002: { status: 'complete', completed_at: 'x', commit: 'def5678' },
      T003: { status: 'pending', completed_at: null, commit: null }
    },
    last_updated: 'x'
  };
  fs.writeFileSync(path.join(fd, 'task-status.json'), JSON.stringify(reg));
  const r = tools.performForensicRecovery(fd);
  check('two committed', r.reconstructed.committed_tasks.length === 2);
  check('resume picks T003', r.reconstructed.resume_point && r.reconstructed.resume_point.task_id === 'T003',
    JSON.stringify(r.reconstructed.resume_point));
}

// Scenario G: recovering phase (previous resume didn't complete).
console.log('\n--- Scenario G: recovering phase carryover ---');
{
  const fd = setup('G');
  fs.writeFileSync(path.join(fd, 'state.md'),
    '---\nphase: recovering\nspec: test\ncurrent_task: T001\n---\n# State\n');
  const r = tools.performForensicRecovery(fd);
  check('no crash on recovering phase', r && r.reconstructed);
  check('phase action recorded', r.actions_taken.some(a => a.includes('phase ->')));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
