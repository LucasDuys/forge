// scripts/forge-collab.cjs
//
// Forge collab subsystem -- hackathon-native multiplayer mode (spec-collab).
//
// This module is loaded only when the user opts into collab mode via
// /forge:collaborate. Default single-user Forge never requires it.
//
// T001 (R001) establishes the module scaffold and the session-id primitive
// that all later tasks (claim queue, transport, brainstorm, flags) build on.
//
// Later tasks will add:
//   T002 routing, T003 claim queue + consolidation-lease, T004 transport,
//   T005 package.json peerDependency, T006 flag-id + user-scoped logs,
//   T007 brainstorm chat mode + consolidate + categorize,
//   T008 per-task branches, T009 research-type execution,
//   T010 flags + review/override + targeted notifications,
//   T011 squash-merge race-retry, T012 push-config + late-join.

'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/**
 * Return the origin remote URL for the repo at `cwd`, or throw if none exists.
 */
function readOriginUrl(cwd) {
  let out;
  try {
    out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    // git failed: not a repo, or no origin remote, or git missing.
    const stderr = (e && e.stderr && e.stderr.toString()) || '';
    if (/No such remote|no such remote|does not exist/i.test(stderr)) {
      throw new Error(
        'forge:collab requires an `origin` git remote. ' +
        'Set one with `git remote add origin <url>`.'
      );
    }
    if (/not a git repository/i.test(stderr)) {
      throw new Error(
        'forge:collab must be run inside a git repository (no git repo detected at ' +
        (cwd || process.cwd()) + ').'
      );
    }
    throw new Error(
      'forge:collab could not read origin remote: ' + (stderr.trim() || e.message)
    );
  }
  return out.trim();
}

/**
 * Derive a stable 12-hex-character session ID from the repository's origin URL.
 *
 * Two clones of the same remote produce the same ID; different remotes produce
 * different IDs. This is the zero-config join primitive for /forge:collaborate.
 *
 * Options:
 *   - origin  explicit origin URL (skips git lookup -- used in tests and CI)
 *   - cwd     directory to inspect when reading `origin` from git
 *
 * Throws with a clear message when no origin remote exists or when called
 * outside a git repository.
 */
function sessionIdFromOrigin(opts) {
  opts = opts || {};
  const url = opts.origin != null ? opts.origin : readOriginUrl(opts.cwd);
  if (typeof url !== 'string' || !url.length) {
    throw new Error('forge:collab sessionIdFromOrigin requires a non-empty origin url');
  }
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
}

module.exports = {
  sessionIdFromOrigin,
  // Exposed for tests and future-task extension points:
  _internal: { readOriginUrl }
};
