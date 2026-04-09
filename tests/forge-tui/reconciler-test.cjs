// Tests for StatePoller + TuiState restart-boundary hydration (T007/R004).
// The dashboard must NOT visibly reset progress/tokens to zero when the
// Claude child restarts. The reconciler proves this by snapshotting the
// in-memory state, persisting it, instantiating a fresh poller, and
// asserting the new poller's first read returns the same values.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StatePoller, TuiState } = require('../../scripts/forge-tui.cjs');

function tmpForgeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tui-test-'));
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  // Minimal state.md
  fs.writeFileSync(path.join(dir, 'state.md'), [
    '---',
    'phase: executing',
    'current_task: T007',
    'task_status: in_progress',
    'blocked_reason: null',
    '---',
    '',
    'body',
  ].join('\n'));
  // Minimal frontier
  fs.writeFileSync(path.join(dir, 'plans', 'spec-test-frontier.md'), [
    '---',
    'spec: test',
    'total_tasks: 12',
    '---',
    '',
    '- [T001] foo',
    '- [T002] bar',
  ].join('\n'));
  // Loop active marker
  fs.writeFileSync(path.join(dir, '.forge-loop.json'), '{"active":true}');
  return dir;
}

module.exports = {
  'reads phase, task, status from state.md frontmatter'() {
    const dir = tmpForgeDir();
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.phase, 'executing');
    assert.strictEqual(s.currentTask, 'T007');
    assert.strictEqual(s.taskStatus, 'in_progress');
    assert.strictEqual(s.blockedReason, null);
  },

  'reads frontier total from newest plan file'() {
    const dir = tmpForgeDir();
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.frontier.total, 12);
  },

  'detects loop active when .forge-loop.json exists'() {
    const dir = tmpForgeDir();
    const p = new StatePoller({ forgeDir: dir });
    p.start();
    const s = p.getSnapshot();
    p.stop();
    assert.strictEqual(s.loopActive, true);
  },

  'restart hydration: persisted state survives a fresh poller instance'() {
    const dir = tmpForgeDir();
    const first = new StatePoller({ forgeDir: dir });
    first.start();
    // Simulate a forge run that has accumulated some progress + tokens.
    first.snapshot.ledger = { input: 142000, output: 38000, cache_read: 89000 };
    first.persisted.completed_task_ids = ['T001', 'T002', 'T003'];
    first.persist({ restartCount: 4 });
    first.stop();

    // Fresh poller (simulating the next session after the child died).
    const second = new StatePoller({ forgeDir: dir });
    second.start();
    const s = second.getSnapshot();
    second.stop();

    assert.strictEqual(s.restartCount, 4, 'restart count should hydrate');
    assert.strictEqual(s.completedCount, 3, 'completed count should hydrate');
    // Ledger comes back via persisted last_tokens because token-ledger.json
    // wasn't written for this test — the hydration path is what matters.
    const tuiState = TuiState.load(dir);
    assert.strictEqual(tuiState.last_tokens.input, 142000);
    assert.strictEqual(tuiState.last_tokens.output, 38000);
    assert.strictEqual(tuiState.last_tokens.cache_read, 89000);
  },

  'TuiState.load returns defaults for missing file without throwing'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tui-empty-'));
    const s = TuiState.load(dir);
    assert.strictEqual(s.restart_count, 0);
    assert.deepStrictEqual(s.last_tokens, { input: 0, output: 0, cache_read: 0 });
  },

  'TuiState.save writes atomically via tmp+rename'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tui-save-'));
    TuiState.save(dir, { ...TuiState.default(), restart_count: 7 });
    const reread = TuiState.load(dir);
    assert.strictEqual(reread.restart_count, 7);
    // No leftover tmp file
    assert.strictEqual(fs.existsSync(path.join(dir, '.tui-state.json.tmp')), false);
  },
};
