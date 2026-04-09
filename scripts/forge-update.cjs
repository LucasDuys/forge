#!/usr/bin/env node
// forge-update.cjs — Update Forge to the latest version from upstream.
//
// Detects how Forge is installed (git checkout vs marketplace cache vs
// --plugin-dir), runs the appropriate update mechanism, and reports the
// version delta. Safe to run repeatedly — exits cleanly when already up
// to date and never overwrites uncommitted local changes without confirmation.
//
// Usage:
//   node scripts/forge-update.cjs                    # interactive update
//   node scripts/forge-update.cjs --check            # report only, no changes
//   node scripts/forge-update.cjs --force            # skip dirty-tree check
//   node scripts/forge-update.cjs --plugin-root PATH # explicit install location
//
// Exit codes:
//   0  up to date OR successfully updated
//   1  update failed (network, conflict, dirty tree without --force)
//   2  unsupported install method (manual instructions printed)
//   3  pre-flight check failed (no plugin.json found)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── ARG PARSING ──────────────────────────────────────────────────────────

const args = { check: false, force: false, pluginRoot: null, help: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--check') args.check = true;
  else if (a === '--force') args.force = true;
  else if (a === '--plugin-root') args.pluginRoot = process.argv[++i];
  else if (a === '-h' || a === '--help') args.help = true;
  else {
    process.stderr.write(`forge-update: unknown arg "${a}"\n`);
    process.exit(1);
  }
}

if (args.help) {
  process.stdout.write([
    'forge-update — pull the latest Forge from upstream',
    '',
    'Usage:',
    '  node scripts/forge-update.cjs [options]',
    '',
    'Options:',
    '  --check               Report only, do not make any changes',
    '  --force               Skip dirty-tree check (will stash uncommitted changes)',
    '  --plugin-root PATH    Explicit path to plugin install directory',
    '  -h, --help            Show this help',
    '',
    'Exit codes:',
    '  0   up to date or successfully updated',
    '  1   update failed (network error, merge conflict, dirty tree)',
    '  2   unsupported install method (manual instructions printed)',
    '  3   pre-flight check failed (plugin.json not found)',
    '',
  ].join('\n'));
  process.exit(0);
}

// ─── PLUGIN ROOT DISCOVERY ────────────────────────────────────────────────

function findPluginRoot() {
  // 1. Explicit --plugin-root flag wins
  if (args.pluginRoot) {
    if (!fs.existsSync(path.join(args.pluginRoot, '.claude-plugin', 'plugin.json'))) {
      return { ok: false, reason: `--plugin-root "${args.pluginRoot}" does not contain .claude-plugin/plugin.json` };
    }
    return { ok: true, root: path.resolve(args.pluginRoot) };
  }
  // 2. CLAUDE_PLUGIN_ROOT env var (set by Claude Code when running as plugin)
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const r = process.env.CLAUDE_PLUGIN_ROOT;
    if (fs.existsSync(path.join(r, '.claude-plugin', 'plugin.json'))) {
      return { ok: true, root: r };
    }
  }
  // 3. Walk up from this script's location until we find .claude-plugin/plugin.json
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      return { ok: true, root: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { ok: false, reason: 'could not locate .claude-plugin/plugin.json' };
}

// ─── INSTALL METHOD DETECTION ─────────────────────────────────────────────

function detectInstallMethod(root) {
  // Method 1: git checkout (has .git directory) — use git pull
  if (fs.existsSync(path.join(root, '.git'))) {
    return { method: 'git', root };
  }
  // Method 2: marketplace cache — path contains "plugins/cache/"
  if (root.includes(`${path.sep}plugins${path.sep}cache${path.sep}`) ||
      root.includes('/plugins/cache/')) {
    return { method: 'marketplace', root };
  }
  // Method 3: --plugin-dir or symlinked install — manual instructions
  return { method: 'unknown', root };
}

// ─── VERSION READING ──────────────────────────────────────────────────────

function readVersion(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8');
    const json = JSON.parse(raw);
    return { ok: true, version: json.version || 'unknown', name: json.name || 'forge' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── GIT HELPERS ──────────────────────────────────────────────────────────

// Resolve git binary — Windows installs often have it outside PATH.
function resolveGit() {
  // Try PATH first
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, ['git'], { encoding: 'utf8' });
  if (r.status === 0) {
    return r.stdout.split(/\r?\n/)[0].trim();
  }
  // Common Windows install paths as fallback
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function git(root, ...gitArgs) {
  const bin = resolveGit();
  if (!bin) return { ok: false, code: 127, stdout: '', stderr: 'git not found on PATH' };
  const r = spawnSync(bin, gitArgs, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, code: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function isDirty(root) {
  const r = git(root, 'status', '--porcelain');
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}

function currentBranch(root) {
  const r = git(root, 'branch', '--show-current');
  return r.ok ? r.stdout.trim() : null;
}

// ─── UPDATE STRATEGIES ────────────────────────────────────────────────────

function updateGitInstall(root) {
  const branch = currentBranch(root) || 'main';
  process.stdout.write(`Detected git checkout on branch '${branch}' at:\n  ${root}\n\n`);

  // Pre-flight: dirty tree check
  const dirty = isDirty(root);
  if (dirty === null) {
    return { ok: false, reason: 'could not run git status — is git installed?' };
  }
  if (dirty && !args.force) {
    process.stderr.write([
      'Refusing to update: working tree has uncommitted changes.',
      '',
      'Either:',
      '  1. Commit or stash your changes first, then re-run',
      '  2. Re-run with --force (this script will stash them for you)',
      '',
      'Run `git status` to see what is uncommitted.',
      '',
    ].join('\n'));
    return { ok: false, reason: 'dirty working tree, --force not given' };
  }

  let stashed = false;
  if (dirty && args.force) {
    process.stdout.write('Stashing local changes (--force)...\n');
    const s = git(root, 'stash', 'push', '-u', '-m', 'forge-update auto-stash');
    if (!s.ok) return { ok: false, reason: `git stash failed: ${s.stderr.trim()}` };
    stashed = true;
  }

  process.stdout.write('Fetching from origin...\n');
  const fetchResult = git(root, 'fetch', 'origin', '--prune');
  if (!fetchResult.ok) {
    if (stashed) git(root, 'stash', 'pop');
    return { ok: false, reason: `git fetch failed: ${fetchResult.stderr.trim()}` };
  }

  // Check whether we're already up to date.
  const local = git(root, 'rev-parse', 'HEAD');
  const remote = git(root, 'rev-parse', `origin/${branch}`);
  if (local.ok && remote.ok && local.stdout.trim() === remote.stdout.trim()) {
    if (stashed) git(root, 'stash', 'pop');
    return { ok: true, action: 'already-up-to-date' };
  }

  // Show what's about to land
  const log = git(root, 'log', '--oneline', `HEAD..origin/${branch}`);
  if (log.ok && log.stdout.trim()) {
    process.stdout.write('\nIncoming commits:\n');
    process.stdout.write(log.stdout.split('\n').map((l) => '  ' + l).join('\n') + '\n\n');
  }

  if (args.check) {
    const count = log.stdout.split('\n').filter(Boolean).length;
    if (stashed) git(root, 'stash', 'pop');
    return { ok: true, action: 'check-only', updatesAvailable: count };
  }

  // Fast-forward only — refuses to overwrite divergent local commits.
  process.stdout.write(`Fast-forward merging origin/${branch}...\n`);
  const merge = git(root, 'merge', '--ff-only', `origin/${branch}`);
  if (!merge.ok) {
    if (stashed) git(root, 'stash', 'pop');
    return {
      ok: false,
      reason: `fast-forward failed: ${merge.stderr.trim()}\n\nYour branch has commits that diverge from origin/${branch}. Resolve manually:\n  cd ${root}\n  git status\n  git pull --rebase`,
    };
  }

  if (stashed) {
    process.stdout.write('Restoring stashed changes...\n');
    const pop = git(root, 'stash', 'pop');
    if (!pop.ok) {
      return {
        ok: false,
        reason: `update succeeded but stash pop failed: ${pop.stderr.trim()}\nRun \`git stash list\` and \`git stash pop\` manually.`,
      };
    }
  }

  return { ok: true, action: 'updated' };
}

function updateMarketplaceInstall(root) {
  process.stdout.write([
    'Detected marketplace cache install at:',
    `  ${root}`,
    '',
    'Marketplace installs cannot be updated by this script directly — Claude',
    'Code manages the cache. Run these in your terminal to update:',
    '',
    '  claude plugin marketplace update forge-marketplace',
    '  claude plugin install forge@forge-marketplace',
    '',
    'Then run /reload-plugins inside Claude Code to pick up the new version.',
    '',
  ].join('\n'));
  return { ok: false, reason: 'marketplace install — manual update required', exitCode: 2 };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

function main() {
  process.stdout.write('forge-update — checking for updates\n\n');

  const rootResult = findPluginRoot();
  if (!rootResult.ok) {
    process.stderr.write(`Pre-flight failed: ${rootResult.reason}\n`);
    process.exit(3);
  }
  const root = rootResult.root;

  const beforeVer = readVersion(root);
  if (!beforeVer.ok) {
    process.stderr.write(`Could not read plugin.json: ${beforeVer.reason}\n`);
    process.exit(3);
  }
  process.stdout.write(`Currently installed: ${beforeVer.name} ${beforeVer.version}\n`);

  const install = detectInstallMethod(root);
  let result;
  if (install.method === 'git') {
    result = updateGitInstall(root);
  } else if (install.method === 'marketplace') {
    result = updateMarketplaceInstall(root);
  } else {
    process.stderr.write([
      `\nDetected install at ${root} but could not identify the install method.`,
      'No .git directory and not a marketplace cache path.',
      '',
      'If you installed via --plugin-dir or a symlink, update by pulling from your',
      'source repository directly. This script only knows how to update git checkouts',
      'and marketplace cache installs.',
      '',
    ].join('\n'));
    process.exit(2);
  }

  if (!result.ok) {
    process.stderr.write(`\nUpdate failed: ${result.reason}\n`);
    process.exit(result.exitCode || 1);
  }

  if (result.action === 'already-up-to-date') {
    process.stdout.write('\nAlready up to date.\n');
    process.exit(0);
  }
  if (result.action === 'check-only') {
    process.stdout.write(`\n${result.updatesAvailable} update(s) available. Re-run without --check to apply.\n`);
    process.exit(0);
  }

  // Successfully updated — read new version and report delta
  const afterVer = readVersion(root);
  if (afterVer.ok && afterVer.version !== beforeVer.version) {
    process.stdout.write(`\nUpdated: ${beforeVer.version} → ${afterVer.version}\n`);
  } else {
    process.stdout.write('\nUpdated to latest commit on tracking branch.\n');
  }
  process.stdout.write('\nRun /reload-plugins inside Claude Code to load the new version.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  findPluginRoot, detectInstallMethod, readVersion,
  resolveGit, isDirty, currentBranch,
};
