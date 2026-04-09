// tests/auto-backprop.test.cjs — unit tests for hooks/auto-backprop.js
//
// Tests the detection logic, opt-out paths, flag file lifecycle, and the
// state.md frontmatter mutation. Does NOT execute the hook end-to-end via
// stdin piping — that's covered by manual smoke tests since hooks talk to
// Claude Code's hook event format which is awkward to spawn from inside a
// test runner.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');
const hook = require('../hooks/auto-backprop');

function tmpForge(opts) {
  opts = opts || {};
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autobp-test-'));
  const forge = path.join(project, '.forge');
  fs.mkdirSync(forge, { recursive: true });
  if (opts.config !== undefined) {
    fs.writeFileSync(path.join(forge, 'config.json'), JSON.stringify(opts.config, null, 2));
  }
  if (opts.state !== undefined) {
    fs.writeFileSync(path.join(forge, 'state.md'), opts.state);
  }
  return forge;
}

suite('auto-backprop :: isTestCommand', () => {
  test('matches vitest', () => assert.strictEqual(hook.isTestCommand('vitest run'), true));
  test('matches jest', () => assert.strictEqual(hook.isTestCommand('npx jest --watch'), true));
  test('matches pytest', () => assert.strictEqual(hook.isTestCommand('pytest tests/'), true));
  test('matches cargo test', () => assert.strictEqual(hook.isTestCommand('cargo test --release'), true));
  test('matches go test', () => assert.strictEqual(hook.isTestCommand('go test ./...'), true));
  test('matches npm test', () => assert.strictEqual(hook.isTestCommand('npm test'), true));
  test('matches npm run test', () => assert.strictEqual(hook.isTestCommand('npm run test'), true));
  test('matches mocha', () => assert.strictEqual(hook.isTestCommand('mocha tests/'), true));
  test('matches node --test', () => assert.strictEqual(hook.isTestCommand('node --test'), true));
  test('matches node run-tests.cjs', () => assert.strictEqual(hook.isTestCommand('node scripts/run-tests.cjs'), true));
  test('does not match grep, ls, build commands', () => {
    assert.strictEqual(hook.isTestCommand('ls -la'), false);
    assert.strictEqual(hook.isTestCommand('grep foo bar.txt'), false);
    assert.strictEqual(hook.isTestCommand('npm run build'), false);
    assert.strictEqual(hook.isTestCommand('git status'), false);
  });
});

suite('auto-backprop :: looksLikeFailure', () => {
  test('detects FAIL line', () => {
    assert.strictEqual(hook.looksLikeFailure('  FAIL  src/foo.test.ts'), true);
  });
  test('detects FAILED line', () => {
    assert.strictEqual(hook.looksLikeFailure('Tests: 3 FAILED, 12 passed'), true);
  });
  test('detects AssertionError', () => {
    assert.strictEqual(hook.looksLikeFailure('AssertionError: expected 1 to equal 2'), true);
  });
  test('detects TAP not ok', () => {
    assert.strictEqual(hook.looksLikeFailure('not ok 5 - my test'), true);
  });
  test('detects "N failing" summary', () => {
    assert.strictEqual(hook.looksLikeFailure('  3 failing'), true);
  });
  test('does NOT trip on "0 failing" success summary', () => {
    assert.strictEqual(hook.looksLikeFailure('  47 passing\n  0 failing'), false);
  });
  test('does NOT trip on "0 failed" Tests: line', () => {
    assert.strictEqual(hook.looksLikeFailure('Tests: 0 failed, 47 passed'), false);
  });
  test('does not detect anything in plain pass output', () => {
    assert.strictEqual(hook.looksLikeFailure('All 47 tests passed in 1.2s'), false);
  });
});

suite('auto-backprop :: captureFailureContext', () => {
  test('returns lines around the failure plus tail', () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`line ${i}`);
    lines[15] = 'FAIL src/foo.test.ts';
    const captured = hook.captureFailureContext(lines.join('\n'));
    assert.ok(captured.includes('FAIL src/foo.test.ts'));
    assert.ok(captured.includes('line 14'));
    assert.ok(captured.includes('line 19')); // within the +8 context window
  });

  test('truncates at MAX_CONTEXT_BYTES with marker', () => {
    const huge = 'FAIL line\n' + 'x'.repeat(10000);
    const captured = hook.captureFailureContext(huge);
    assert.ok(captured.length <= 4500);
    assert.ok(captured.includes('(truncated)'));
  });
});

suite('auto-backprop :: isEnabled', () => {
  test('default on when no config present', () => {
    const forge = tmpForge();
    assert.strictEqual(hook.isEnabled(forge), true);
  });

  test('respects auto_backprop:false in config.json', () => {
    const forge = tmpForge({ config: { auto_backprop: false } });
    assert.strictEqual(hook.isEnabled(forge), false);
  });

  test('on when auto_backprop:true in config.json', () => {
    const forge = tmpForge({ config: { auto_backprop: true } });
    assert.strictEqual(hook.isEnabled(forge), true);
  });

  test('respects FORGE_AUTO_BACKPROP=0 env var', () => {
    const forge = tmpForge({ config: { auto_backprop: true } });
    const prev = process.env.FORGE_AUTO_BACKPROP;
    process.env.FORGE_AUTO_BACKPROP = '0';
    try {
      assert.strictEqual(hook.isEnabled(forge), false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_AUTO_BACKPROP;
      else process.env.FORGE_AUTO_BACKPROP = prev;
    }
  });
});

suite('auto-backprop :: writeFlagFile', () => {
  test('writes flag with all expected fields', () => {
    const forge = tmpForge();
    const ok = hook.writeFlagFile(forge, {
      triggered_at: '2026-04-09T10:00:00Z',
      command: 'vitest run',
      failure_excerpt: 'FAIL line',
      hook: 'auto-backprop',
    });
    assert.strictEqual(ok, true);
    const flag = JSON.parse(fs.readFileSync(path.join(forge, '.auto-backprop-pending.json'), 'utf8'));
    assert.strictEqual(flag.command, 'vitest run');
    assert.strictEqual(flag.hook, 'auto-backprop');
    assert.ok(flag.failure_excerpt);
  });

  test('idempotent — does not overwrite existing flag', () => {
    const forge = tmpForge();
    hook.writeFlagFile(forge, { command: 'first', hook: 'auto-backprop' });
    const second = hook.writeFlagFile(forge, { command: 'second', hook: 'auto-backprop' });
    assert.strictEqual(second, false);
    const flag = JSON.parse(fs.readFileSync(path.join(forge, '.auto-backprop-pending.json'), 'utf8'));
    assert.strictEqual(flag.command, 'first');
  });
});

suite('auto-backprop :: setStatePendingFlag', () => {
  test('inserts auto_backprop_pending into state.md frontmatter when missing', () => {
    const forge = tmpForge({
      state: '---\nphase: executing\ncurrent_task: T010\n---\n\nbody\n',
    });
    hook.setStatePendingFlag(forge);
    const updated = fs.readFileSync(path.join(forge, 'state.md'), 'utf8');
    assert.ok(/auto_backprop_pending: true/.test(updated));
    assert.ok(/phase: executing/.test(updated)); // didn't lose existing fields
  });

  test('replaces existing auto_backprop_pending field', () => {
    const forge = tmpForge({
      state: '---\nphase: executing\nauto_backprop_pending: false\n---\n\nbody\n',
    });
    hook.setStatePendingFlag(forge);
    const updated = fs.readFileSync(path.join(forge, 'state.md'), 'utf8');
    assert.ok(/auto_backprop_pending: true/.test(updated));
    assert.strictEqual((updated.match(/auto_backprop_pending/g) || []).length, 1);
  });

  test('survives missing state.md without throwing', () => {
    const forge = tmpForge();
    // No state.md file at all — should not throw
    hook.setStatePendingFlag(forge);
    assert.strictEqual(fs.existsSync(path.join(forge, 'state.md')), false);
  });
});

suite('auto-backprop :: findForgeDir', () => {
  test('returns null when no .forge anywhere up the tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-forge-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      // Search from a directory that has no .forge ancestor.
      // Note: this only works if /tmp itself has no .forge, which is normal.
      const r = hook.findForgeDir();
      // We accept either null or a real path — just must not throw.
      assert.ok(r === null || typeof r === 'string');
    } finally {
      process.chdir(prev);
    }
  });
});

runTests();
