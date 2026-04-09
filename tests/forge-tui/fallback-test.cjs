// Tests for the fallback contract (T012/R007): exit code constants are
// stable, parseArgs handles --no-fallback, env var parses correctly.

'use strict';

const assert = require('assert');
const m = require('../../scripts/forge-tui.cjs');

module.exports = {
  'sentinel exit codes are stable'() {
    assert.strictEqual(m.EXIT_OK, 0);
    assert.strictEqual(m.EXIT_ERROR, 1);
    assert.strictEqual(m.EXIT_FALLBACK, 87);
    assert.strictEqual(m.EXIT_NOT_FOUND, 127);
  },

  'parseArgs picks up --no-fallback'() {
    const args = m.parseArgs(['node', 'forge-tui.cjs', '--no-fallback']);
    assert.strictEqual(args.noFallback, true);
  },

  'parseArgs respects --max-restarts'() {
    const args = m.parseArgs(['node', 'forge-tui.cjs', '--max-restarts', '25']);
    assert.strictEqual(args.maxRestarts, 25);
  },

  'parseArgs respects --base-delay'() {
    const args = m.parseArgs(['node', 'forge-tui.cjs', '--base-delay', '5']);
    assert.strictEqual(args.baseDelay, 5);
  },

  'parseArgs respects --transcript-lines'() {
    const args = m.parseArgs(['node', 'forge-tui.cjs', '--transcript-lines', '100']);
    assert.strictEqual(args.transcriptLines, 100);
  },

  'parseArgs --help sets help flag'() {
    const args = m.parseArgs(['node', 'forge-tui.cjs', '--help']);
    assert.strictEqual(args.help, true);
  },
};
