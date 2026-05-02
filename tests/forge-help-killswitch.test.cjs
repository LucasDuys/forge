// tests/forge-help-killswitch.test.cjs
//
// Wave 3 T007 / R005.AC3 -- commands/help.md documents the three-wave
// FORGE_TOKEN_OPT=0 kill switch.
//
// The wizard side of R005.AC3 is covered by T003 + T005 (wizard banner +
// call-site wiring). This file proves the docs side: help.md mentions the
// flag and surfaces from all three waves, so a user reading `/forge help`
// can find the rollback handle without grepping the spec.
//
// We assert three things:
//   1. commands/help.md exists at the repo root.
//   2. It contains the literal string `FORGE_TOKEN_OPT=0`.
//   3. The same file mentions surfaces from all three waves: instrumentation
//      or tokens (Wave 1), cache (Wave 2), and at least one Wave 3 surface
//      (output filter, effort policy, or wizard).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assert, suite, test, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const HELP_PATH = path.join(REPO_ROOT, 'commands', 'help.md');

suite('help kill-switch docs (R005.AC3)', () => {
  test('commands/help.md exists', () => {
    assert.ok(
      fs.existsSync(HELP_PATH),
      'commands/help.md must exist at the repo root'
    );
    const stat = fs.statSync(HELP_PATH);
    assert.ok(stat.isFile(), 'commands/help.md must be a regular file');
    assert.ok(stat.size > 0, 'commands/help.md must not be empty');
  });

  test('commands/help.md documents FORGE_TOKEN_OPT=0', () => {
    const text = fs.readFileSync(HELP_PATH, 'utf8');
    assert.ok(
      text.includes('FORGE_TOKEN_OPT=0'),
      'help.md must contain the literal string `FORGE_TOKEN_OPT=0` so users ' +
        'can grep the kill-switch flag'
    );
  });

  test('commands/help.md mentions all three wave surfaces', () => {
    const text = fs.readFileSync(HELP_PATH, 'utf8');
    const lower = text.toLowerCase();

    // Wave 1: token instrumentation / ledger.
    const wave1 = lower.includes('instrumentation') ||
      lower.includes('ledger') ||
      lower.includes('wave 1');
    assert.ok(
      wave1,
      'help.md must mention Wave 1 instrumentation/ledger surface ' +
        '(keyword: "instrumentation", "ledger", or "wave 1")'
    );

    // Wave 2: cache extensions.
    const wave2 = lower.includes('cache');
    assert.ok(
      wave2,
      'help.md must mention Wave 2 cache surface (keyword: "cache")'
    );

    // Wave 3: output filter, effort policy, or wizard.
    const wave3 = lower.includes('output filter') ||
      lower.includes('effort') ||
      lower.includes('wizard');
    assert.ok(
      wave3,
      'help.md must mention at least one Wave 3 surface ' +
        '(keyword: "output filter", "effort", or "wizard")'
    );
  });
});

runTests();
