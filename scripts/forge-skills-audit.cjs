#!/usr/bin/env node
// scripts/forge-skills-audit.cjs -- T006 / R013
//
// Inventory audit for skills and commands visible to the current Forge install.
// Produces a fixed-width table of (name, source, path, status) for every skill
// and command found, plus a trailing counts line. Output is designed to be
// copy-paste-ready into a PR description.
//
// Statuses:
//   duplicate  -- same skill/command name appears in >= 2 sources
//   deprecated -- SKILL.md description starts with "Deprecated"
//   archived   -- path contains `_archived-*` or `archived/`
//   active     -- none of the above
//
// Usage:
//   node scripts/forge-skills-audit.cjs            -- formatted table
//   node scripts/forge-skills-audit.cjs --json     -- machine-readable JSON
//   node scripts/forge-skills-audit.cjs --home DIR -- override ~/.claude root
//                                                    (used by tests; points at
//                                                    a fake home directory)
//
// Frontmatter parsing is reused from forge-tools.cjs (T003, bce890e) so this
// script stays consistent with how discoverCapabilities reads SKILL.md.
// The walk is local because discoverCapabilities' walker stops at depth 4
// which is too shallow to reach plugin-shipped SKILL.md files that live at
// cache/<mkt>/<plugin>/<ver>/skills/<skill>/SKILL.md (depth 5).

const fs = require('node:fs');
const path = require('node:path');

const forgeTools = require('./forge-tools.cjs');
const { parseFrontmatter } = forgeTools;

// ─── archive detection ──────────────────────────────────────────────────────
// Spec says: path contains `_archived-` OR `archived/`. Normalise path
// separators so the check works on Windows (backslash) and posix alike.
function isArchivedPath(p) {
  if (!p) return false;
  const norm = String(p).replace(/\\/g, '/');
  return /_archived-/.test(norm) || /\/archived\//.test(norm);
}

// ─── generic file walk ──────────────────────────────────────────────────────
function _walkForBasename(root, basename, maxDepth) {
  const hits = [];
  if (!root) return hits;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === basename) {
        hits.push(full);
      } else if (e.isDirectory() && depth < maxDepth) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return hits;
}

function _walkForSuffix(root, suffix, maxDepth) {
  const hits = [];
  if (!root) return hits;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith(suffix)) {
        hits.push(full);
      } else if (e.isDirectory() && depth < maxDepth) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return hits;
}

// ─── skill discovery ────────────────────────────────────────────────────────
// Walks ~/.claude/skills/** and ~/.claude/plugins/cache/**. Uses a deeper
// walk than discoverCapabilities (max depth 6) so plugin-shipped skills
// under <mkt>/<plugin>/<ver>/skills/<skill>/SKILL.md are reached.
function _classifySkillSource(skillPath, home) {
  const norm = skillPath.replace(/\\/g, '/');
  const homeNorm = (home || '').replace(/\\/g, '/');
  const userRoot = homeNorm ? homeNorm + '/.claude/skills/' : '';
  const cacheRoot = homeNorm ? homeNorm + '/.claude/plugins/cache/' : '';
  if (userRoot && norm.startsWith(userRoot)) {
    const rel = norm.slice(userRoot.length);
    const parts = rel.split('/');
    if (parts[0] && parts[0].startsWith('_archived')) {
      return { source: 'archived', plugin: null };
    }
    return { source: 'user-skills', plugin: null };
  }
  if (cacheRoot && norm.startsWith(cacheRoot)) {
    const rel = norm.slice(cacheRoot.length);
    const parts = rel.split('/');
    // cache/<mkt>/<plugin>/<ver>/skills/<skill>/SKILL.md
    const plug = parts[1] || 'unknown';
    return { source: `plugin:${plug}`, plugin: plug };
  }
  return { source: 'other', plugin: null };
}

function discoverSkills(home) {
  const results = [];
  if (!home) return results;
  const userRoot = path.join(home, '.claude', 'skills');
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache');

  // User skills live shallow (cache/<skill>/SKILL.md), plugin skills live
  // deeper; a single depth-6 walk handles both without double-counting since
  // the two trees do not overlap.
  const seen = new Set();
  const roots = [
    { root: userRoot, depth: 4 },
    { root: cacheRoot, depth: 6 },
  ];
  for (const { root, depth } of roots) {
    for (const p of _walkForBasename(root, 'SKILL.md', depth)) {
      if (seen.has(p)) continue;
      seen.add(p);
      let name = path.basename(path.dirname(p));
      let desc = '';
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const { data } = parseFrontmatter(raw);
        if (data && data.name) name = data.name;
        if (data && data.description) desc = String(data.description);
      } catch (e) { /* unreadable SKILL.md -> fall back to dirname */ }
      const cls = _classifySkillSource(p, home);
      results.push({
        name,
        source: cls.source,
        path: p,
        description: desc,
        plugin: cls.plugin,
      });
    }
  }
  return results;
}

// ─── command discovery ──────────────────────────────────────────────────────
function discoverCommands(home) {
  const results = [];
  if (!home) return results;

  // User-level commands: ~/.claude/commands/*.md
  const userCmdDir = path.join(home, '.claude', 'commands');
  for (const p of _walkForSuffix(userCmdDir, '.md', 2)) {
    const name = path.basename(p, '.md');
    results.push({
      name,
      source: 'user-commands',
      path: p,
      archived: isArchivedPath(p),
    });
  }

  // Plugin commands: ~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/commands/*.md
  const pluginCacheRoot = path.join(home, '.claude', 'plugins', 'cache');
  const cmdFiles = _walkForSuffix(pluginCacheRoot, '.md', 6);
  for (const p of cmdFiles) {
    const norm = p.replace(/\\/g, '/');
    // Only count files that actually live under a .../commands/ subtree;
    // the walker returns every *.md under cache, which includes SKILL.md,
    // README.md and docs we do not want in the commands table.
    if (!/\/commands\//.test(norm)) continue;
    const name = path.basename(p, '.md');
    const relRoot = pluginCacheRoot.replace(/\\/g, '/') + '/';
    const rel = norm.startsWith(relRoot) ? norm.slice(relRoot.length) : norm;
    const parts = rel.split('/');
    const plugin = parts[1] || 'unknown';
    results.push({
      name,
      source: `plugin:${plugin}`,
      path: p,
      archived: isArchivedPath(p),
    });
  }

  return results;
}

// ─── core: build the row list ───────────────────────────────────────────────
function collectRows(opts) {
  opts = opts || {};
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';

  const rows = [];

  // Skills: start with the walk result, decide status per-row.
  const skills = discoverSkills(home);
  for (const entry of skills) {
    let status;
    if (/^Deprecated\b/.test((entry.description || '').trim())) {
      status = 'deprecated';
    } else if (isArchivedPath(entry.path) || entry.source === 'archived') {
      status = 'archived';
    } else {
      status = 'active';
    }
    rows.push({
      kind: 'skill',
      name: entry.name,
      source: entry.source || 'other',
      path: entry.path || '',
      description: entry.description || '',
      status,
    });
  }

  // Commands.
  for (const cmd of discoverCommands(home)) {
    rows.push({
      kind: 'command',
      name: cmd.name,
      source: cmd.source,
      path: cmd.path,
      description: '',
      status: cmd.archived ? 'archived' : 'active',
    });
  }

  // Duplicate detection: a name counts as duplicate when it appears in
  // two or more distinct rows within the same kind. "Distinct" means either
  // different source (user-skills vs plugin, or plugin:A vs plugin:B) OR
  // different path (e.g. two versions of the same plugin shipping the same
  // command). Cross-kind collisions are ignored -- a skill and command with
  // the same name are distinct namespaces. Status upgrades to `duplicate`
  // only from `active` or `archived`; `deprecated` stays `deprecated` so
  // that signal is not lost.
  const byKey = new Map(); // `${kind}\0${name}` -> [row, ...]
  for (const row of rows) {
    const key = row.kind + '\0' + row.name;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // At least one row must differ by source or path for this to count as
    // duplicate -- guards against accidental same-file double inclusion.
    const uniq = new Set(group.map(r => r.source + '\0' + r.path));
    if (uniq.size < 2) continue;
    for (const row of group) {
      if (row.status !== 'deprecated') row.status = 'duplicate';
    }
  }

  // Sort deterministic: kind, then name, then source so table output is
  // stable across runs regardless of fs readdir order.
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.source.localeCompare(b.source);
  });

  return rows;
}

// ─── table rendering ────────────────────────────────────────────────────────
// Column widths are fixed so the table looks identical across runs. Long
// paths overflow rather than forcing width recomputation (which would make
// widths unstable across machines with different home directory lengths).
const COL_WIDTHS = { kind: 7, name: 28, source: 24, status: 11 };

function padRight(s, w) {
  s = String(s);
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

function renderTable(rows) {
  const lines = [];
  const header = [
    padRight('KIND', COL_WIDTHS.kind),
    padRight('NAME', COL_WIDTHS.name),
    padRight('SOURCE', COL_WIDTHS.source),
    padRight('STATUS', COL_WIDTHS.status),
    'PATH',
  ].join('  ');
  const rule = [
    '-'.repeat(COL_WIDTHS.kind),
    '-'.repeat(COL_WIDTHS.name),
    '-'.repeat(COL_WIDTHS.source),
    '-'.repeat(COL_WIDTHS.status),
    '----',
  ].join('  ');
  lines.push(header);
  lines.push(rule);
  for (const row of rows) {
    lines.push([
      padRight(row.kind, COL_WIDTHS.kind),
      padRight(row.name, COL_WIDTHS.name),
      padRight(row.source, COL_WIDTHS.source),
      padRight(row.status, COL_WIDTHS.status),
      row.path,
    ].join('  '));
  }
  return lines.join('\n');
}

function renderSummary(rows) {
  const counts = { active: 0, duplicate: 0, deprecated: 0, archived: 0 };
  const kinds = { skill: 0, command: 0 };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  }
  return [
    '',
    `totals: ${rows.length} entries (${kinds.skill} skills, ${kinds.command} commands)`,
    `status: ${counts.active} active, ${counts.duplicate} duplicate, `
      + `${counts.deprecated} deprecated, ${counts.archived} archived`,
  ].join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { json: false, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: forge-skills-audit [--json] [--home DIR]\n'
      + '  Emit a table of every skill and command Forge can see, with\n'
      + '  status = active | duplicate | deprecated | archived.\n'
    );
    return 0;
  }
  const rows = collectRows({ home: args.home });
  if (args.json) {
    process.stdout.write(JSON.stringify({ rows }, null, 2) + '\n');
  } else {
    process.stdout.write(renderTable(rows) + '\n');
    process.stdout.write(renderSummary(rows) + '\n');
  }
  return 0;
}

// Run when invoked as a script; stay silent when required (for tests).
if (require.main === module) {
  try {
    process.exit(main() || 0);
  } catch (err) {
    process.stderr.write('forge-skills-audit: '
      + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
  }
}

module.exports = {
  collectRows,
  renderTable,
  renderSummary,
  discoverSkills,
  discoverCommands,
  isArchivedPath,
  COL_WIDTHS,
};
