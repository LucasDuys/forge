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

  // R013/R014: StatePoller reads checkpoint files for every running task and
  // exposes the runningTaskDetails array.
  'R013 StatePoller reads per-task checkpoints for all running tasks'() {
    const dir = tmpDir('multi-checkpoint');
    writeState(dir, { phase: 'executing', current_task: 'T010' });
    fs.writeFileSync(path.join(dir, 'task-status.json'), JSON.stringify({
      tasks: {
        T010: { status: 'running' },
        T011: { status: 'running' },
        T012: { status: 'running' },
        T013: { status: 'pending' },
      },
    }));
    for (const id of ['T010', 'T011', 'T012']) {
      fs.writeFileSync(path.join(dir, 'progress', `${id}.json`), JSON.stringify({
        task_id: id, task_name: `task ${id}`, spec_domain: 'test',
        started_at: new Date().toISOString(), last_updated: new Date().toISOString(),
        current_step: id === 'T011' ? 'review_pending' : 'tests_written',
        next_step: id === 'T011' ? null : 'tests_passing',
        artifacts_produced: [], context_bundle: {}, worktree_path: null,
        depth: 'standard',
        token_usage: id === 'T010' ? 8400 : id === 'T011' ? 12100 : 2300,
        error_log: [],
        agent: id === 'T011' ? 'forge-reviewer' : 'forge-executor',
      }));
    }
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.runningTasks.length, 3);
    assert.strictEqual(s.runningTaskDetails.length, 3);
    const t010 = s.runningTaskDetails.find((t) => t.id === 'T010');
    assert.ok(t010);
    assert.strictEqual(t010.tokenUsage, 8400);
    assert.strictEqual(t010.agent, 'forge-executor');
    assert.strictEqual(t010.currentStep, 'tests_written');
    const t011 = s.runningTaskDetails.find((t) => t.id === 'T011');
    assert.strictEqual(t011.tokenUsage, 12100);
    assert.strictEqual(t011.agent, 'forge-reviewer');
  },

  // R014: StatePoller reads .forge/config.json per_task_budget and resolves
  // currentTaskBudget by depth.
  'R014 StatePoller surfaces per_task_budget from config'() {
    const dir = tmpDir('budget');
    writeState(dir, { phase: 'executing', current_task: 'T010' });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      depth: 'thorough',
      per_task_budget: { quick: 5000, standard: 15000, thorough: 40000 },
    }));
    fs.writeFileSync(path.join(dir, 'progress', 'T010.json'), JSON.stringify({
      task_id: 'T010', task_name: 't', spec_domain: 'test',
      started_at: new Date().toISOString(), last_updated: new Date().toISOString(),
      current_step: 'tests_written', next_step: 'tests_passing',
      artifacts_produced: [], context_bundle: {}, worktree_path: null,
      depth: 'thorough', token_usage: 28000, error_log: [],
    }));
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.currentTaskBudget, 40000, 'should resolve thorough budget');
    assert.strictEqual(s.currentTaskTokens, 28000);
    assert.deepStrictEqual(s.perTaskBudgets, { quick: 5000, standard: 15000, thorough: 40000 });
    assert.strictEqual(s.currentDepth, 'thorough');
  },

  // R014: taskTotalTokens sums token_usage across ALL checkpoint files
  'R014 StatePoller sums taskTotalTokens across all progress checkpoints'() {
    const dir = tmpDir('total-tokens');
    writeState(dir, { phase: 'executing', current_task: 'T010' });
    for (const id of ['T001', 'T002', 'T003', 'T010']) {
      fs.writeFileSync(path.join(dir, 'progress', `${id}.json`), JSON.stringify({
        task_id: id, task_name: `task ${id}`, spec_domain: 'test',
        started_at: new Date().toISOString(), last_updated: new Date().toISOString(),
        current_step: 'complete', next_step: 'complete',
        artifacts_produced: [], context_bundle: {}, worktree_path: null,
        depth: 'standard', token_usage: 4000, error_log: [],
      }));
    }
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.taskTotalTokens, 16000);
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

  'Renderer shows parallel panel when more than one task running on a large terminal'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const baseSnap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null,
      lockStatus: 'free', lockHolder: null, sessionBudget: null,
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
      runningTaskDetails: [], currentTaskTokens: null, currentTaskBudget: null,
      perTaskBudgets: null, currentDepth: 'standard', taskTotalTokens: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: baseSnap.ledger, toolCount: 5 } };

    // One running task: no panel, no fallback line
    const single = { ...baseSnap, runningTasks: ['T002'] };
    const r1 = new Renderer({ caps, args, poller: { getSnapshot: () => single, reconcile: () => {} }, parser: fakeParser });
    const frame1 = r1._buildFrame(single, 100, 30);
    assert.ok(!frame1.includes('Running:'), 'single-task frame should not show Running line');
    assert.ok(!frame1.includes('Parallel'), 'single-task frame should not show Parallel panel');

    // Three running on a large terminal: multi-row panel shown
    const multi = { ...baseSnap, runningTasks: ['T002', 'T003', 'T004'] };
    const r2 = new Renderer({ caps, args, poller: { getSnapshot: () => multi, reconcile: () => {} }, parser: fakeParser });
    const frame2 = r2._buildFrame(multi, 100, 30);
    assert.ok(frame2.includes('Parallel'), 'multi-task frame should show Parallel panel separator');
    assert.ok(frame2.includes('T002'), 'multi-task frame should list T002 row');
    assert.ok(frame2.includes('T003'), 'multi-task frame should list T003 row');
    assert.ok(frame2.includes('T004'), 'multi-task frame should list T004 row');
  },

  // R013: multi-row panel renders one row per running task with id/agent/step/tokens
  'R013 panel renders detailed rows when runningTaskDetails populated'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null, blockedReason: null, loopActive: true,
      lockStatus: 'free', lockHolder: null, sessionBudget: null, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
      runningTasks: ['T002', 'T003'],
      runningTaskDetails: [
        { id: 'T002', currentStep: 'tests_written', nextStep: 'tests_passing', tokenUsage: 8400, agent: 'forge-executor', depth: 'standard' },
        { id: 'T003', currentStep: 'review_pending', nextStep: null, tokenUsage: 12100, agent: 'forge-reviewer', depth: 'standard' },
      ],
      currentTaskTokens: 8400, currentTaskBudget: 15000,
      perTaskBudgets: { quick: 5000, standard: 15000, thorough: 40000 },
      currentDepth: 'standard', taskTotalTokens: 20500,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 120, 30);
    assert.ok(frame.includes('Parallel'), 'panel separator missing');
    assert.ok(frame.includes('forge-executor'), 'T002 agent missing');
    assert.ok(frame.includes('forge-reviewer'), 'T003 agent missing');
    assert.ok(frame.includes('tests_written'), 'T002 step missing');
    assert.ok(frame.includes('review_pending'), 'T003 step missing');
    assert.ok(/8k\/15k tok \(56%\)/.test(frame), 'T002 token cost missing or wrong percentage');
    assert.ok(/12k\/15k tok \(80%\)/.test(frame), 'T003 token cost missing or wrong percentage');
  },

  // R013 AC: panel collapses to single-line fallback on small terminal
  'R013 panel collapses to single-line fallback when terminal too small for panel + transcript'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T002', taskStatus: 'in_progress',
      currentStep: null, nextStep: null, blockedReason: null, loopActive: true,
      lockStatus: 'free', lockHolder: null, sessionBudget: null, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
      runningTasks: ['T002', 'T003', 'T004', 'T005', 'T006'],
      runningTaskDetails: [
        { id: 'T002', currentStep: null, nextStep: null, tokenUsage: null, agent: null, depth: 'standard' },
        { id: 'T003', currentStep: null, nextStep: null, tokenUsage: null, agent: null, depth: 'standard' },
        { id: 'T004', currentStep: null, nextStep: null, tokenUsage: null, agent: null, depth: 'standard' },
        { id: 'T005', currentStep: null, nextStep: null, tokenUsage: null, agent: null, depth: 'standard' },
        { id: 'T006', currentStep: null, nextStep: null, tokenUsage: null, agent: null, depth: 'standard' },
      ],
      currentTaskTokens: null, currentTaskBudget: null, perTaskBudgets: null,
      currentDepth: 'standard', taskTotalTokens: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    // Tiny terminal — exactly the minimum 24 rows. Panel needs ~9 fixed + 4
    // visible + overflow + 5 transcript = 19+; 24 rows is borderline.
    const frame = r._buildFrame(snap, 100, 18);
    // 18 rows is too small for the panel — must fall back to Running line
    assert.ok(frame.includes('Running:'), 'small terminal frame should show single-line fallback');
    assert.ok(frame.includes('5 parallel'), 'single-line fallback should include count');
  },

  // R013 AC: 4-row cap with overflow indicator
  'R013 panel caps at 4 visible rows with overflow indicator'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const details = [];
    for (let i = 1; i <= 7; i++) {
      details.push({
        id: `T00${i}`, currentStep: 'implementation_started', nextStep: 'tests_written',
        tokenUsage: 1000 * i, agent: 'forge-executor', depth: 'standard',
      });
    }
    const snap = {
      phase: 'executing', currentTask: 'T001', taskStatus: 'in_progress',
      currentStep: null, nextStep: null, blockedReason: null, loopActive: true,
      lockStatus: 'free', lockHolder: null, sessionBudget: null, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 5, restartCount: 0,
      runningTasks: details.map((d) => d.id),
      runningTaskDetails: details,
      currentTaskTokens: null, currentTaskBudget: null,
      perTaskBudgets: { quick: 5000, standard: 15000, thorough: 40000 },
      currentDepth: 'standard', taskTotalTokens: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 120, 40);
    // 7 tasks, 4 visible, 3 overflow
    assert.ok(frame.includes('T001') && frame.includes('T004'), 'first 4 rows should render');
    assert.ok(!frame.includes('T007'), 'rows past the cap should not render directly');
    assert.ok(frame.includes('(...3 more)'), 'overflow indicator should show 3 hidden');
  },

  // R014: status line per-task token cost with 70/90 color thresholds
  'R014 status line shows per-task token cost with budget percentage'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const baseSnap = {
      phase: 'executing', currentTask: 'T010', taskStatus: 'in_progress',
      currentStep: 'tests_written', nextStep: 'tests_passing',
      runningTasks: [], runningTaskDetails: [],
      lockStatus: 'free', lockHolder: null, sessionBudget: null,
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 9, restartCount: 0,
      perTaskBudgets: { quick: 5000, standard: 15000, thorough: 40000 },
      currentDepth: 'standard', taskTotalTokens: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: baseSnap.ledger, toolCount: 5 } };

    // Under 70%: green
    const green = { ...baseSnap, currentTaskTokens: 6000, currentTaskBudget: 15000 };
    const r1 = new Renderer({ caps, args, poller: { getSnapshot: () => green, reconcile: () => {} }, parser: fakeParser });
    const frame1 = r1._buildFrame(green, 120, 30);
    assert.ok(/6k\/15k tok \(40%\)/.test(frame1), 'green frame missing token suffix');

    // 70-89%: yellow
    const yellow = { ...baseSnap, currentTaskTokens: 12000, currentTaskBudget: 15000 };
    const r2 = new Renderer({ caps, args, poller: { getSnapshot: () => yellow, reconcile: () => {} }, parser: fakeParser });
    const frame2 = r2._buildFrame(yellow, 120, 30);
    assert.ok(/12k\/15k tok \(80%\)/.test(frame2), 'yellow frame missing token suffix');

    // >=90%: red
    const red = { ...baseSnap, currentTaskTokens: 14000, currentTaskBudget: 15000 };
    const r3 = new Renderer({ caps, args, poller: { getSnapshot: () => red, reconcile: () => {} }, parser: fakeParser });
    const frame3 = r3._buildFrame(red, 120, 30);
    assert.ok(/14k\/15k tok \(93%\)/.test(frame3), 'red frame missing token suffix');
  },

  // R014: missing token_usage falls back to "— tok"
  'R014 status line shows "— tok" when checkpoint has no token_usage'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T010', taskStatus: 'in_progress',
      currentStep: 'tests_written', nextStep: 'tests_passing',
      runningTasks: ['T010', 'T011'], runningTaskDetails: [
        { id: 'T010', currentStep: 'tests_written', nextStep: null, tokenUsage: null, agent: 'forge-executor', depth: 'standard' },
        { id: 'T011', currentStep: 'review_pending', nextStep: null, tokenUsage: null, agent: 'forge-reviewer', depth: 'standard' },
      ],
      lockStatus: 'free', lockHolder: null, sessionBudget: null,
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 1000, output: 500, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 9, restartCount: 0,
      currentTaskTokens: null,
      currentTaskBudget: 15000,
      perTaskBudgets: { quick: 5000, standard: 15000, thorough: 40000 },
      currentDepth: 'standard', taskTotalTokens: 0,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 120, 30);
    // Status line should NOT show a tok suffix because currentTaskTokens is null
    assert.ok(!/T010.*tok \(/.test(frame.split('\n')[1]), 'status line should not show tok info when currentTaskTokens null');
    // Panel rows should show "— tok" for both rows
    const panelDashes = (frame.match(/— tok/g) || []).length;
    assert.ok(panelDashes >= 2, `expected at least 2 "— tok" markers in panel, found ${panelDashes}`);
  },

  // R014: token line gains task-tot subfield when there are completed tasks
  'R014 token line shows task-tot subfield when taskTotalTokens > 0'() {
    const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color' };
    const args = { ...DEFAULTS, transcriptLines: 10, maxRestarts: 10, contextLimit: 200000 };
    const snap = {
      phase: 'executing', currentTask: 'T010', taskStatus: 'in_progress',
      currentStep: null, nextStep: null,
      runningTasks: [], runningTaskDetails: [],
      lockStatus: 'free', lockHolder: null,
      sessionBudget: { used: 142000, remaining: 358000, total: 500000 },
      blockedReason: null, loopActive: true, autoBackpropPending: false,
      ledger: { input: 142000, output: 38000, cache_read: 0 }, toolCount: 5,
      frontier: { total: 15 }, completedCount: 9, restartCount: 0,
      currentTaskTokens: null, currentTaskBudget: null,
      perTaskBudgets: null, currentDepth: 'standard',
      taskTotalTokens: 47000,
    };
    const fakeParser = { activeSubagent: () => 'main', latest: { activeTool: 'Edit', tokens: snap.ledger, toolCount: 5 } };
    const r = new Renderer({ caps, args, poller: { getSnapshot: () => snap, reconcile: () => {} }, parser: fakeParser });
    const frame = r._buildFrame(snap, 120, 30);
    assert.ok(/task-tot 47k/.test(frame), 'token line missing task-tot subfield');
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
