// Snapshot test for the renderer (T010/R003 + R011). Renders a fixed state
// input and asserts the output matches snapshot-render.txt byte-for-byte
// (modulo ANSI escape sequences which are stripped to keep the snapshot
// human-readable). Update with: node tests/forge-tui/render-test.cjs --update

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Renderer, DEFAULTS } = require('../../scripts/forge-tui.cjs');

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot-render.txt');

const FIXED_STATE = {
  phase: 'executing',
  currentTask: 'T010',
  taskStatus: 'in_progress',
  blockedReason: null,
  loopActive: true,
  toolCount: 17,
  ledger: { input: 142000, output: 38000, cache_read: 89000 },
  frontier: { total: 15, taskIds: [] },
  completedCount: 9,
  restartCount: 2,
};

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function buildFixedFrame() {
  const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color', colorterm: 'truecolor' };
  const args = { ...DEFAULTS, transcriptLines: 50, maxRestarts: 10, contextLimit: 200000 };
  const fakePoller = { getSnapshot: () => FIXED_STATE, reconcile: () => {} };
  const fakeParser = {
    activeSubagent: () => 'forge-executor',
    latest: { activeTool: 'Edit', tokens: FIXED_STATE.ledger, toolCount: 17 },
  };
  const r = new Renderer({ caps, args, poller: fakePoller, parser: fakeParser });
  r.pushTranscript('>', '[forge-executor] Reading src/auth/middleware.ts');
  r.pushTranscript('~', 'Edit /repo/src/auth/middleware.ts');
  r.pushTranscript('=', 'File edited successfully.');
  r.pushTranscript('>', '[forge-executor] Running tests...');
  r.pushTranscript('=', 'tests passed\n12 tests total');
  return r._buildFrame(FIXED_STATE, 100, 30);
}

module.exports = {
  'snapshot matches saved render'() {
    const frame = buildFixedFrame();
    const stripped = stripAnsi(frame);
    if (process.argv.includes('--update')) {
      fs.writeFileSync(SNAPSHOT_PATH, stripped);
      return;
    }
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      fs.writeFileSync(SNAPSHOT_PATH, stripped);
      return; // first run writes baseline
    }
    const expected = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    assert.strictEqual(stripped, expected, 'rendered frame drifted from snapshot');
  },
};

if (require.main === module) {
  // Allow direct invocation: node tests/forge-tui/render-test.cjs [--update]
  module.exports['snapshot matches saved render']();
  console.log('render snapshot:', process.argv.includes('--update') ? 'WRITTEN' : 'OK');
}
