const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

// T021 worktree squash-merge helpers are defined further below; see
// `completeTaskInWorktree` and `abortTaskInWorktree`.

// === YAML Frontmatter Parser (minimal, no dependencies) ===

// Parse the leading YAML frontmatter from a text blob. If multiple frontmatter
// blocks are stacked at the top of the file (an artifact of older writeState
// behavior pre forge-self-fixes R007), recursively merge all of them with
// LATER values winning, and return `content` as everything after the last
// frontmatter block. This lets setup-state be idempotent: any pre-existing
// stacked blocks collapse into a single canonical frontmatter on the next
// write, and writeState never prepends a duplicate block.
// _verifyStructuralAcs (forge-self-fixes R006)
//
// Walks a spec line by line, pulls out every `- [ ]` AC line, tries to
// parse it into one of three structural-claim shapes, and asserts each
// claim against the provided HTML body. Returns { pass, fail, skipped,
// failures, results } where `results` preserves per-AC outcomes and
// `failures` is just the subset with status === 'fail'.
function _verifyStructuralAcs(specText, html) {
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const lines = specText.split(/\r?\n/);
  const results = [];
  const failures = [];
  let pass = 0, fail = 0, skipped = 0;

  // Regexes keyed by INTENT, not phrase structure. We first detect the
  // verb ("exists", "contains", "N elements ... match") then pull parameters.
  // This tolerates markdown noise between the attribute and the verb
  // (backticks, italics, parenthetical asides).
  const TESTID_ATTR = /data-testid\s*=\s*["']([^"']+)["']/i;
  const QUOTED_STR = /["']([^"']+)["']/;
  const COUNT_PREFIX = /(?:exactly\s+)?(\d+)\s+elements?\s+(?:match|with|tagged|carrying)\b/i;
  const EXISTS_VERB = /\b(exists?|present|renders?|in\s+the\s+DOM|is\s+(?:an?\s+)?(?:element|descendant))\b/i;
  const CONTAINS_VERB = /\b(contains?|includes?)\b/i;
  const TEXT_SUBJECT = /\b(textContent|text\s+content|page\s+(?:text|content)|body\s+(?:text|content)|copy|prose|page|renders\s+text)\b/i;
  const LITERAL_CUE = /\bliteral\s+(?:substring|string|text)\b/i;

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!/^- \[[ xX]\]/.test(trimmed)) continue;

    const acText = trimmed.replace(/^- \[[ xX]\]\s*/, '');

    // Priority order matters. Count assertions include "elements match" which
    // also triggers EXISTS_VERB, so count comes first.
    const countMatch = acText.match(COUNT_PREFIX);
    const testidMatch = acText.match(TESTID_ATTR);

    if (countMatch && testidMatch) {
      const want = parseInt(countMatch[1], 10);
      const testid = testidMatch[1];
      const re = new RegExp(`data-testid\\s*=\\s*["']${_reEscape(testid)}["']`, 'g');
      const got = (html.match(re) || []).length;
      if (got === want) { results.push({ line: i + 1, status: 'pass', ac: acText, rule: 'testid-count', target: testid, want, got }); pass++; }
      else {
        const rec = { line: i + 1, status: 'fail', ac: acText, rule: 'testid-count', target: testid, want, got, reason: `expected ${want} elements with data-testid="${testid}", found ${got}` };
        results.push(rec); failures.push(rec); fail++;
      }
      continue;
    }

    if (testidMatch && EXISTS_VERB.test(acText) && !CONTAINS_VERB.test(acText)) {
      const testid = testidMatch[1];
      const has = html.includes(`data-testid="${testid}"`) || html.includes(`data-testid='${testid}'`);
      if (has) { results.push({ line: i + 1, status: 'pass', ac: acText, rule: 'testid-exists', target: testid }); pass++; }
      else {
        const rec = { line: i + 1, status: 'fail', ac: acText, rule: 'testid-exists', target: testid, reason: `data-testid="${testid}" not found in artifact` };
        results.push(rec); failures.push(rec); fail++;
      }
      continue;
    }

    // Text-contains: (a) mentions a text-subject keyword, OR (b) uses the
    // "literal substring" cue — either way we pull the first quoted string.
    if ((TEXT_SUBJECT.test(acText) || LITERAL_CUE.test(acText)) && CONTAINS_VERB.test(acText)) {
      const qm = acText.match(QUOTED_STR);
      if (qm) {
        const needle = qm[1];
        const has = bodyText.includes(needle);
        if (has) { results.push({ line: i + 1, status: 'pass', ac: acText, rule: 'text-contains', target: needle }); pass++; }
        else {
          const rec = { line: i + 1, status: 'fail', ac: acText, rule: 'text-contains', target: needle, reason: `text "${needle}" not found in rendered body` };
          results.push(rec); failures.push(rec); fail++;
        }
        continue;
      }
    }

    // Non-parseable → skipped with reason.
    results.push({ line: i + 1, status: 'skipped', ac: acText, reason: 'AC shape not recognised by minimal parser; needs headless DOM or Playwright' });
    skipped++;
  }

  return { pass, fail, skipped, failures, results };
}

function _reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseFrontmatter(text) {
  // CRLF-tolerant: every literal `\n` in the frontmatter regexes is `\r?\n`
  // so Windows-checkout specs (CRLF line endings) parse identically to LF.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: text };

  const data = _parseYamlLines(match[1]);
  let remainder = match[2];

  // Strip leading blank lines and recursively consume any additional stacked
  // frontmatter blocks. Later values shadow earlier ones (representing the
  // most recent write).
  while (true) {
    const lstripped = remainder.replace(/^\s*\n+/, '');
    if (!/^---\r?\n/.test(lstripped)) break;
    const next = lstripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!next) break;
    const moreData = _parseYamlLines(next[1]);
    Object.assign(data, moreData);
    remainder = next[2];
  }

  return { data, content: remainder };
}

function _parseYamlLines(block) {
  const data = {};
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let val = line.slice(sep + 1).trim();
    // Parse simple types
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (val === 'null') val = null;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    else if (/^-?\d+\.\d+$/.test(val)) val = parseFloat(val);
    else if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    data[key] = val;
  }
  return data;
}

function serializeFrontmatter(data, content) {
  const lines = [];
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val)) lines.push(`${key}: [${val.join(', ')}]`);
    else if (val === null) lines.push(`${key}: null`);
    else lines.push(`${key}: ${val}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n${content}`;
}

// === Config Loading ===

const DEFAULT_CONFIG = {
  autonomy: 'gated',
  depth: 'standard',
  auto_detect_depth: true,
  max_iterations: 100,
  token_budget: 500000,
  // Session-wide token budget. Mirrors token_budget for clarity with Phase 1
  // (R003) of the gsd2-caveman-integration spec. token_budget remains for
  // backward compatibility; new code should prefer session_budget_tokens.
  session_budget_tokens: 500000,
  // Per-task token ceilings keyed by depth. Used by the loop to short-circuit
  // a task that blows past its budget instead of letting it consume the whole
  // session budget. (R001)
  // v0.2.0 recalibration: lowered toward v0.1.0 baselines (quick=5k, std=15k,
  // thorough=40k) now that compression features (context compression, caveman
  // prompts, checkpoint bundles) reduce per-task overhead.
  per_task_budget: {
    quick: 6000,
    standard: 16000,
    thorough: 42000
  },
  // When true, internal prompts dispatched to subagents are run through the
  // caveman/terse-prompt skill to reduce token cost. Default on since R005;
  // set to false to opt out. (R002, R005)
  terse_internal: true,
  // When true, each task is implemented inside its own git worktree to
  // isolate changes and allow parallel execution. (R004)
  use_worktrees: true,
  // Optional URL to POST status updates to when running headless. Null
  // disables headless notifications.
  headless_notify_url: null,
  context_reset_threshold: 60,
  // Approximate total context window in tokens, used by the context-reset
  // estimator. Default assumes 200k. 1M-context models (e.g. claude-opus-4-7
  // [1m]) should set this to 1000000 in .forge/config.json, or override at
  // runtime with the FORGE_CONTEXT_WINDOW env var.
  context_window_tokens: 200000,
  repos: {},
  cross_repo_rules: { commit_in_source: true, api_first: true, shared_specs: true },
  loop: {
    circuit_breaker_test_fails: 3,
    circuit_breaker_debug_attempts: 3,
    circuit_breaker_review_iterations: 3,
    circuit_breaker_no_progress: 2,
    single_task_budget_percent: 20
  },
  review: { enabled: true, min_depth: 'standard', model: 'claude' },
  verification: { enabled: true, min_depth: 'standard', stub_detection: true },
  backprop: { auto_generate_regression_tests: true, re_run_after_spec_update: false },
  capability_hints: {},
  parallelism: { max_concurrent_agents: 3, max_concurrent_per_repo: 2 },
  model_routing: {
    enabled: true,
    cost_weights: { haiku: 1, sonnet: 5, opus: 25 },
    role_baselines: {
      'forge-researcher': { min: 'haiku', preferred: 'sonnet', max: 'sonnet' },
      'forge-complexity': { min: 'haiku', preferred: 'haiku', max: 'haiku' },
      'forge-executor': { min: 'haiku', preferred: 'sonnet', max: 'opus' },
      'forge-reviewer': { min: 'sonnet', preferred: 'sonnet', max: 'opus' },
      'forge-verifier': { min: 'sonnet', preferred: 'sonnet', max: 'opus' },
      'forge-speccer': { min: 'sonnet', preferred: 'opus', max: 'opus' },
      'forge-planner': { min: 'sonnet', preferred: 'sonnet', max: 'opus' }
    }
  },
  hooks_config: { test_filter: true, progress_tracker: true, tool_cache: true, tool_cache_ttl: 120 },
  replanning: { enabled: true, concern_threshold: 0.3 },
  redecomposition: { enabled: true, max_expansion_depth: 1 },
  codex: {
    enabled: true,
    review: {
      enabled: true,
      depth_threshold: 'standard',
      model: 'gpt-5.4-mini',
      sensitive_tags: ['security', 'shared', 'api-export']
    },
    rescue: {
      enabled: true,
      debug_attempts_before_rescue: 2,
      model: null
    }
  },
  // T029 / R006: per-AC streaming DAG. Default on. Downstream tasks dispatch
  // provisionally the moment an upstream AC they declared as a dependency is
  // met, with rollback on regression and bounded speculation. Set to false
  // only if you need strict tier-by-tier serial execution (rare).
  streaming_dag: {
    enabled: true,
    max_provisional: 3,
    max_failures_before_fallback: 2
  }
};

function loadConfig(projectDir) {
  const configPath = path.join(projectDir, '.forge', 'config.json');
  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) { /* no config file, use defaults */ }
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), userConfig);
}

// getConfig: safe accessor for individual config values with backward
// compatibility. Supports dot-paths (e.g. 'per_task_budget.standard',
// 'codex.review.model'). If any segment of the path is missing in the user's
// config (or in DEFAULT_CONFIG), the supplied fallback is returned. This lets
// existing .forge/config.json files keep working as new fields are added.
//
// Usage:
//   const cfg = loadConfig(projectDir);
//   const sessionBudget = getConfig(cfg, 'session_budget_tokens', 500000);
//   const stdBudget = getConfig(cfg, 'per_task_budget.standard', 15000);
//   const terse = getConfig(cfg, 'terse_internal', false);
function getConfig(config, key, fallback) {
  if (!config || typeof config !== 'object') return fallback;
  if (typeof key !== 'string' || key.length === 0) return fallback;
  const segments = key.split('.');
  let cursor = config;
  for (const seg of segments) {
    if (cursor == null || typeof cursor !== 'object' || !(seg in cursor)) {
      return fallback;
    }
    cursor = cursor[seg];
  }
  return cursor === undefined ? fallback : cursor;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// === Safe Shell Helpers ===
// Uses execFileSync (no shell) to prevent command injection.
// All git commands are hardcoded — no user input is interpolated.

function gitDiffStat() {
  try {
    return execFileSync('git', ['diff', 'HEAD', '--stat'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    return '';
  }
}

function gitLogOneline(count) {
  try {
    return execFileSync('git', ['log', '--oneline', `-${count || 10}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    return '';
  }
}

// === Git Worktree Management ===
// Per-task git worktrees at .forge/worktrees/{task-id}/. Lets each task work
// in isolation so parallel/sequential tasks don't interfere and so failed
// tasks can be discarded by removing the worktree directory. (R004, R006)
//
// Design rules:
//   - Never throw on git failures. Always return a status object with a
//     `fallback: 'in-place'` hint so the caller can degrade gracefully.
//   - Use execFileSync (no shell) to keep arg quoting safe across platforms.
//   - Forward slashes in JS, git accepts them on Windows + WSL + Linux.
//   - 30s timeout per git op (worktree add can be slow on cold caches).
//   - Skip cheap tasks (quick + <=1 file) where worktree overhead exceeds
//     the benefit. Pure research tasks (0 files) also skip.

const WORKTREE_TIMEOUT_MS = 30000;

function _worktreeRelPath(taskId) {
  // Always forward slashes; git is happy with them on every platform.
  return `.forge/worktrees/${taskId}`;
}

function _runGit(args, projectRoot) {
  // Returns { ok, stdout, stderr, error }. Never throws.
  try {
    const stdout = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: WORKTREE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    const stderr = (e && e.stderr && e.stderr.toString()) || '';
    const stdout = (e && e.stdout && e.stdout.toString()) || '';
    return {
      ok: false,
      stdout,
      stderr,
      error: (e && e.message) || 'unknown git error'
    };
  }
}

function createTaskWorktree(forgeDir, taskId, options) {
  options = options || {};
  const depth = options.depth || 'standard';
  const filesTouched = Array.isArray(options.filesTouched) ? options.filesTouched : [];
  const projectRoot = options.projectRoot || path.dirname(forgeDir);

  // Honor use_worktrees toggle from config.
  let useWorktrees = true;
  try {
    const cfg = loadConfig(projectRoot);
    useWorktrees = getConfig(cfg, 'use_worktrees', true);
  } catch (e) { /* default true */ }

  if (!useWorktrees) {
    return { created: false, reason: 'disabled_by_config', fallback: 'in-place' };
  }

  // Skip pure research/spec tasks (no files touched).
  if (filesTouched.length === 0) {
    return { created: false, reason: 'no_files_touched', fallback: 'in-place' };
  }

  // Skip cheap quick tasks (single-file edits) where worktree overhead is
  // disproportionate to the work being done.
  if (depth === 'quick' && filesTouched.length <= 1) {
    return { created: false, reason: 'quick_single_file', fallback: 'in-place' };
  }

  const relPath = _worktreeRelPath(taskId);
  const absPath = path.join(projectRoot, '.forge', 'worktrees', taskId).replace(/\\/g, '/');

  // Make sure parent dir exists so git worktree add doesn't fail on a missing
  // intermediate directory on some platforms.
  try {
    fs.mkdirSync(path.join(projectRoot, '.forge', 'worktrees'), { recursive: true });
  } catch (e) { /* best effort */ }

  // If a worktree already exists at that path, treat it as already-created.
  // git worktree add would otherwise fail with "already exists".
  if (fs.existsSync(path.join(projectRoot, '.forge', 'worktrees', taskId))) {
    return { created: true, path: absPath, reason: 'already_exists' };
  }

  // execFileSync handles arg quoting safely; spaces in projectRoot are fine
  // because each arg is passed as its own array element (no shell parsing).
  const result = _runGit(['worktree', 'add', relPath, 'HEAD'], projectRoot);
  if (!result.ok) {
    return {
      created: false,
      reason: 'git_error',
      error: (result.stderr || result.error || '').trim(),
      fallback: 'in-place'
    };
  }

  return { created: true, path: absPath };
}

function removeTaskWorktree(forgeDir, taskId, projectRoot) {
  projectRoot = projectRoot || path.dirname(forgeDir);
  const relPath = _worktreeRelPath(taskId);
  const absPath = path.join(projectRoot, '.forge', 'worktrees', taskId);

  // First try the clean git path with --force to also drop dirty changes.
  const result = _runGit(['worktree', 'remove', relPath, '--force'], projectRoot);
  if (result.ok) {
    return { removed: true };
  }

  // Filesystem fallback: if git refuses (corrupt admin dir, missing repo),
  // remove the directory directly. Best effort, never throws.
  try {
    if (fs.existsSync(absPath)) {
      fs.rmSync(absPath, { recursive: true, force: true });
    }
    // Also prune so git's worktree admin state matches reality on disk.
    _runGit(['worktree', 'prune'], projectRoot);
    return { removed: true, reason: 'filesystem_fallback' };
  } catch (e) {
    return {
      removed: false,
      reason: 'remove_failed',
      error: (e && e.message) || 'unknown remove error'
    };
  }
}

function listTaskWorktrees(forgeDir, projectRoot) {
  projectRoot = projectRoot || path.dirname(forgeDir);
  const result = _runGit(['worktree', 'list', '--porcelain'], projectRoot);
  if (!result.ok) {
    return [];
  }

  // Porcelain format: blank-line separated records, each with lines like:
  //   worktree /abs/path/to/wt
  //   HEAD <sha>
  //   branch refs/heads/<name>      (or the literal "detached")
  const worktrees = [];
  const blocks = result.stdout.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const entry = { task_id: null, path: null, commit: null, branch: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice('worktree '.length).trim().replace(/\\/g, '/');
      } else if (line.startsWith('HEAD ')) {
        entry.commit = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim();
      } else if (line.trim() === 'detached') {
        entry.branch = 'detached';
      }
    }
    if (!entry.path) continue;

    // Ext