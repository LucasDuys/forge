// tests/skills-audit.test.cjs -- T006 / R013
//
// Skills-audit inventory script: exercises collectRows + renderTable against
// a series of fake ~/.claude/ directories so every status path (duplicate,
// deprecated, archived, active) is covered without touching the real home.
//
// Column widths must be byte-identical across runs for the copy-paste
// workflow; we assert that by comparing two renders of the same fixture.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const {
  collectRows,
  renderTable,
  discoverCommands,
  isArchivedPath,
  COL_WIDTHS,
} = require('../scripts/forge-skills-audit.cjs');

// ─── fixture helpers ──────────────────────────────────────────────────────

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-audit-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
  return home;
}

function writeSkill(homeOrDir, relParts, nameVal, descVal) {
  const dir = Array.isArray(relParts)
    ? path.join(homeOrDir, ...relParts)
    : path.join(homeOrDir, relParts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${nameVal}\ndescription: ${descVal}\n---\n\nBody.\n`
  );
  return path.join(dir, 'SKILL.md');
}

function writePluginSkill(home, mkt, plugin, version, skillName, descVal) {
  // Also write a plugin.json so the plugin shows up in caps.plugins --
  // not strictly required for the skill walk but matches real layouts.
  const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', mkt, plugin, version);
  const manifestDir = path.join(pluginRoot, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: plugin, version, description: 'test plugin' })
  );
  const skillDir = path.join(pluginRoot, 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${descVal}\n---\n\nBody.\n`
  );
  return path.join(skillDir, 'SKILL.md');
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// ─── 1. duplicate detection ───────────────────────────────────────────────

suite('skills-audit duplicate detection (R013 AC2)', () => {
  test('same skill name in user-skills and a plugin marks both as duplicate', () => {
    const home = makeFakeHome();
    try {
      writeSkill(home, ['.claude', 'skills', 'shared-skill'],
        'shared-skill', 'User-level shared skill.');
      writePluginSkill(home, 'mkt1', 'pluginA', '1.0.0',
        'shared-skill', 'Plugin-level shared skill.');

      const rows = collectRows({ home });
      const matches = rows.filter(r => r.kind === 'skill' && r.name === 'shared-skill');
      assert.strictEqual(matches.length, 2, 'both copies returned');
      assert.strictEqual(matches[0].status, 'duplicate',
        'user-skills copy flagged duplicate');
      assert.strictEqual(matches[1].status, 'duplicate',
        'plugin copy flagged duplicate');
      const sources = new Set(matches.map(r => r.source));
      assert.strictEqual(sources.size, 2, 'distinct sources recorded');
    } finally {
      rmrf(home);
    }
  });

  test('single-source repeats do not count as duplicate', () => {
    const home = makeFakeHome();
    try {
      writeSkill(home, ['.claude', 'skills', 'only-skill'],
        'only-skill', 'Only user copy.');
      const rows = collectRows({ home });
      const row = rows.find(r => r.kind === 'skill' && r.name === 'only-skill');
      assert.ok(row, 'skill found');
      assert.strictEqual(row.status, 'active', 'single-source stays active');
    } finally {
      rmrf(home);
    }
  });
});

// ─── 2. deprecated detection ──────────────────────────────────────────────

suite('skills-audit deprecated detection (R013 AC3)', () => {
  test('SKILL.md description starting with Deprecated marks row deprecated', () => {
    const home = makeFakeHome();
    try {
      writeSkill(home, ['.claude', 'skills', 'old-skill'],
        'old-skill', 'Deprecated - use new-skill instead.');
      writeSkill(home, ['.claude', 'skills', 'new-skill'],
        'new-skill', 'Active replacement.');

      const rows = collectRows({ home });
      const old = rows.find(r => r.name === 'old-skill');
      const fresh = rows.find(r => r.name === 'new-skill');
      assert.ok(old, 'deprecated skill present in rows');
      assert.strictEqual(old.status, 'deprecated',
        'old-skill marked deprecated');
      assert.ok(fresh, 'active skill present');
      assert.strictEqual(fresh.status, 'active', 'new-skill stays active');
    } finally {
      rmrf(home);
    }
  });
});

// ─── 3. archived detection ────────────────────────────────────────────────

suite('skills-audit archived detection (R013 AC4)', () => {
  test('skill under _archived-gsd/ is flagged as archived', () => {
    const home = makeFakeHome();
    try {
      writeSkill(home, ['.claude', 'skills', '_archived-gsd', 'old-plan'],
        'old-plan', 'Legacy planner.');
      const rows = collectRows({ home });
      const row = rows.find(r => r.kind === 'skill' && r.name === 'old-plan');
      assert.ok(row, '_archived skill discovered');
      assert.strictEqual(row.status, 'archived',
        'path under _archived-gsd flagged archived');
    } finally {
      rmrf(home);
    }
  });

  test('isArchivedPath recognises both archive conventions', () => {
    assert.strictEqual(isArchivedPath('/a/b/_archived-foo/c'), true);
    assert.strictEqual(isArchivedPath('/a/b/archived/c'), true);
    assert.strictEqual(isArchivedPath('/a/b/c'), false);
    // Windows separators normalise correctly.
    assert.strictEqual(isArchivedPath('C:\\home\\.claude\\skills\\_archived-x\\y'), true);
  });
});

// ─── 4. column widths stable across runs ──────────────────────────────────

suite('skills-audit column widths (R013 AC5, stable output)', () => {
  test('two renders of the same fixture are byte-identical', () => {
    const home = makeFakeHome();
    try {
      writeSkill(home, ['.claude', 'skills', 'alpha'], 'alpha', 'Alpha skill.');
      writeSkill(home, ['.claude', 'skills', 'beta'], 'beta', 'Beta skill.');
      writePluginSkill(home, 'mkt1', 'plugX', '1.0.0', 'gamma', 'Gamma skill.');

      const rowsA = collectRows({ home });
      const rowsB = collectRows({ home });
      const tableA = renderTable(rowsA);
      const tableB = renderTable(rowsB);

      assert.strictEqual(tableA, tableB, 'identical output across runs');

      // Header/rule column offsets must match the declared COL_WIDTHS map.
      const header = tableA.split('\n')[0];
      // KIND column: 'KIND' + padding to width COL_WIDTHS.kind, then 2 spaces.
      assert.strictEqual(header.slice(0, COL_WIDTHS.kind), 'KIND' + ' '.repeat(COL_WIDTHS.kind - 4));
      // All data rows have at least the first four columns at their declared
      // widths (path column is unbounded and ignored).
      const lines = tableA.split('\n').slice(2); // skip header + rule
      for (const line of lines) {
        if (!line.trim()) continue;
        const kind = line.slice(0, COL_WIDTHS.kind);
        // Two-space separator after every fixed-width column.
        assert.strictEqual(line[COL_WIDTHS.kind], ' ',
          `data row preserves first separator position: ${line}`);
        assert.ok(kind.trim().length <= COL_WIDTHS.kind,
          'kind field fits its column');
      }
    } finally {
      rmrf(home);
    }
  });
});

// ─── 5. command discovery ─────────────────────────────────────────────────

suite('skills-audit command discovery', () => {
  test('user-level and plugin-level commands both appear in rows', () => {
    const home = makeFakeHome();
    try {
      // User command
      fs.writeFileSync(
        path.join(home, '.claude', 'commands', 'mycmd.md'),
        '---\ndescription: my command\n---\n\nBody.\n'
      );
      // Plugin command
      const pluginCmdDir = path.join(
        home, '.claude', 'plugins', 'cache', 'mkt1', 'pluginA', '1.0.0', 'commands'
      );
      fs.mkdirSync(pluginCmdDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginCmdDir, 'plugin-cmd.md'),
        '---\ndescription: plugin command\n---\n\nBody.\n'
      );

      const cmds = discoverCommands(home);
      const names = cmds.map(c => c.name).sort();
      assert.ok(names.includes('mycmd'), 'user command discovered');
      assert.ok(names.includes('plugin-cmd'), 'plugin command discovered');
      const plug = cmds.find(c => c.name === 'plugin-cmd');
      assert.strictEqual(plug.source, 'plugin:pluginA',
        'plugin command source tagged with plugin name');
    } finally {
      rmrf(home);
    }
  });
});

runTests();
