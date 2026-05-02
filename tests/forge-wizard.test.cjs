// tests/forge-wizard.test.cjs -- Wave 3 T003 / R004 (token-output-effort)
//
// Covers:
//   - first call: prints, sets wizard_completed: true
//   - second call: no-op (already-dismissed)
//   - missing config.json: behaves as if wizard_completed is absent (no crash)
//   - FORGE_TOKEN_OPT=0: prints one short line, sets flag
//   - FORGE_TOKEN_OPT=0 second call: no-op
//   - TUI active (state.md frontmatter tui_active: true): no-op, flag NOT set
//   - banner length <= 12 lines (R004.AC4)
//   - banner has no ANSI escape codes (R004.AC4)
//   - kill-switch line is exactly 1 trailing-newline-terminated line
//   - CLI invocation prints + sets flag, exit 0
//   - existing config keys are preserved when flag is written
//   - return shape: { printed, reason } with documented reason values

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

// Default code path: kill switch off unless a test sets it.
delete process.env.FORGE_TOKEN_OPT;

const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'forge-wizard.cjs');

function loadFresh() {
  // Bust the require cache so each test sees a clean module instance.
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

function readConfig(forgeDir) {
  const cfgPath = path.join(forgeDir, 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

// Capture process.stdout.write while running fn, return the captured string.
function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk, ...rest) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return buf;
}

// --- 1. first-run + idempotency ------------------------------------------

suite('runWizard: first-run prints once', () => {
  test('first call prints banner and sets wizard_completed', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const { runWizard } = loadFresh();
    let result;
    const out = captureStdout(() => {
      result = runWizard(forgeDir);
    });
    assert.strictEqual(result.printed, true, 'should print on first run');
    assert.strictEqual(result.reason, 'first-run');
    assert.ok(out.length > 0, 'must produce output');
    assert.ok(/Wave 1/.test(out), 'banner must mention Wave 1');
    assert.ok(/Wave 2/.test(out), 'banner must mention Wave 2');
    assert.ok(/Wave 3/.test(out), 'banner must mention Wave 3');
    assert.ok(/FORGE_TOKEN_OPT/.test(out), 'banner must mention kill switch');
    const cfg = readConfig(forgeDir);
    assert.strictEqual(cfg.wizard_completed, true, 'flag must be set after first run');
  });

  test('second call does not print (idempotent)', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const { runWizard } = loadFresh();
    captureStdout(() => runWizard(forgeDir));
    let secondResult;
    const secondOut = captureStdout(() => {
      secondResult = runWizard(forgeDir);
    });
    assert.strictEqual(secondResult.printed, false, 'second call must not print');
    assert.strictEqual(secondResult.reason, 'already-dismissed');
    assert.strictEqual(secondOut, '', 'no output on second invocation');
  });

  test('preserves other config keys when setting wizard_completed', () => {
    const { forgeDir } = makeTempForgeDir({
      config: { autonomy: 'gated', token_budget: 500000 }
    });
    const { runWizard } = loadFresh();
    captureStdout(() => runWizard(forgeDir));
    const cfg = readConfig(forgeDir);
    assert.strictEqual(cfg.autonomy, 'gated');
    assert.strictEqual(cfg.token_budget, 500000);
    assert.strictEqual(cfg.wizard_completed, true);
  });

  test('explicit wizard_completed: false still triggers first-run', () => {
    const { forgeDir } = makeTempForgeDir({
      config: { wizard_completed: false }
    });
    const { runWizard } = loadFresh();
    let result;
    captureStdout(() => { result = runWizard(forgeDir); });
    assert.strictEqual(result.printed, true);
    assert.strictEqual(result.reason, 'first-run');
    assert.strictEqual(readConfig(forgeDir).wizard_completed, true);
  });
});

// --- 2. missing config -----------------------------------------------------

suite('runWizard: missing config.json', () => {
  test('does not crash, prints, creates config with flag', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    // Remove the config file the helper seeded.
    const cfgPath = path.join(forgeDir, 'config.json');
    fs.unlinkSync(cfgPath);
    assert.ok(!fs.existsSync(cfgPath), 'config.json must be absent');

    const { runWizard } = loadFresh();
    let result;
    const out = captureStdout(() => {
      result = runWizard(forgeDir);
    });
    assert.strictEqual(result.printed, true);
    assert.strictEqual(result.reason, 'first-run');
    assert.ok(out.length > 0);
    assert.ok(fs.existsSync(cfgPath), 'config.json must be created');
    assert.strictEqual(readConfig(forgeDir).wizard_completed, true);
  });
});

// --- 3. kill switch --------------------------------------------------------

suite('runWizard: FORGE_TOKEN_OPT=0 kill switch', () => {
  test('prints one-line disabled notice and sets flag', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const { runWizard } = loadFresh();
      let result;
      const out = captureStdout(() => {
        result = runWizard(forgeDir);
      });
      assert.strictEqual(result.printed, true);
      assert.strictEqual(result.reason, 'kill-switch');
      // Exactly one line of content, terminated by newline.
      const lines = out.split('\n');
      assert.strictEqual(lines.length, 2, 'must be one content line + trailing empty after split');
      assert.strictEqual(lines[1], '', 'must end with newline');
      assert.ok(/disabled/i.test(out), 'must say disabled');
      assert.ok(/FORGE_TOKEN_OPT=0/.test(out), 'must reference the env var');
      assert.strictEqual(readConfig(forgeDir).wizard_completed, true);
    } finally {
      delete process.env.FORGE_TOKEN_OPT;
    }
  });

  test('second call with kill switch does not re-fire', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const { runWizard } = loadFresh();
      captureStdout(() => runWizard(forgeDir));
      let result;
      const out = captureStdout(() => { result = runWizard(forgeDir); });
      assert.strictEqual(result.printed, false);
      assert.strictEqual(result.reason, 'already-dismissed');
      assert.strictEqual(out, '');
    } finally {
      delete process.env.FORGE_TOKEN_OPT;
    }
  });
});

// --- 4. TUI suppression ----------------------------------------------------

suite('runWizard: TUI active suppression', () => {
  test('tui_active: true in state.md is a no-op', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    // Overwrite the helper-seeded state.md with a TUI-active flag.
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: watching\ntui_active: true\n---\n\n## What\'s Done\n'
    );
    const { runWizard } = loadFresh();
    let result;
    const out = captureStdout(() => {
      result = runWizard(forgeDir);
    });
    assert.strictEqual(result.printed, false);
    assert.strictEqual(result.reason, 'tui-active');
    assert.strictEqual(out, '');
    // Importantly, the flag must NOT be set in this case so the wizard
    // can still fire once after the TUI exits.
    const cfg = readConfig(forgeDir);
    assert.notStrictEqual(cfg.wizard_completed, true,
      'TUI suppression must not consume the first-run dismissal');
  });

  test('tui_active: false does not suppress', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: ready\ntui_active: false\n---\n\n## What\'s Done\n'
    );
    const { runWizard } = loadFresh();
    let result;
    captureStdout(() => { result = runWizard(forgeDir); });
    assert.strictEqual(result.printed, true);
    assert.strictEqual(result.reason, 'first-run');
  });
});

// --- 5. banner shape (R004.AC4) -------------------------------------------

suite('runWizard: banner output shape', () => {
  test('banner is <= 12 lines', () => {
    const mod = loadFresh();
    const banner = mod._buildBanner();
    // split('\n') on a string ending with '\n' returns trailing empty,
    // so the visible-line count is splits.length - 1.
    const visibleLines = banner.split('\n').length - 1;
    assert.ok(visibleLines <= 12, `banner has ${visibleLines} lines, must be <= 12`);
    assert.ok(visibleLines >= 1, 'banner must have at least 1 line');
  });

  test('banner has no ANSI escape codes', () => {
    const mod = loadFresh();
    const banner = mod._buildBanner();
    // \x1b is the ANSI ESC introducer.
    assert.ok(!/\x1b/.test(banner), 'banner must not contain ESC');
    // Also check for common alternate forms just in case.
    assert.ok(!//.test(banner), 'banner must not contain unicode-escaped ESC');
  });

  test('kill-switch line has no ANSI and is single-line', () => {
    const mod = loadFresh();
    const line = mod._buildKillSwitchLine();
    assert.ok(!/\x1b/.test(line), 'kill-switch line must not contain ESC');
    const visibleLines = line.split('\n').length - 1;
    assert.strictEqual(visibleLines, 1, 'kill-switch must be exactly one line');
  });

  test('banner is plain ASCII (printable + LF only)', () => {
    const mod = loadFresh();
    const banner = mod._buildBanner();
    // Allow tab + LF + printable ASCII (0x20-0x7E).
    for (const ch of banner) {
      const code = ch.charCodeAt(0);
      const isPrintable = code === 0x09 || code === 0x0A || (code >= 0x20 && code <= 0x7E);
      assert.ok(isPrintable, `non-ASCII byte 0x${code.toString(16)} in banner`);
    }
  });
});

// --- 6. CLI ----------------------------------------------------------------

suite('runWizard: CLI invocation', () => {
  test('CLI prints banner, sets flag, exits 0', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--forge-dir', forgeDir], {
      encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, `CLI must exit 0, got ${result.status}`);
    assert.ok(result.stdout.length > 0, 'must produce stdout');
    assert.ok(/Wave 1/.test(result.stdout), 'banner must include Wave 1');
    assert.strictEqual(readConfig(forgeDir).wizard_completed, true);
  });

  test('CLI second call is silent', () => {
    const { forgeDir } = makeTempForgeDir({ config: { wizard_completed: true } });
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--forge-dir', forgeDir], {
      encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '', 'idempotent CLI call must be silent');
  });
});

runTests();
