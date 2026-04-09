// Tests for Runner.computeDelay (T011/R006). Must match the integer
// arithmetic in scripts/forge-runner.sh exactly:
//   DELAY=BASE; for i in 1..(restart-1): DELAY*=2; if DELAY>60: DELAY=60; break
//   if non-zero exit: DELAY*=2; if DELAY>120: DELAY=120

'use strict';

const assert = require('assert');
const { Runner } = require('../../scripts/forge-tui.cjs');

module.exports = {
  'baseline backoff with base=3'() {
    assert.strictEqual(Runner.computeDelay(3, 1, false), 3);
    assert.strictEqual(Runner.computeDelay(3, 2, false), 6);
    assert.strictEqual(Runner.computeDelay(3, 3, false), 12);
    assert.strictEqual(Runner.computeDelay(3, 4, false), 24);
    assert.strictEqual(Runner.computeDelay(3, 5, false), 48);
  },

  'baseline backoff caps at 60 seconds'() {
    assert.strictEqual(Runner.computeDelay(3, 6, false), 60);
    assert.strictEqual(Runner.computeDelay(3, 7, false), 60);
    assert.strictEqual(Runner.computeDelay(3, 100, false), 60);
  },

  'non-zero exit doubles the delay'() {
    assert.strictEqual(Runner.computeDelay(3, 1, true), 6);
    assert.strictEqual(Runner.computeDelay(3, 2, true), 12);
    assert.strictEqual(Runner.computeDelay(3, 3, true), 24);
    assert.strictEqual(Runner.computeDelay(3, 4, true), 48);
    assert.strictEqual(Runner.computeDelay(3, 5, true), 96);
  },

  'non-zero exit caps at 120 seconds'() {
    assert.strictEqual(Runner.computeDelay(3, 6, true), 120);
    assert.strictEqual(Runner.computeDelay(3, 100, true), 120);
  },

  'custom base delay scales correctly'() {
    assert.strictEqual(Runner.computeDelay(1, 1, false), 1);
    assert.strictEqual(Runner.computeDelay(1, 2, false), 2);
    assert.strictEqual(Runner.computeDelay(1, 7, false), 60);
    assert.strictEqual(Runner.computeDelay(5, 1, false), 5);
    assert.strictEqual(Runner.computeDelay(5, 4, false), 40);
    assert.strictEqual(Runner.computeDelay(5, 5, false), 60); // 80 -> capped
  },
};
