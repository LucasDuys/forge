// scripts/forge-head-cache.cjs
//
// === Forge HEAD-SHA helper (Wave 2 R004.AC1, spec-token-cache) ===
//
// Returns the current git HEAD SHA via `git rev-parse HEAD`, memoized for
// the lifetime of a single Node.js process. The integration into the
// tool-cache lookup path lives in T006 of the same wave; this module only
// owns the helper itself + its memoization contract.
//
// Lifecycle:
//   - Module-level Map keyed by absolute cwd. First call for a given cwd
//     spawns git; subsequent calls return the cached entry without
//     spawning. The cache lives for the lifetime of `require`-ing this
//     module in one process. A new process (e.g. a fresh hook invocation)
//     starts with an empty cache.
//   - resetCache() clears the Map (test-only escape hatch; production
//     callers should never need it).
//   - The memoization key is the resolved absolute cwd. Two callers with
//     different cwds get separate slots, so a hook that walks across
//     multiple worktrees does not collide.
//
// Defensive contract:
//   - NEVER throws. Every git failure path (not a repo, detached HEAD with
//     no commits, command not found, permission denied, spawn error,
//     timeout) is caught and surfaced as
//     `{ sha: null, source: "fallback", error: <short message> }`.
//   - The caller (tool-cache.js, T006) is responsible for treating a
//     `fallback` result as "downgrade head_pinned -> volatile 120s TTL"
//     per R004.AC4.
//
// FORGE_TOKEN_OPT contract:
//   - When `process.env.FORGE_TOKEN_OPT === "0"`, getHeadSha() returns
//     `{ sha: null, source: "disabled" }` without spawning git. This is
//     the kill-switch path that R006 end-to-end-verifies in T007.
//
// Performance budget (R004.AC1, T001):
//   - First call for a given cwd: <= 30ms (one synchronous git invocation).
//   - Subsequent calls (memoized): <= 1ms (Map lookup + object return).

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Module-level memoization. Map<absoluteCwd, entry>.
// Entry shape: { sha, cwd, timestamp, source, error? }.
const _cache = new Map();

function _isOptOut() {
  return process.env.FORGE_TOKEN_OPT === '0';
}

function _resolveCwd(cwd) {
  if (cwd == null || cwd === '') return path.resolve(process.cwd());
  return path.resolve(cwd);
}

function _spawnGitHead(cwd) {
  // Synchronous spawn. Returns the trimmed stdout on success, throws on
  // any failure (caller catches and converts to fallback shape).
  const stdout = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  });
  return String(stdout).trim();
}

/**
 * Return the current git HEAD SHA for the given cwd, memoized per process.
 *
 * @param {string} [cwd] -- absolute or relative path; defaults to process.cwd()
 * @returns {{ sha: string|null, source: "git"|"fallback"|"disabled", cwd?: string, timestamp?: number, error?: string }}
 */
function getHeadSha(cwd) {
  if (_isOptOut()) {
    return { sha: null, source: 'disabled' };
  }

  const resolved = _resolveCwd(cwd);
  const cached = _cache.get(resolved);
  if (cached !== undefined) {
    return cached;
  }

  let entry;
  try {
    const sha = _spawnGitHead(resolved);
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      // git returned something unexpected (empty, partial, junk). Treat
      // as fallback to stay defensive.
      entry = {
        sha: null,
        source: 'fallback',
        cwd: resolved,
        timestamp: Date.now(),
        error: 'unexpected git output'
      };
    } else {
      entry = {
        sha,
        source: 'git',
        cwd: resolved,
        timestamp: Date.now()
      };
    }
  } catch (err) {
    // Catch every failure mode: ENOENT (no git on PATH), permission
    // denied, not a git repo (exit 128), detached HEAD with no commits,
    // timeout. Never throw.
    const msg = (err && err.message) ? String(err.message).split('\n')[0] : String(err);
    entry = {
      sha: null,
      source: 'fallback',
      cwd: resolved,
      timestamp: Date.now(),
      error: msg.slice(0, 200)
    };
  }

  _cache.set(resolved, entry);
  return entry;
}

/**
 * Clear the per-process memo cache. Test-only.
 */
function resetCache() {
  _cache.clear();
}

/**
 * Return the number of cached entries. Test-only / diagnostics.
 */
function _cacheSize() {
  return _cache.size;
}

module.exports = {
  getHeadSha,
  resetCache,
  _cacheSize
};
