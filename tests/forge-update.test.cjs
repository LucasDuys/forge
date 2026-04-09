// tests/forge-update.test.cjs — unit tests for scripts/forge-update.cjs
//
// Tests the helper functions (findPluginRoot, detectInstallMethod,
// readVersion, currentBranch, isDirty) without actually running git pull
// or modifying any plugin install.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');
const update = require('../scripts/forge-update.cjs');

function makeTempPlugin({ withGit = false, version = '0.1.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-test-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'forge', version, description: 'test' }, null, 2)
  );
  if (withGit) {
    fs.mkdirSync(path.join(root, '.git'));
  }
  return root;
}

suite('forge-update :: readVersion', () => {
  test('reads version and name from plugin.json', () => {
    const root = makeTempPlugin({ version: '1.2.3' });
    const v = update.readVersion(root);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.version, '1.2.3');
    assert.strictEqual(v.name, 'forge');
  });

  test('returns ok:false on missing plugin.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-no-pj-'));
    const v = update.readVersion(root);
    assert.strictEqual(v.ok, false);
    assert.ok(v.reason);
  });

  test('returns ok:false on malformed plugin.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-bad-pj-'));
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'not valid json');
    const v = update.readVersion(root);
    assert.strictEqual(v.ok, false);
  });
});

suite('forge-update :: detectInstallMethod', () => {
  test('returns git when .git directory present', () => {
    const root = makeTempPlugin({ withGit: true });
    const r = update.detectInstallMethod(root);
    assert.strictEqual(r.method, 'git');
    assert.strictEqual(r.root, root);
  });

  test('returns marketplace when path contains plugins/cache/', () => {
    // Synthesize a marketplace-style path. We do not need the file to exist —
    // detectInstallMethod is path-based once .git is absent.
    const fakeMarketRoot = path.join(os.tmpdir(), 'plugins', 'cache', 'forge-marketplace', 'forge', '0.1.0');
    const r = update.detectInstallMethod(fakeMarketRoot);
    assert.strictEqual(r.method, 'marketplace');
  });

  test('returns unknown when neither git nor marketplace path', () => {
    const root = makeTempPlugin({ withGit: false });
    const r = update.detectInstallMethod(root);
    assert.strictEqual(r.method, 'unknown');
  });
});

suite('forge-update :: findPluginRoot via env var', () => {
  test('honors CLAUDE_PLUGIN_ROOT when valid', () => {
    const root = makeTempPlugin();
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = root;
    try {
      const r = update.findPluginRoot();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.root, root);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  test('walks up to find plugin.json when env var unset', () => {
    // The script lives at scripts/forge-update.cjs in the actual forge repo.
    // findPluginRoot walks up from there and should find this very repo.
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const r = update.findPluginRoot();
      assert.strictEqual(r.ok, true);
      assert.ok(fs.existsSync(path.join(r.root, '.claude-plugin', 'plugin.json')));
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });
});

suite('forge-update :: git helpers (only when git available)', () => {
  test('resolveGit returns a path or null without throwing', () => {
    const bin = update.resolveGit();
    // Either returns a string path or null — never throws
    assert.ok(bin === null || typeof bin === 'string');
  });

  test('currentBranch returns a string or null on a git repo', () => {
    // The actual forge repo we are running in IS a git checkout.
    const root = path.resolve(__dirname, '..');
    if (!fs.existsSync(path.join(root, '.git'))) {
      return; // skip — not a git checkout
    }
    const branch = update.currentBranch(root);
    assert.ok(branch === null || typeof branch === 'string');
  });

  test('isDirty returns boolean or null on a git repo', () => {
    const root = path.resolve(__dirname, '..');
    if (!fs.existsSync(path.join(root, '.git'))) {
      return;
    }
    const dirty = update.isDirty(root);
    assert.ok(dirty === null || typeof dirty === 'boolean');
  });
});

runTests();
