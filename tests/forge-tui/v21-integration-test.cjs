// Tests for v2.1 integration in StatePoller and Renderer:
// - Headless query as primary data source (with file-poll fallback)
// - Lock file parsing with stale detection
// - Per-task checkpoint step display
// - Parallel running tasks list
// - Session budget from headless query feeding context meter
// - Auto-backprop pending flag rendering

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StatePoller, Renderer, DEFAULTS } = require('../../scripts/forge-tui.cjs');

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `forge-tui-${name}-`));
  fs.mkdirSync(path.join(d, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(d, 'progress'), { recursive: true });
  return d;
}

function writeState(dir, fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '', 'body');
  fs.writeFileSync(path.join(dir, 'state.md'), lines.join('\n'));
}

module.exports = {
  'StatePoller surfaces lock holder when lock file present and fresh'() {
    const dir = tmpDir('lock-fresh');
    writeState(dir, { phase: 'executing', current_task: 'T002' });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, '.forge-loop.lock'), JSON.stringify({
      pid: 18432,
      started_at: now,
      current_task: 'T002',
      last_heartbeat: now,
    }));
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.lockStatus, 'alive');
    assert.ok(s.lockHolder);
    assert.strictEqual(s.lockHolder.pid, 18432);
    assert.ok(s.lockHolder.lastBeatSec >= 0 && s.lockHolder.lastBeatSec < 5);
  },

  'StatePoller marks lock stale when heartbeat older than 5min'() {
    const dir = tmpDir('lock-stale');
    writeState(dir, { phase: 'executing' });
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
    fs.writeFileSync(path.join(dir, '.forge-loop.lock'), JSON.stringify({
      pid: 99999,
      started_at: old,
      current_task: 'T001',
      last_heartbeat: old,
    }));
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.lockStatus, 'stale');
    assert.strictEqual(s.lockHolder.pid, 99999);
    assert.ok(s.lockHolder.lastBeatSec >= 360);
  },

  'StatePoller defaults to lock free when no lock file present'() {
    const dir = tmpDir('lock-free');
    writeState(dir, { phase: 'idle' });
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.lockStatus, 'free');
    assert.strictEqual(s.lockHolder, null);
  },

  'StatePoller surfaces parallel running tasks from task-status.json'() {
    const dir = tmpDir('parallel');
    writeState(dir, { phase: 'executing', current_task: 'T002' });
    fs.writeFileSync(path.join(dir, 'task-status.json'), JSON.stringify({
      tasks: {
        T001: { status: 'complete' },
        T002: { status: 'running' },
        T003: { status: 'running' },
        T004: { status: 'running' },
        T005: { status: 'pending' },
      },
    }));
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.deepStrictEqual(s.runningTasks, ['T002', 'T003', 'T004']);
  },

  'StatePoller reads checkpoint current_step and next_step for current task'() {
    const dir = tmpDir('checkpoint');
    writeState(dir, { phase: 'executing', current_task: 'T010' });
    fs.writeFileSync(path.join(dir, 'progress', 'T010.json'), JSON.stringify({
      task_id: 'T010',
      task_name: 'add renderer',
      spec_domain: 'tui-dashboard',
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      current_step: 'tests_written',
      next_step: 'tests_passing',
      artifacts_produced: ['scripts/forge-tui.cjs'],
      context_bundle: {},
      worktree_path: null,
      depth: 'standard',
      token_usage: 8000,
      error_log: [],
    }));
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.currentStep, 'tests_written');
    assert.strictEqual(s.nextStep, 'tests_passing');
  },

  'StatePoller picks up auto_backprop_pending flag from state.md frontmatter'() {
    const dir = tmpDir('autobp');
    writeState(dir, {
      phase: 'executing',
      current_task: 'T001',
      auto_backprop_pending: 'true',
    });
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.autoBackpropPending, true);
  },

  'Renderer shows checkpoint step on task line'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const fakeSnap = {
      phase: 'executing', currentTask: 'T010', taskStatus: 'in_progress',
      currentStep: 'tests_written', nextStep: 'tests_passing',
      runningTasks: [], lockStatus: 'free', lockHolder: null,
      sessionBudget: null, blockedReason: null, loopActive: true,
      autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 9, restartCount: 0,
    };
    const fakePoller = { getSnapshot: () => fakeSnap, reconcile: () => {} };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: fakeSnap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: fakePoller, parser: fakeParser });
    const frame = r._buildFrame(fakeSnap, 100, 30);
    assert.ok(frame.includes('tests_written'), 'frame missing current_step');
    assert.ok(frame.includes('tests_passing'), 'frame missing next_step');
  },

  'Renderer shows parallel-tasks line only when more than one task running'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const baseSnap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null,
      lockStatus: 'free', lockHolder: null, sessionBudget: null,
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: baseSnap.ledger, toolCount: 5 } };

    // One running task: no parallel line
    const single = { ...baseSnap, runningTasks: ['T002'] };
    const r1 = new Renderer({ caps, args, poller: { getSnapshot: () => single, reconcile: () => {} }, parser: fakeParser });
    const frame1 = r1._buildFrame(single, 100, 30);
    assert.ok(!frame1.includes('Running:'), 'single-task frame should not show Running line');

    // Three running: parallel line shown
    const multi = { ...baseSnap, runningTasks: ['T002', 'T003', 'T004'] };
    const r2 = new Renderer({ caps, args, poller: { getSnapshot: () => multi, reconcile: () => {} }, parser: fakeParser });
    const frame2 = r2._buildFrame(multi, 100, 30);
    assert.ok(frame2.includes('Running:'), 'multi-task frame should show Running line');
    assert.ok(frame2.includes('T002, T003, T004'), 'multi-task frame should list task IDs');
    assert.ok(frame2.includes('3 parallel'), 'multi-task frame should show count');
  },

  'Renderer shows session budget on token line when present'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null, runningTasks: [],
      lockStatus: 'free', lockHolder: null,
      sessionBudget: { used: 142000, remaining: 358000, total: 500000 },
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 142000, output: 38000, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 100, 30);
    assert.ok(/budget/.test(frame), 'frame missing budget label');
    assert.ok(/142k\/500k/.test(frame), 'frame missing budget numerator/denominator');
    assert.ok(/\(28%\)/.test(frame), 'frame missing budget percentage');
  },

  'Renderer shows lock status on meter line when held'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null, runningTasks: [],
      lockStatus: 'alive', lockHolder: { pid: 18432, lastBeatSec: 12 },
      sessionBudget: null, blockedReason: null, loopActive: true,
      autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 100, 30);
    assert.ok(/lock alive/.test(frame), 'frame missing lock alive');
    assert.ok(/pid 18432/.test(frame), 'frame missing pid');
    assert.ok(/beat 12s ago/.test(frame), 'frame missing beat age');
  },

  'Renderer shows auto-backprop banner when flag is set'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'debugging',
      currentStep: null, nextStep: null, runningTasks: [],
      lockStatus: 'free', lockHolder: null, sessionBudget: null,
      blockedReason: null, loopActive: true, autoBackpropPending: true,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 100, 30);
    assert.ok(/BACKPROP/.test(frame), 'frame missing BACKPROP banner');
    assert.ok(/auto-backprop pending/.test(frame), 'frame missing pending message');
  },
};
