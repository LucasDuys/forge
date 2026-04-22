#!/usr/bin/env node
// scripts/forge-speccer-validator.cjs
//
// Spec path-validation gate (spec-forge-v03-gaps R011 / T004).
//
// Exports `validateSpecPaths(specPath, repoRoot)` which scans a spec file
// for path tokens appearing inside code fences or backticks and confirms
// each one exists in the target repo. Missing paths are returned with
// the spec line number and a short context snippet so the replan agent
// can correct them before the planner runs.
//
// Also exports `findNearestPath(missingPath, repoRoot, opts)` which walks
// the repo (bounded) and returns the closest-match file path by basename
// and directory similarity — used by the replan autocorrect step.
//
// Spec-author syntax (forge-self-fixes R001):
//   `path/to/file.ext`           — precondition path, must exist before planning
//   `{create:path/to/file.ext}`  — creation target, will exist after the task runs
// Creation targets are extracted to a separate `creation_targets` array in the
// output and are skipped by the existence check.
//
// CLI usage:
//   node scripts/forge-speccer-validator.cjs <spec-path> [repo-root]
//
// Exit codes:
//   0  all paths valid -> stdout prints {"valid":true,"missing":[],"creation_targets":[...]}
//   2  one or more missing paths -> stdout prints {"valid":false,"missing":[...],"creation_targets":[...]}
//   1  fatal error (bad args, spec not readable)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// Heuristic: a path token is any string inside a code fence or backticks that
// matches this shape. Starts lowercase letter, made of [a-z0-9_/.-], ends in
// a known source/config extension. URLs contain `://` and are skipped at the
// candidate-extraction step. Spaces are disallowed by the character class.
// =============================================================================

const PATH_RE = /^[a-z][a-z0-9_/.-]*\.(md|cjs|mjs|js|ts|tsx|jsx|py|go|rs|sh|json|yaml|yml|toml)$/i;

// Splitters for pulling candidate tokens out of a code fence or backtick
// span. Anything whitespace-delimited, comma-separated, or parenthesised is a
// candidate. We then filter each candidate through PATH_RE.
const TOKEN_SPLIT_RE = /[\s,()[\]<>"']+/;

// Creation-target syntax: {create:path/to/file.ext}. Captures the inner path
// when it otherwise matches PATH_RE. Applied before the generic splitter so a
// span like "{create:src/App.tsx}" is classified as a creation target rather
// than an unrelated non-match. Matches are case-insensitive on the prefix.
const CREATE_TOKEN_RE = /\{create:([^}]+)\}/gi;

// =============================================================================
// Extraction — walk the spec line by line, track whether we are inside a
// ``` fenced block, and inside each line pull out every `backtick span`.
// For each span and each fenced-block line, first harvest create-target
// tokens, then split into plain candidate tokens and retain those matching
// PATH_RE and not containing `://`.
// =============================================================================

function extractPathTokens(specText) {
  const lines = specText.split(/\r?\n/);
  const plainHits = []; // { line, path, context }
  const createHits = []; // { line, path, context }
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Toggle fence state on any ``` line (opening or closing).
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      // Entire line is source context; scan all tokens on the line.
      collectCreateTokens(raw, raw, i + 1, createHits);
      collectPlainTokens(stripCreateTokens(raw), raw, i + 1, plainHits);
      continue;
    }

    // Outside fence — only tokens inside backtick spans count.
    const spanRe = /`([^`]+)`/g;
    let m;
    while ((m = spanRe.exec(raw)) !== null) {
      const span = m[1];
      collectCreateTokens(span, raw, i + 1, createHits);
      collectPlainTokens(stripCreateTokens(span), raw, i + 1, plainHits);
    }
  }

  return { plainHits, createHits };
}

function collectCreateTokens(source, contextLine, lineNo, hits) {
  // exec() mutates lastIndex on a shared regex; use matchAll for safety.
  const matches = source.matchAll(CREATE_TOKEN_RE);
  for (const m of matches) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    if (!PATH_RE.test(inner)) continue;
    hits.push({ line: lineNo, path: inner, context: contextLine.trim() });
  }
}

function stripCreateTokens(source) {
  return source.replace(CREATE_TOKEN_RE, ' ');
}

function collectPlainTokens(source, contextLine, lineNo, hits) {
  const candidates = source.split(TOKEN_SPLIT_RE).filter(Boolean);
  for (let tok of candidates) {
    // Strip trailing punctuation like `.` `,` `:` `;` that commonly wraps
    // an inline path reference in prose. Also strip a leading `{` or trailing
    // `}` in case a malformed create-token left residue.
    tok = tok.replace(/^[{]+/, '').replace(/[}.,:;!?]+$/, '');
    if (!tok) continue;
    if (tok.includes('://')) continue;        // URLs
    if (tok.includes(' ')) continue;          // safety net
    if (!PATH_RE.test(tok)) continue;
    hits.push({ line: lineNo, path: tok, context: contextLine.trim() });
  }
}

// =============================================================================
// Validation — for each extracted plain path, check whether it exists on disk
// under repoRoot. Creation-target tokens are passed through to the output but
// never existence-checked. Dedup by (path) to avoid reporting the same missing
// path 20 times when a spec references it repeatedly; keep the first
// occurrence's line + ctx.
// =============================================================================

function validateSpecPaths(specPath, repoRoot) {
  if (!specPath || typeof specPath !== 'string') {
    throw new Error('validateSpecPaths: specPath must be a string');
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('validateSpecPaths: repoRoot must be a string');
  }

  const specText = fs.readFileSync(specPath, 'utf8');
  const { plainHits, createHits } = extractPathTokens(specText);

  // Creation targets shadow plain hits — a path appearing in a {create:} span
  // is ALWAYS treated as a creation target, even if the same path also
  // appears as a plain backtick elsewhere in the spec. This lets authors
  // explicitly opt out of precondition-gating per-path.
  const creationPaths = new Set(createHits.map(h => h.path));

  const seen = new Set();
  const missing = [];
  for (const hit of plainHits) {
    if (creationPaths.has(hit.path)) continue;
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    const abs = path.resolve(repoRoot, hit.path);
    if (!fs.existsSync(abs)) {
      missing.push(hit);
    }
  }

  // Dedup creation_targets by path so the output is stable.
  const createSeen = new Set();
  const creationTargets = [];
  for (const hit of createHits) {
    if (createSeen.has(hit.path)) continue;
    createSeen.add(hit.path);
    creationTargets.push(hit);
  }

  return {
    valid: missing.length === 0,
    missing,
    creation_targets: creationTargets
  };
}

// =============================================================================
// Autocorrect — find the nearest existing path in the repo by matching
// basename first, then ranking candidates by shared path segments with the
// missing path. Bounded fs walk keeps runtime predictable on large repos.
//
// Returns { match: string | null, candidates: string[] } where `match` is the
// best candidate (or null if no same-basename file found) and `candidates` is
// the ranked list (best first) up to opts.maxResults.
// =============================================================================

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.forge', 'dist', 'build',
  '.next', '.cache', 'coverage', '.venv', '__pycache__'
]);

function findNearestPath(missingPath, repoRoot, opts) {
  opts = opts || {};
  const maxResults = opts.maxResults || 5;
  const maxDepth = opts.maxDepth || 8;
  const ignore = opts.ignore || DEFAULT_IGNORE;

  const wantBase = path.basename(missingPath);
  const wantSegments = missingPath.split(/[\\/]/).filter(Boolean);

  const matches = []; // { rel, score }

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ignore.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
      } else if (ent.isFile() && ent.name === wantBase) {
        const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
        const relSegments = rel.split('/').filter(Boolean);
        // Score = count of directory segments shared with the missing path.
        // Higher score = closer match. Ties broken by shorter rel-path.
        let shared = 0;
        for (const seg of wantSegments) {
          if (relSegments.includes(seg)) shared++;
        }
        matches.push({ rel, score: shared, len: rel.length });
      }
    }
  }

  walk(repoRoot, 0);

  matches.sort((a, b) => b.score - a.score || a.len - b.len);
  const ranked = matches.slice(0, maxResults).map(m => m.rel);
  return {
    match: ranked.length > 0 ? ranked[0] : null,
    candidates: ranked
  };
}

// =============================================================================
// CLI entry point
// =============================================================================

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 1) {
    process.stderr.write(
      'usage: node forge-speccer-validator.cjs <spec-path> [repo-root]\n'
    );
    return 1;
  }
  const specPath = args[0];
  const repoRoot = args[1] || process.cwd();
  let result;
  try {
    result = validateSpecPaths(specPath, repoRoot);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.valid ? 0 : 2;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  validateSpecPaths,
  findNearestPath,
  extractPathTokens,
  PATH_RE,
  CREATE_TOKEN_RE
};
