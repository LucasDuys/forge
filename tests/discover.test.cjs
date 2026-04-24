// tests/discover.test.cjs -- T003 / R002
//
// Capabilities discovery: MCP merge, plugin.json + SKILL.md walking, CLI
// allow-list probing, clustering above threshold, deprecated section, and
// completion-time profile.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const tools = require('../scripts/forge-tools.cjs');
const { discoverCapabilities } = tools;

// ─── helpers ──────────────────────────────────────────────────────────────

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-discover-'));
  const skillsDir = path.join(home, '.claude', 'skills');
  const pluginCache = path.join(home, '.claude', 'plugins', 'cache');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pluginCache, { recursive: true });

  // ~/.mcp.json
  fs.writeFileSync(path.join(home, '.mcp.json'), JSON.stringify({
    mcpServers: {
      context7: { command: 'npx' },
      playwright: { command: 'npx' },
    }
  }));
  // ~/.claude.json with additional servers (merge case)
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      github: { command: 'npx' },
      linear: { command: 'npx' },
    }
  }));
  return { home, skillsDir, pluginCache };
}

function writeSkill(dir, nameVal, descVal) {
  fs.mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${nameVal}\ndescription: ${descVal}\n---\n\nBody.\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

function writePlugin(dir, nameVal, versionVal) {
  const mfDir = path.join(dir, '.claude-plugin');
  fs.mkdirSync(mfDir, { recursive: true });
  fs.writeFileSync(path.join(mfDir, 'plugin.json'), JSON.stringify({
    name: nameVal, version: versionVal, description: `desc for ${nameVal}`
  }));
}

// Cleanup registry: _helper does not manage arbitrary dirs, so we clean up
// inside each test.
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

// ─── 1. happy path: real dirs ────────────────────────────────────────────

suite('discover happy path (R002 AC1, AC2)', () => {
  test('reads ~/.mcp.json + ~/.claude.json and walks skills + plugins', () => {
    const { home, skillsDir, pluginCache } = makeFakeHome();
    try {
      writeSkill(path.join(skillsDir, 'alpha'), 'alpha', 'Does alpha things.');
      writeSkill(path.join(skillsDir, 'beta'), 'beta', 'Does beta things.');
      writePlugin(path.join(pluginCache, 'mkt1', 'pluginA', '1.0.0'), 'pluginA', '1.0.0');

      const caps = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
      });

      // MCP servers merged from both files.
      assert.ok(caps.mcp_servers.context7, 'context7 from ~/.mcp.json');
      assert.ok(caps.mcp_servers.playwright, 'playwright from ~/.mcp.json');
      assert.ok(caps.mcp_servers.github, 'github from ~/.claude.json');
      assert.ok(caps.mcp_servers.linear, 'linear from ~/.claude.json');

      // Skills walked with frontmatter parsed.
      assert.ok(caps.skills.alpha, 'alpha skill indexed');
      assert.strictEqual(caps.skills.alpha.description, 'Does alpha things.');
      assert.ok(caps.skills.beta, 'beta skill indexed');
      assert.strictEqual(caps.skills.alpha.source, 'user-skills');

      // Plugins walked via .claude-plugin/plugin.json.
      const pluginKey = Object.keys(caps.plugins).find(k => k.startsWith('pluginA'));
      assert.ok(pluginKey, 'plugin.json parsed');
      assert.strictEqual(caps.plugins[pluginKey].name, 'pluginA');
      assert.strictEqual(caps.plugins[pluginKey].version, '1.0.0');

      // CLI tools: node should be present on the test runner's PATH.
      assert.ok(caps.cli_tools.node, 'node probed on $PATH');
      assert.strictEqual(caps.cli_tools.node.available, true);
      assert.ok(/^\d+(\.\d+)+/.test(caps.cli_tools.node.version),
        `node version parsed, got ${caps.cli_tools.node.version}`);

      // Shape preserved: mcp_servers, skills, plugins, cli_tools, codex.
      for (const k of ['mcp_servers', 'skills', 'plugins', 'cli_tools', 'codex']) {
        assert.ok(k in caps, `shape preserved: ${k}`);
      }
    } finally {
      rmrf(home);
    }
  });
});

// ─── 2. clustered mode above 50 entries (R002 AC3) ────────────────────────

suite('discover clustered mode (R002 AC3)', () => {
  test('skills + plugins > 50 triggers clustered output; --expand restores', () => {
    const { home, skillsDir } = makeFakeHome();
    try {
      // 60 skills is enough to trip the threshold regardless of plugin count.
      for (let i = 0; i < 60; i++) {
        writeSkill(path.join(skillsDir, `sk${i}`), `sk${i}`, `Skill number ${i}.`);
      }

      const clustered = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
      });

      assert.strictEqual(clustered.clustered, true, 'clustered flag set');
      assert.ok(clustered.clusters, 'clusters present');
      assert.ok(clustered.clusters.skills['user-skills'], 'user-skills cluster counted');
      assert.ok(clustered.clusters.skills['user-skills'].count >= 60,
        'user-skills count >= 60');
      assert.strictEqual(Object.keys(clustered.skills).length, 0,
        'full skills map suppressed in clustered mode');
      assert.ok(clustered.totals.skills >= 60, 'totals.skills reflects real count');

      const expanded = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
        expand: true,
      });
      assert.strictEqual(expanded.clustered, false, 'clustered flag off under --expand');
      assert.ok(Object.keys(expanded.skills).length >= 60,
        'full skills map restored under --expand');
      assert.strictEqual(expanded.meta.expand, true);
    } finally {
      rmrf(home);
    }
  });
});

// ─── 3. deprecated detection (R002 AC5) ───────────────────────────────────

suite('discover deprecated detection (R002 AC5)', () => {
  test('SKILL.md starting with "Deprecated" lands in deprecated section', () => {
    const { home, skillsDir } = makeFakeHome();
    try {
      writeSkill(path.join(skillsDir, 'active-skill'), 'active-skill',
        'Active and well.');
      writeSkill(path.join(skillsDir, 'old-skill'), 'old-skill',
        'Deprecated - use new-skill instead.');

      const caps = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
      });

      assert.ok(caps.skills['active-skill'], 'active stays in skills map');
      assert.ok(!caps.skills['old-skill'], 'deprecated not duplicated in skills');
      assert.ok(caps.deprecated['old-skill'], 'deprecated section populated');
      assert.strictEqual(caps.deprecated['old-skill'].status, 'deprecated');
      assert.ok(caps.deprecated['old-skill'].description.startsWith('Deprecated'),
        'description retained');
    } finally {
      rmrf(home);
    }
  });
});

// ─── 4. profile timing (R002 AC4) ─────────────────────────────────────────

suite('discover completion-time profile (R002 AC4)', () => {
  test('meta.completed_in_ms is set and under the 5s budget', () => {
    const { home } = makeFakeHome();
    try {
      const caps = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
      });
      assert.ok(caps.meta, 'meta present');
      assert.strictEqual(typeof caps.meta.completed_in_ms, 'number');
      assert.ok(caps.meta.completed_in_ms >= 0, 'completed_in_ms >= 0');
      assert.ok(caps.meta.completed_in_ms < 5000,
        `completed_in_ms under 5s budget, got ${caps.meta.completed_in_ms}`);
      assert.strictEqual(caps.meta.aborted, false);
      assert.deepStrictEqual(caps.meta.warnings, []);
    } finally {
      rmrf(home);
    }
  });

  test('time budget exceeded emits a warning but still returns results', () => {
    const { home, skillsDir } = makeFakeHome();
    try {
      writeSkill(path.join(skillsDir, 'probe'), 'probe', 'Probe skill.');
      // Force the budget to 0ms so any real work trips the warning path.
      const caps = discoverCapabilities('/nonexistent-project', null, {
        homeOverride: home,
        timeBudgetMs: 0,
      });
      assert.strictEqual(caps.meta.aborted, true, 'aborted flag set when over budget');
      assert.ok(caps.meta.warnings.length >= 1, 'warning recorded');
      assert.strictEqual(caps.meta.warnings[0].code, 'DISCOVER_TIMEOUT');
      // Still returns real data rather than throwing.
      assert.ok(caps.skills.probe || caps.clustered,
        'partial results available even when budget exceeded');
    } finally {
      rmrf(home);
    }
  });
});

runTests();
