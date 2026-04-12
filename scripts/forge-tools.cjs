const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

// T021 worktree squash-merge helpers are defined further below; see
// `completeTaskInWorktree` and `abortTaskInWorktree`.

// === YAML Frontmatter Parser (minimal, no dependencies) ===

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: text };

  const data = {};
  for (const line of match[1].split('\n')) {
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
  return { data, content: match[2] };
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
  per_task_budget: {
    quick: 5000,
    standard: 15000,
    thorough: 40000
  },
  // When true, internal prompts dispatched to subagents are run through the
  // caveman/terse-prompt skill to reduce token cost. Opt-in until validated
  // against quality regressions. (R002)
  terse_internal: false,
  // When true, each task is implemented inside its own git worktree to
  // isolate changes and allow parallel execution. (R004)
  use_worktrees: true,
  // Optional URL to POST status updates to when running headless. Null
  // disables headless notifications.
  headless_notify_url: null,
  context_reset_threshold: 60,
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

    // Extract task_id from .forge/worktrees/{task-id} paths. Anything not
    // under .forge/worktrees/ is the main checkout or an unrelated worktree
    // and gets task_id: null so the caller can filter.
    const m = entry.path.match(/\.forge\/worktrees\/([^/]+)\/?$/);
    if (m) entry.task_id = m[1];

    worktrees.push(entry);
  }
  return worktrees;
}

// === Worktree Squash-Merge / Abort (T021, R004) ===
//
// Bridges createTaskWorktree (T008) and the task completion path so work done
// inside a per-task worktree gets squash-merged back into the parent branch
// as a single atomic commit. On merge conflict the worktree is preserved and
// state.md transitions to `conflict_resolution` so the scheduler can fall
// back to sequential execution for the remainder of the tier.

function _findTaskWorktree(forgeDir, taskId, projectRoot) {
  const list = listTaskWorktrees(forgeDir, projectRoot);
  for (const wt of list) {
    if (wt.task_id === taskId) return wt;
  }
  return null;
}

function _deriveSpecDomain(forgeDir) {
  // Look at state first, then fall back to scanning the plans directory.
  try {
    const state = readState(forgeDir);
    const spec = state.data && state.data.spec;
    if (spec) {
      const m = String(spec).match(/spec-([^/\\]+?)\.md$/) ||
                String(spec).match(/([^/\\]+?)-frontier\.md$/);
      if (m) return m[1];
    }
  } catch (e) { /* ignore */ }
  try {
    const planDir = path.join(forgeDir, 'plans');
    const plans = fs.readdirSync(planDir).filter(f => f.endsWith('-frontier.md'));
    if (plans.length === 1) return plans[0].replace(/-frontier\.md$/, '');
  } catch (e) { /* ignore */ }
  return 'task';
}

function _findTaskMeta(forgeDir, taskId) {
  // Best-effort scan of all frontier files for the task's display name and
  // numeric suffix. Returns { name, num } with sane fallbacks.
  const meta = { name: taskId, num: (taskId.match(/(\d+)$/) || [null, ''])[1] || '' };
  try {
    const planDir = path.join(forgeDir, 'plans');
    const plans = fs.readdirSync(planDir).filter(f => f.endsWith('-frontier.md'));
    for (const plan of plans) {
      const text = fs.readFileSync(path.join(planDir, plan), 'utf8');
      const tasks = parseFrontier(text);
      const hit = tasks.find(t => t.id === taskId);
      if (hit) {
        if (hit.name) meta.name = hit.name;
        return meta;
      }
    }
  } catch (e) { /* ignore */ }
  return meta;
}

function _appendStateLog(forgeDir, line) {
  // Caveman-form append: short fragment, no flourish, one line.
  try {
    writeState(forgeDir, { __contentAppend: `\n${line}` });
  } catch (e) { /* state may be locked; logging is best-effort */ }
}

function completeTaskInWorktree(forgeDir, taskId, projectRoot) {
  projectRoot = projectRoot || path.dirname(forgeDir);

  const wt = _findTaskWorktree(forgeDir, taskId, projectRoot);
  if (!wt) {
    // No worktree -- task ran in-place. Nothing to merge.
    return { merged: false, reason: 'no_worktree' };
  }

  const wtCommit = wt.commit || '';
  if (!wtCommit) {
    return { merged: false, reason: 'worktree_missing_head' };
  }

  // If worktree HEAD equals parent HEAD, nothing was committed inside the
  // worktree -- nothing to merge.
  const parentHead = _runGit(['rev-parse', 'HEAD'], projectRoot);
  if (parentHead.ok && parentHead.stdout.trim() === wtCommit) {
    const removed = removeTaskWorktree(forgeDir, taskId, projectRoot);
    return {
      merged: false,
      reason: 'no_new_commits',
      worktree_removed: !!(removed && removed.removed)
    };
  }

  const domain = _deriveSpecDomain(forgeDir);
  const meta = _findTaskMeta(forgeDir, taskId);
  const numFragment = meta.num ? `T${meta.num}` : taskId;
  const message = `forge(${domain}): ${meta.name} [${numFragment}]`;

  // --squash stages the diff but does not create a commit.
  const squash = _runGit(['merge', '--squash', wtCommit], projectRoot);
  if (!squash.ok) {
    // Git emits the conflict banner to stdout, not stderr -- inspect both.
    const combined = ((squash.stdout || '') + '\n' + (squash.stderr || '')).trim();
    const stderr = (squash.stderr || squash.error || '').trim() || combined;
    const looksLikeConflict = /conflict|CONFLICT|merge .* failed|automatic merge failed/i.test(combined);
    if (looksLikeConflict) {
      // Abort the half-staged squash so the parent index is clean. Git's
      // "merge --squash" leaves files in conflicted state but does NOT mark
      // a real merge in progress, so `reset --merge` is the safe undo.
      _runGit(['reset', '--merge'], projectRoot);
      // Preserve worktree, transition phase, log caveman-form fragment.
      try {
        writeState(forgeDir, {
          phase: 'conflict_resolution',
          task_status: 'conflict',
          blocked_reason: 'squash_merge_conflict',
          conflict_task: taskId
        });
      } catch (e) { /* best effort */ }
      _appendStateLog(forgeDir, `- conflict ${taskId} squash merge halt worktree kept`);
      return {
        merged: false,
        reason: 'merge_conflict',
        worktree_preserved: true,
        error: stderr
      };
    }
    // Non-conflict failure: reset any partial staging so the parent tree is
    // not left half-merged. Worktree preserved for inspection.
    _runGit(['reset', '--merge'], projectRoot);
    return {
      merged: false,
      reason: 'git_error',
      worktree_preserved: true,
      error: stderr
    };
  }

  // Commit the squashed staging area as a single atomic commit.
  const commit = _runGit(['commit', '-m', message], projectRoot);
  if (!commit.ok) {
    const stderr = (commit.stderr || commit.error || '').trim();
    if (/nothing to commit|no changes added/i.test(stderr)) {
      _runGit(['reset', '--merge'], projectRoot);
      const removed = removeTaskWorktree(forgeDir, taskId, projectRoot);
      return {
        merged: false,
        reason: 'empty_squash',
        worktree_removed: !!(removed && removed.removed)
      };
    }
    return {
      merged: false,
      reason: 'commit_failed',
      worktree_preserved: true,
      error: stderr
    };
  }

  let sha = '';
  const head = _runGit(['rev-parse', 'HEAD'], projectRoot);
  if (head.ok) sha = head.stdout.trim();

  const removed = removeTaskWorktree(forgeDir, taskId, projectRoot);
  _appendStateLog(forgeDir, `- merge ${taskId} squash ok ${sha.slice(0, 7)}`);

  return {
    merged: true,
    commit_sha: sha,
    message,
    worktree_removed: !!(removed && removed.removed)
  };
}

function abortTaskInWorktree(forgeDir, taskId, projectRoot) {
  projectRoot = projectRoot || path.dirname(forgeDir);
  const wt = _findTaskWorktree(forgeDir, taskId, projectRoot);
  if (!wt) {
    return { aborted: false, reason: 'no_worktree' };
  }
  // removeTaskWorktree already uses --force, which drops dirty changes inside
  // the worktree. We never touch the parent branch on abort -- that is the
  // whole point of this path.
  const removed = removeTaskWorktree(forgeDir, taskId, projectRoot);
  if (removed && removed.removed) {
    _appendStateLog(forgeDir, `- abort ${taskId} worktree dropped`);
    return { aborted: true };
  }
  return {
    aborted: false,
    reason: (removed && removed.reason) || 'remove_failed',
    error: (removed && removed.error) || null
  };
}

// === Token Estimation ===
// Fix #1: Parse JSONL and weight by content type instead of raw char/4 heuristic.
// Tool results have higher char/token ratios due to formatting, code blocks, paths.
// System prompts are denser. Natural language is the baseline.

function estimateTokensFromTranscript(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.role || '';

        // Extract text content from structured messages
        let textContent = '';
        if (typeof entry.content === 'string') {
          textContent = entry.content;
        } else if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block.type === 'text') textContent += block.text || '';
            else if (block.type === 'tool_use') textContent += JSON.stringify(block.input || {});
            else if (block.type === 'tool_result') {
              textContent += typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content || '');
            }
          }
        }

        const charCount = textContent.length;

        // Weight by content type:
        // - Tool results: heavy formatting, code blocks, file paths (~5 chars/token)
        // - System prompts: dense with instructions, skills (~3.5 chars/token)
        // - Natural language (user/assistant): baseline (~4 chars/token)
        if (role === 'tool' || entry.type === 'tool_result') {
          totalTokens += Math.ceil(charCount / 5);
        } else if (role === 'system') {
          totalTokens += Math.ceil(charCount / 3.5);
        } else {
          totalTokens += Math.ceil(charCount / 4);
        }
      } catch (e) {
        // Non-JSON line — estimate raw
        totalTokens += Math.ceil(line.length / 4);
      }
    }

    return totalTokens;
  } catch (e) {
    return 0;
  }
}

// === State Management ===

// === Caveman formatting (T029, R013) ===
//
// Lossy lexical compression of free-text values written into state.md bodies and
// checkpoint context fields. Intentionally simple: rule-based string rewrites,
// no semantic understanding, no NLP. The goal is ~20% reduction on the write
// path, not perfection. The reader is unchanged because the parser only cares
// about structured fields and treats body text as opaque.
//
// Bypass: pass `{ skipCavemanFormat: true }` to writeState/writeCheckpoint when
// the content is intentionally verbose (commit messages copied into state,
// user-facing errors that humans will read directly, security warnings).
//
// The transform is line-aware and code-fence-aware so it never rewrites code.

const CAVEMAN_FILLER_WORDS = [
  'just', 'really', 'basically', 'very', 'quite', 'simply', 'actually',
  'essentially', 'indeed', 'clearly', 'obviously', 'literally',
  'somewhat', 'rather', 'fairly', 'pretty', 'definitely', 'certainly',
  'currently', 'presently'
];
const CAVEMAN_PLEASANTRIES = [
  'please', 'kindly'
];
const CAVEMAN_PLEASANTRY_PHRASES = [
  /\bhappy to help\b/gi,
  /\bof course\b/gi,
  /\bplease note that\b/gi,
  /\bplease note\b/gi,
  /\bit should be noted that\b/gi,
  /\bit should be noted\b/gi,
  /\bas you can see\b/gi,
  /\bas mentioned( above| earlier| before)?\b/gi
];
const CAVEMAN_PHRASE_SWAPS = [
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bdue to\b/gi, 'from'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin addition to\b/gi, 'plus'],
  [/\bin addition,?\b/gi, 'also'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith regard to\b/gi, 're'],
  [/\bwith respect to\b/gi, 're'],
  [/\bin terms of\b/gi, 're'],
  [/\ba number of\b/gi, 'some'],
  [/\ba couple of\b/gi, '2'],
  [/\bI have\b/g, ''],
  [/\bI've\b/g, ''],
  [/\bI just\b/g, ''],
  [/\bI am\b/g, ''],
  [/\bwe have\b/gi, ''],
  [/\bthere is\b/gi, ''],
  [/\bthere are\b/gi, ''],
  [/\bit is\b/gi, ''],
  [/\bnoted that\b/gi, 'noted:'],
  [/\bsuggested that\b/gi, 'suggested:'],
  [/\bmake sure (that )?\b/gi, 'ensure '],
  [/\bin case of\b/gi, 'on'],
  [/\bbefore (the )?landing\b/gi, 'pre-merge']
];
const CAVEMAN_WORD_SWAPS = [
  [/\bimplemented\b/gi, 'added'],
  [/\bimplementing\b/gi, 'adding'],
  [/\bimplements\b/gi, 'adds'],
  [/\bimplement\b/gi, 'add'],
  [/\butilized\b/gi, 'used'],
  [/\butilizing\b/gi, 'using'],
  [/\butilizes\b/gi, 'uses'],
  [/\butilize\b/gi, 'use'],
  [/\bdemonstrated\b/gi, 'showed'],
  [/\bdemonstrating\b/gi, 'showing'],
  [/\bdemonstrates\b/gi, 'shows'],
  [/\bdemonstrate\b/gi, 'show'],
  [/\bapproximately\b/gi, 'about'],
  [/\bmodified\b/gi, 'changed'],
  [/\bmodifying\b/gi, 'changing'],
  [/\bmodifies\b/gi, 'changes'],
  [/\bmodify\b/gi, 'change']
];

function _cavemanLine(line) {
  // Capture original leading whitespace so list markers stay aligned even
  // when the substitutions strip the first word of the line.
  const leading = (line.match(/^[ \t]*/) || [''])[0];
  let out = line.slice(leading.length);

  // Phrase-level swaps first (longer match wins).
  for (const re of CAVEMAN_PLEASANTRY_PHRASES) out = out.replace(re, '');
  for (const [re, repl] of CAVEMAN_PHRASE_SWAPS) out = out.replace(re, repl);
  for (const [re, repl] of CAVEMAN_WORD_SWAPS) out = out.replace(re, repl);

  // Drop articles followed by a space. Word boundary on left, space on right
  // so we never strip the trailing word.
  out = out.replace(/\b(the|a|an) /gi, '');

  // Drop filler + pleasantry single words plus optional trailing space.
  const fillerRe = new RegExp('\\b(' + CAVEMAN_FILLER_WORDS.concat(CAVEMAN_PLEASANTRIES).join('|') + ')\\b ?', 'gi');
  out = out.replace(fillerRe, '');

  // Collapse internal whitespace and trim leading/trailing space introduced
  // by deletions.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

  return leading + out;
}

function formatCavemanValue(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Sentinel: caller marked text as intentionally verbose.
  if (text.indexOf('<!-- verbose -->') !== -1) return text;

  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip code fences entirely. Both opening and closing fence lines pass through.
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // Skip indented code blocks (4+ spaces or a tab at line start with non-list content).
    if (/^(\t| {4,})\S/.test(line) && !/^[ \t]*[-*+]\s/.test(line)) continue;
    lines[i] = _cavemanLine(line);
  }
  return lines.join('\n');
}

function _cavemanCheckpointFields(cp) {
  // Apply only to free-text fields. Structured fields (task_id, current_step
  // enum, timestamps, arrays of file paths) are left alone.
  if (cp.context_bundle && typeof cp.context_bundle === 'object') {
    const cb = {};
    for (const [k, v] of Object.entries(cp.context_bundle)) {
      cb[k] = (typeof v === 'string') ? formatCavemanValue(v) : v;
    }
    cp.context_bundle = cb;
  }
  if (Array.isArray(cp.error_log)) {
    cp.error_log = cp.error_log.map(entry => {
      if (typeof entry === 'string') return formatCavemanValue(entry);
      if (entry && typeof entry === 'object' && typeof entry.msg === 'string') {
        return Object.assign({}, entry, { msg: formatCavemanValue(entry.msg) });
      }
      return entry;
    });
  }
  return cp;
}

function readState(forgeDir) {
  const statePath = path.join(forgeDir, 'state.md');
  try {
    return parseFrontmatter(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { data: {}, content: '' };
  }
}

// === Atomic writeState + Lock Primitives (T007, R007) ===
//
// Cross-platform quirks worth knowing:
//   - Windows: fs.renameSync overwrites existing files since Node 10, but can
//     throw EBUSY/EPERM if the destination is held open by another process
//     (antivirus, editor, the loop hook reading state.md). We retry with
//     exponential backoff up to 3 times.
//   - Windows: fs.renameSync across volumes throws EXDEV. We always write the
//     temp file in the same directory as state.md so this never fires.
//   - WSL: state.md on a Windows mount (/mnt/c) inherits Windows semantics.
//     Same EBUSY mitigation applies.
//   - POSIX: rename(2) is atomic so the retry loop is essentially a no-op
//     unless the filesystem itself is misbehaving (NFS, FUSE).
//   - File locking via OS primitives (flock/LockFileEx) is not portable from
//     Node without native deps, so the lock here is advisory: we use the
//     presence of .forge-loop.lock plus a heartbeat freshness check.

function _atomicWriteFile(targetPath, contents) {
  const dir = path.dirname(targetPath);
  // Same-directory temp file guarantees rename() stays on one volume.
  const tmpPath = path.join(dir, path.basename(targetPath) + '.tmp');
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmpPath, contents);
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'EACCES') {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }
      // Exponential backoff: 25ms, 75ms, 175ms (sync spin to keep API simple).
      const delay = 25 * (Math.pow(2, attempt + 1) - 1);
      const until = Date.now() + delay;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  throw lastErr || new Error('atomic write failed');
}

// writeState supports two calling conventions for backward compatibility:
//   writeState(forgeDir, data, content [, opts])   -- legacy full-write (atomic)
//   writeState(forgeDir, updates [, opts])         -- partial frontmatter merge.
//                                            Reserved keys in `updates`:
//                                              __content       -- replaces body
//                                              __contentAppend -- appended to body
//   opts: { skipCavemanFormat: bool }  -- default false; caveman is on by default
function writeState(forgeDir, dataOrUpdates, contentOrOpts, maybeOpts) {
  const statePath = path.join(forgeDir, 'state.md');

  // Detect legacy 3-arg form: 3rd arg is a string (content body).
  if (arguments.length >= 3 && typeof contentOrOpts === 'string') {
    const opts = maybeOpts || {};
    const body = opts.skipCavemanFormat ? contentOrOpts : formatCavemanValue(contentOrOpts);
    _atomicWriteFile(statePath, serializeFrontmatter(dataOrUpdates, body));
    return;
  }

  // 2-arg partial form (with optional opts as 3rd arg).
  const opts = (contentOrOpts && typeof contentOrOpts === 'object') ? contentOrOpts : {};
  const skipCaveman = !!opts.skipCavemanFormat;

  const updates = dataOrUpdates || {};
  let current = { data: {}, content: '' };
  try {
    current = parseFrontmatter(fs.readFileSync(statePath, 'utf8'));
  } catch (e) { /* file may not exist yet */ }

  const mergedData = Object.assign({}, current.data);
  let mergedContent = current.content;
  for (const [key, val] of Object.entries(updates)) {
    if (key === '__content') {
      mergedContent = skipCaveman ? val : formatCavemanValue(val);
    } else if (key === '__contentAppend') {
      const piece = skipCaveman ? val : formatCavemanValue(val);
      mergedContent = (mergedContent || '') + piece;
    } else {
      // Frontmatter values are short / structured -- never caveman them.
      mergedData[key] = val;
    }
  }

  _atomicWriteFile(statePath, serializeFrontmatter(mergedData, mergedContent));
}

// === Lock File Primitives (T007, R007) ===
// Caveman-form lock file (R013): short fragment values, one per line.

const LOCK_FILE_NAME = '.forge-loop.lock';
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

function _lockPath(forgeDir) {
  return path.join(forgeDir, LOCK_FILE_NAME);
}

function _serializeLock(lock) {
  return [
    `pid: ${lock.pid}`,
    `started: ${lock.started}`,
    `task: ${lock.task}`,
    `heartbeat: ${lock.heartbeat}`,
    ''
  ].join('\n');
}

function _parseLock(text) {
  const lock = {};
  for (const line of text.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (!key) continue;
    if (key === 'pid') lock.pid = parseInt(val, 10);
    else lock[key] = val;
  }
  return lock;
}

function readLock(forgeDir) {
  try {
    return _parseLock(fs.readFileSync(_lockPath(forgeDir), 'utf8'));
  } catch (e) {
    return null;
  }
}

function detectStaleLock(forgeDir) {
  const lock = readLock(forgeDir);
  if (!lock) return null;
  const hbMs = Date.parse(lock.heartbeat || '');
  const isStale = !hbMs || (Date.now() - hbMs) > LOCK_STALE_MS;
  return Object.assign({}, lock, { is_stale: isStale });
}

function acquireLock(forgeDir, taskId) {
  const lockFile = _lockPath(forgeDir);
  const now = new Date().toISOString();
  const newLock = {
    pid: process.pid,
    started: now,
    task: taskId || '',
    heartbeat: now
  };

  // Exclusive create -- closest to atomic create on POSIX and Windows.
  try {
    fs.writeFileSync(lockFile, _serializeLock(newLock), { flag: 'wx' });
    return { acquired: true, lockFile, lock: newLock };
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { acquired: false, reason: `error_${err.code || 'unknown'}`, staleLock: false };
    }
  }

  const existing = detectStaleLock(forgeDir);
  if (!existing) {
    // Race: file vanished between EEXIST and read. Retry once.
    try {
      fs.writeFileSync(lockFile, _serializeLock(newLock), { flag: 'wx' });
      return { acquired: true, lockFile, lock: newLock };
    } catch (e) {
      return { acquired: false, reason: 'race_retry_failed', staleLock: false };
    }
  }

  if (existing.is_stale) {
    try {
      _atomicWriteFile(lockFile, _serializeLock(newLock));
      return { acquired: true, lockFile, lock: newLock, tookOverStale: true };
    } catch (e) {
      return { acquired: false, reason: `takeover_failed_${e.code || 'unknown'}`, staleLock: true };
    }
  }

  return {
    acquired: false,
    reason: `held_by_pid_${existing.pid}`,
    staleLock: false,
    holder: existing
  };
}

function heartbeat(forgeDir) {
  const existing = readLock(forgeDir);
  if (!existing) return { ok: false, reason: 'no_lock' };
  if (existing.pid !== process.pid) {
    return { ok: false, reason: `not_owner_pid_${existing.pid}` };
  }
  existing.heartbeat = new Date().toISOString();
  try {
    _atomicWriteFile(_lockPath(forgeDir), _serializeLock(existing));
    return { ok: true, heartbeat: existing.heartbeat };
  } catch (e) {
    return { ok: false, reason: `write_failed_${e.code || 'unknown'}` };
  }
}

function releaseLock(forgeDir) {
  const existing = readLock(forgeDir);
  if (!existing) return { released: false, reason: 'no_lock' };
  if (existing.pid !== process.pid) {
    return { released: false, reason: `not_owner_pid_${existing.pid}` };
  }
  try {
    fs.unlinkSync(_lockPath(forgeDir));
    return { released: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { released: true };
    return { released: false, reason: `unlink_failed_${e.code || 'unknown'}` };
  }
}

// === Token Ledger ===
// Fix #7: Atomic updates — last_transcript_tokens is written in the same
// fs.writeFileSync call as the ledger totals, preventing double-counting
// if the process crashes between two separate writes.

function updateTokenLedger(forgeDir, iterationTokens, lastTranscriptTokens) {
  const ledgerPath = path.join(forgeDir, 'token-ledger.json');
  let ledger = { total: 0, iterations: 0, per_spec: {}, last_transcript_tokens: 0 };
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (e) { /* new ledger */ }
  ledger.total += iterationTokens;
  ledger.iterations += 1;
  ledger.avg_per_iteration = Math.round(ledger.total / ledger.iterations);
  // Atomic: write last_transcript_tokens in the same call
  if (lastTranscriptTokens !== undefined) {
    ledger.last_transcript_tokens = lastTranscriptTokens;
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return ledger;
}

// === Per-Task Token Budget Ledger (R001) ===
//
// Extends token-ledger.json with a `tasks` map keyed by task_id so the loop
// can enforce per-task ceilings (quick=5k, standard=15k, thorough=40k by
// default). Each entry tracks: tokens used, depth, budget snapshot at the
// time the task was registered, started_at and last_update timestamps.
//
// Backward compatibility: any function below that touches the ledger calls
// readLedger() which migrates legacy flat ledgers (those without `tasks`)
// in-memory on first read. The migrated shape is only persisted the next
// time something writes (no forced migration write).
//
// Atomicity: writeLedgerAtomic() writes to a sibling temp file then renames
// it onto the target. fs.renameSync is atomic on the same filesystem on
// POSIX and Windows (when the destination exists). True multi-process write
// safety needs a lock file; that is T007's job.

function readLedger(forgeDir) {
  const ledgerPath = path.join(forgeDir, 'token-ledger.json');
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (e) {
    ledger = {};
  }
  // Migrate legacy flat ledger (no `tasks` key) without losing fields.
  if (!ledger || typeof ledger !== 'object') ledger = {};
  if (typeof ledger.total !== 'number') ledger.total = 0;
  if (typeof ledger.iterations !== 'number') ledger.iterations = 0;
  if (!ledger.per_spec || typeof ledger.per_spec !== 'object') ledger.per_spec = {};
  if (typeof ledger.last_transcript_tokens !== 'number') ledger.last_transcript_tokens = 0;
  if (!ledger.tasks || typeof ledger.tasks !== 'object') ledger.tasks = {};
  return ledger;
}

function writeLedgerAtomic(forgeDir, ledger) {
  const ledgerPath = path.join(forgeDir, 'token-ledger.json');
  const tmpPath = ledgerPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  try {
    fs.renameSync(tmpPath, ledgerPath);
  } catch (e) {
    // On Windows rename can fail if target is held; fall back to unlink+rename.
    try { fs.unlinkSync(ledgerPath); } catch (_) {}
    fs.renameSync(tmpPath, ledgerPath);
  }
}

// Resolve the project's per-task budget for a given depth, honoring user
// config overrides. Falls back to DEFAULT_CONFIG if no config file exists.
function resolveTaskBudget(forgeDir, depth) {
  const projectDir = path.dirname(path.resolve(forgeDir));
  let cfg;
  try {
    cfg = loadConfig(projectDir);
  } catch (e) {
    cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  const fallback = DEFAULT_CONFIG.per_task_budget[depth] || DEFAULT_CONFIG.per_task_budget.standard;
  return getConfig(cfg, 'per_task_budget.' + depth, fallback);
}

// registerTask: create (or refresh) a task entry in the ledger with its
// budget pulled from config. Idempotent on re-registration: preserves prior
// token count and started_at, but updates depth/budget if they changed.
function registerTask(taskId, depth, forgeDir) {
  if (!taskId) throw new Error('registerTask: taskId required');
  const useDepth = depth || 'standard';
  const ledger = readLedger(forgeDir);
  const now = new Date().toISOString();
  const budget = resolveTaskBudget(forgeDir, useDepth);
  const existing = ledger.tasks[taskId];
  ledger.tasks[taskId] = {
    tokens: existing && typeof existing.tokens === 'number' ? existing.tokens : 0,
    depth: useDepth,
    budget: budget,
    started_at: existing && existing.started_at ? existing.started_at : now,
    last_update: now
  };
  writeLedgerAtomic(forgeDir, ledger);
  return ledger.tasks[taskId];
}

// recordTaskTokens: increment a task's token counter. Auto-registers the
// task with default depth if it has not been registered yet, so callers
// (e.g. PostToolUse hooks) never silently drop tokens.
function recordTaskTokens(taskId, tokens, forgeDir) {
  if (!taskId) return null;
  const delta = Number(tokens) || 0;
  const ledger = readLedger(forgeDir);
  if (!ledger.tasks[taskId]) {
    const now = new Date().toISOString();
    const budget = resolveTaskBudget(forgeDir, 'standard');
    ledger.tasks[taskId] = {
      tokens: 0,
      depth: 'standard',
      budget: budget,
      started_at: now,
      last_update: now
    };
  }
  ledger.tasks[taskId].tokens += delta;
  ledger.tasks[taskId].last_update = new Date().toISOString();
  writeLedgerAtomic(forgeDir, ledger);
  return ledger.tasks[taskId];
}

// checkTaskBudget: report on a task's budget consumption. Returns a stable
// shape even for unknown tasks so callers do not need to null-check.
function checkTaskBudget(taskId, forgeDir) {
  const ledger = readLedger(forgeDir);
  const entry = ledger.tasks[taskId];
  if (!entry) {
    const budget = resolveTaskBudget(forgeDir, 'standard');
    return { task_id: taskId, used: 0, budget: budget, remaining: budget, percentage: 0, registered: false };
  }
  const used = entry.tokens || 0;
  const budget = entry.budget || resolveTaskBudget(forgeDir, entry.depth || 'standard');
  const remaining = Math.max(0, budget - used);
  const percentage = budget > 0 ? Math.round((used / budget) * 1000) / 10 : 0;
  return {
    task_id: taskId,
    used: used,
    budget: budget,
    remaining: remaining,
    percentage: percentage,
    depth: entry.depth || 'standard',
    registered: true
  };
}

// getTaskBudgetRemaining: thin wrapper for callers that only need the
// remaining number (e.g. circuit breakers).
function getTaskBudgetRemaining(taskId, forgeDir) {
  return checkTaskBudget(taskId, forgeDir).remaining;
}

// budgetStatusReport: build the data structure backing the
// `budget-status` CLI subcommand. If taskId is provided, the report is
// scoped to that single task; otherwise it covers every task in the ledger.
// Always includes a `session` block summarising session_budget_tokens vs
// ledger total, plus iteration count vs max_iterations from state.md.
function budgetStatusReport(forgeDir, taskId) {
  const ledger = readLedger(forgeDir);
  const session = _buildSessionSummary(forgeDir, ledger);
  if (taskId) {
    return { tasks: [checkTaskBudget(taskId, forgeDir)], session: session };
  }
  const ids = Object.keys(ledger.tasks).sort();
  const tasks = ids.map(id => checkTaskBudget(id, forgeDir));
  const totals = tasks.reduce((acc, t) => {
    acc.used += t.used;
    acc.budget += t.budget;
    return acc;
  }, { used: 0, budget: 0 });
  totals.remaining = Math.max(0, totals.budget - totals.used);
  totals.percentage = totals.budget > 0
    ? Math.round((totals.used / totals.budget) * 1000) / 10
    : 0;
  return { tasks: tasks, totals: totals, session: session };
}

// _buildSessionSummary: gather session-wide budget + iteration data from
// config.json and state.md. Pure read, never mutates anything. Returns a
// stable shape so the CLI formatter can rely on it.
function _buildSessionSummary(forgeDir, ledger) {
  let config;
  try {
    config = loadConfig(path.dirname(path.resolve(forgeDir)));
  } catch (e) {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  const sessionBudget = _resolveSessionBudget(config, forgeDir) || 0;
  const sessionUsed = (ledger && typeof ledger.total === 'number') ? ledger.total : 0;
  const sessionRemaining = Math.max(0, sessionBudget - sessionUsed);
  const sessionPct = sessionBudget > 0
    ? Math.round((sessionUsed / sessionBudget) * 1000) / 10
    : 0;
  const maxIter = getConfig(config, 'max_iterations', 100);
  let iteration = 0;
  try {
    const state = readState(forgeDir);
    if (state && state.data && typeof state.data.iteration === 'number') {
      iteration = state.data.iteration;
    }
  } catch (e) { /* state optional */ }
  return {
    session_budget_tokens: sessionBudget,
    session_used: sessionUsed,
    session_remaining: sessionRemaining,
    session_percentage: sessionPct,
    iteration: iteration,
    max_iterations: maxIter
  };
}

// === Task Status Registry ===
// Fix #4: Programmatic task tracking via task-status.json instead of parsing
// Claude's markdown in state.md. The old approach used regex on "What's Done"
// which broke on formatting variations (bold, em-dash, indentation).
// task-status.json is the authoritative source; state.md is supplementary.

function readTaskRegistry(forgeDir) {
  const registryPath = path.join(forgeDir, 'task-status.json');
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    return { tasks: {}, last_updated: null };
  }
}

function writeTaskRegistry(forgeDir, registry) {
  const registryPath = path.join(forgeDir, 'task-status.json');
  registry.last_updated = new Date().toISOString();
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function markTaskComplete(forgeDir, taskId, commitHash) {
  const registry = readTaskRegistry(forgeDir);
  registry.tasks[taskId] = {
    status: 'complete',
    completed_at: new Date().toISOString(),
    commit: commitHash || null
  };
  writeTaskRegistry(forgeDir, registry);
}

function initTaskRegistry(forgeDir, tasks) {
  const registry = { tasks: {}, last_updated: new Date().toISOString() };
  for (const task of tasks) {
    registry.tasks[task.id] = { status: 'pending', completed_at: null, commit: null };
  }
  writeTaskRegistry(forgeDir, registry);
}

// === Progress Detection ===
// Fix #2: Wire the no-progress circuit breaker. The config had
// circuit_breaker_no_progress: 2 but routeDecision never checked it.
// Now we snapshot git diff hash, task status, and completed count each
// iteration, and trip the breaker when nothing changes across N iterations.

function getProgressSnapshot(forgeDir) {
  const snapshot = {
    git_hash: 'unknown',
    task_status: null,
    current_task: null,
    completed_count: 0,
    timestamp: new Date().toISOString()
  };

  // Git diff hash — detect if any working tree files changed
  try {
    const diffOutput = gitDiffStat();
    const { createHash } = require('crypto');
    snapshot.git_hash = createHash('md5').update(diffOutput).digest('hex');
  } catch (e) {
    // Leave as 'unknown' — progress check still works on other signals
  }

  // Current state fields
  const state = readState(forgeDir);
  snapshot.task_status = state.data.task_status || null;
  snapshot.current_task = state.data.current_task || null;

  // Completed task count from registry
  const registry = readTaskRegistry(forgeDir);
  snapshot.completed_count = Object.values(registry.tasks)
    .filter(t => t.status === 'complete').length;

  return snapshot;
}

function checkProgress(forgeDir, currentSnapshot) {
  const progressPath = path.join(forgeDir, '.progress-history.json');
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch (e) { /* no history yet */ }

  history.push(currentSnapshot);

  // Keep only last 5 snapshots to bound file size
  if (history.length > 5) history = history.slice(-5);
  fs.writeFileSync(progressPath, JSON.stringify(history, null, 2));

  // Need at least 2 snapshots to compare
  if (history.length < 2) return true;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  // Progress = any of these signals changed
  const gitChanged = prev.git_hash !== curr.git_hash;
  const statusChanged = prev.task_status !== curr.task_status;
  const taskChanged = prev.current_task !== curr.current_task;
  const completedChanged = prev.completed_count !== curr.completed_count;

  return gitChanged || statusChanged || taskChanged || completedChanged;
}

function getNoProgressCount(forgeDir) {
  const progressPath = path.join(forgeDir, '.progress-history.json');
  try {
    const history = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    if (history.length < 2) return 0;

    // Count consecutive identical snapshots from the tail
    let count = 0;
    for (let i = history.length - 1; i >= 1; i--) {
      const prev = history[i - 1];
      const curr = history[i];
      const same = prev.git_hash === curr.git_hash
        && prev.task_status === curr.task_status
        && prev.current_task === curr.current_task
        && prev.completed_count === curr.completed_count;
      if (same) count++;
      else break;
    }
    return count;
  } catch (e) {
    return 0;
  }
}

// === Frontier Parsing ===

function parseFrontier(text) {
  const { data, content } = parseFrontmatter(text);
  const tasks = [];
  let currentTier = 0;

  for (const line of content.split('\n')) {
    const tierMatch = line.match(/^## Tier (\d+)/);
    if (tierMatch) {
      currentTier = parseInt(tierMatch[1], 10);
      continue;
    }

    // Match task IDs: T001, T003.1, T003.2 (decimal IDs for re-decomposed sub-tasks)
    const taskMatch = line.match(/^- \[([A-Z]\d+(?:\.\d+)?)\]\s+(.+)/);
    if (taskMatch) {
      const id = taskMatch[1];
      const rest = taskMatch[2];

      const repoMatch = rest.match(/repo:\s*(\S+)/);
      const dependsMatch = rest.match(/depends:\s*([A-Z0-9.,\s]+?)(?:\s*\||$)/);
      const estMatch = rest.match(/est:\s*~?(\d+)k/);
      const providesMatch = rest.match(/provides:\s*([a-z0-9_,\s-]+?)(?:\s*\||$)/);
      const consumesMatch = rest.match(/consumes:\s*([a-z0-9_,\s-]+?)(?:\s*\||$)/);
      // T015 (R005): files: path/a.ts, path/b.ts -- declared overlap surface for conflict detection.
      // Accepts both `files:` and `filesTouched:` for forwards compatibility.
      const filesMatch = rest.match(/files(?:Touched)?:\s*([^|]+?)(?:\s*\||$)/);
      const name = rest.split('|')[0].trim();

      tasks.push({
        id,
        name,
        tier: currentTier,
        repo: repoMatch ? repoMatch[1] : null,
        depends: dependsMatch ? dependsMatch[1].split(',').map(s => s.trim()) : [],
        estimated_tokens: estMatch ? parseInt(estMatch[1], 10) * 1000 : 0,
        provides: providesMatch ? providesMatch[1].split(',').map(s => s.trim()) : [],
        consumes: consumesMatch ? consumesMatch[1].split(',').map(s => s.trim()) : [],
        filesTouched: filesMatch
          ? filesMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          : [],
        status: 'pending'
      });
    }
  }
  return tasks;
}

// === T015 (R005): Worktree Conflict Detection + Serialization ===
// Parallel tasks in a tier can collide on squash merge if they touch the same
// files. These helpers detect overlap, group conflicting tasks for sequential
// execution, and log the events to state.md in caveman form.

function detectFileConflicts(tasks) {
  // Union-Find over tasks: any two tasks sharing at least one file get merged
  // into a conflict group. Tasks with empty filesTouched cannot conflict
  // (default behavior is fully parallel, backward compatible).
  const list = Array.isArray(tasks) ? tasks : [];
  const parent = {};
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const t of list) parent[t.id] = t.id;

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const aFiles = a.filesTouched || [];
    if (aFiles.length === 0) continue;
    const aSet = new Set(aFiles);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const bFiles = b.filesTouched || [];
      if (bFiles.length === 0) continue;
      let overlap = false;
      for (const f of bFiles) {
        if (aSet.has(f)) { overlap = true; break; }
      }
      if (overlap) union(a.id, b.id);
    }
  }

  // Build groups keyed by root. Only return groups with size > 1.
  const groups = {};
  for (const t of list) {
    if ((t.filesTouched || []).length === 0) continue;
    const root = find(t.id);
    if (!groups[root]) groups[root] = [];
    groups[root].push(t);
  }

  const conflicts = [];
  for (const root of Object.keys(groups)) {
    const grp = groups[root];
    if (grp.length < 2) continue;
    const counts = {};
    for (const t of grp) {
      for (const f of t.filesTouched || []) {
        counts[f] = (counts[f] || 0) + 1;
      }
    }
    const overlapFiles = Object.keys(counts).filter(f => counts[f] > 1).sort();
    conflicts.push({
      taskIds: grp.map(t => t.id).sort(),
      tasks: grp,
      overlapFiles
    });
  }
  return conflicts;
}

function serializeConflictingTasks(tierTasks) {
  // Returns array of arrays. Each inner array is a sequential chain that must
  // run one task at a time. Non-conflicting tasks each get their own chain so
  // the scheduler can run them truly parallel. Conflicting tasks share a chain.
  const list = Array.isArray(tierTasks) ? tierTasks : [];
  const conflicts = detectFileConflicts(list);

  const groupOf = {};
  conflicts.forEach((c, idx) => {
    for (const tid of c.taskIds) groupOf[tid] = idx;
  });

  const chains = conflicts.map(c => c.tasks.slice());
  for (const t of list) {
    if (groupOf[t.id] === undefined) {
      chains.push([t]);
    }
  }
  return chains;
}

function logConflictEvent(forgeDir, conflicts) {
  // Append a caveman-form note to state.md for each conflict group.
  // Format: [conflict] T012,T014 -> overlap: src/db.ts. serialized.
  if (!conflicts || conflicts.length === 0) return [];
  const lines = [];
  for (const c of conflicts) {
    const ids = c.taskIds.join(',');
    const files = (c.overlapFiles || []).join(',') || 'unknown';
    lines.push(`[conflict] ${ids} -> overlap: ${files}. serialized.`);
  }
  const block = '\n' + lines.join('\n') + '\n';
  try {
    writeState(forgeDir, { __contentAppend: block });
  } catch (e) {
    // Best effort. Conflict logging must never break the scheduler.
  }
  return lines;
}

// Scheduler integration helper. Given a tier of tasks, returns the chain
// layout and logs any conflicts. Streaming scheduler should call this before
// dispatching parallel work in a tier.
//
// Merge conflict fallback (T021 will implement the actual squash):
// If a squash merge fails for a task's worktree:
//   1. Worktree is preserved (do not auto-remove).
//   2. State transitions to phase `conflict_resolution`.
//   3. Scheduler falls back to sequential execution for remaining tasks
//      in the same tier (treat the whole tier as one chain).
//   4. Human or rescue agent resolves the conflict, then scheduler resumes.
function planTierExecution(forgeDir, tierTasks) {
  const conflicts = detectFileConflicts(tierTasks);
  if (conflicts.length > 0 && forgeDir) {
    logConflictEvent(forgeDir, conflicts);
  }
  return {
    chains: serializeConflictingTasks(tierTasks),
    conflicts
  };
}

// === Artifact Contracts ===
// Typed artifact output from task executors. Each completed task writes
// an artifact JSON file that downstream tasks can consume for context.

function writeArtifact(forgeDir, taskId, artifact) {
  const artifactsDir = path.join(forgeDir, 'artifacts');
  try { fs.mkdirSync(artifactsDir, { recursive: true }); } catch (e) {}
  const data = {
    task_id: taskId,
    status: artifact.status || 'complete',
    commit: artifact.commit || null,
    artifacts: artifact.artifacts || {},
    files_created: artifact.files_created || [],
    files_modified: artifact.files_modified || [],
    key_decisions: artifact.key_decisions || [],
    completed_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(artifactsDir, `${taskId}.json`), JSON.stringify(data, null, 2));
  return data;
}

function readArtifact(forgeDir, taskId) {
  try {
    const filePath = path.join(forgeDir, 'artifacts', `${taskId}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function buildArtifactSummary(forgeDir, taskIds) {
  const lines = [];
  for (const taskId of taskIds) {
    const artifact = readArtifact(forgeDir, taskId);
    if (!artifact) continue;
    const artNames = Object.keys(artifact.artifacts);
    const artDetails = artNames.map(name => {
      const desc = artifact.artifacts[name];
      return `${name} (${desc})`;
    }).join(', ');
    const files = [...artifact.files_created, ...artifact.files_modified];
    const fileStr = files.length > 0 ? ` | files: ${files.slice(0, 5).join(', ')}` : '';
    lines.push(`- ${taskId}: ${artDetails || 'no named artifacts'}${fileStr}`);
    if (artifact.key_decisions.length > 0) {
      for (const decision of artifact.key_decisions.slice(0, 2)) {
        lines.push(`  decision: ${decision}`);
      }
    }
  }
  return lines.length > 0 ? 'Dependency artifacts:\n' + lines.join('\n') : '';
}

// === Checkpoint Store (R008, R013) ===
// Resumable per-task progress files at .forge/progress/{task-id}.json.
// See references/checkpoint-schema.md for the full schema. Values follow
// caveman form (R013): short enums, fragment notes, no verbose prose.

const CHECKPOINT_STEPS = new Set([
  'spec_loaded',
  'research_done',
  'planning_done',
  'implementation_started',
  'tests_written',
  'tests_passing',
  'review_pending',
  'review_passed',
  'verification_pending',
  'complete'
]);

const CHECKPOINT_REQUIRED = ['task_id', 'current_step', 'next_step', 'started_at', 'last_updated'];

function checkpointPath(forgeDir, taskId) {
  return path.join(forgeDir, 'progress', `${taskId}.json`);
}

function validateCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') throw new Error('checkpoint: not an object');
  for (const key of CHECKPOINT_REQUIRED) {
    if (cp[key] === undefined || cp[key] === null || cp[key] === '') {
      throw new Error(`checkpoint: missing required field '${key}'`);
    }
  }
  if (!CHECKPOINT_STEPS.has(cp.current_step)) {
    throw new Error(`checkpoint: invalid current_step '${cp.current_step}'`);
  }
  if (!CHECKPOINT_STEPS.has(cp.next_step)) {
    throw new Error(`checkpoint: invalid next_step '${cp.next_step}'`);
  }
}

function normalizeCheckpoint(cp) {
  // Fill defaults for partial checkpoints. Schema says no nulls except worktree_path.
  return {
    task_id: cp.task_id,
    task_name: cp.task_name || '',
    spec_domain: cp.spec_domain || '',
    started_at: cp.started_at,
    last_updated: cp.last_updated,
    current_step: cp.current_step,
    next_step: cp.next_step,
    artifacts_produced: Array.isArray(cp.artifacts_produced) ? cp.artifacts_produced : [],
    context_bundle: (cp.context_bundle && typeof cp.context_bundle === 'object') ? cp.context_bundle : {},
    worktree_path: cp.worktree_path === undefined ? null : cp.worktree_path,
    depth: cp.depth || 'standard',
    token_usage: typeof cp.token_usage === 'number' ? cp.token_usage : 0,
    error_log: Array.isArray(cp.error_log) ? cp.error_log : []
  };
}

function writeCheckpoint(forgeDir, taskId, checkpoint, opts) {
  const progressDir = path.join(forgeDir, 'progress');
  try { fs.mkdirSync(progressDir, { recursive: true }); } catch (e) {}

  const now = new Date().toISOString();
  const cp = Object.assign({}, checkpoint, { task_id: taskId });
  if (!cp.started_at) cp.started_at = now;
  cp.last_updated = now;

  validateCheckpoint(cp);
  let normalized = normalizeCheckpoint(cp);
  // Caveman-format free-text fields by default (T029, R013).
  if (!(opts && opts.skipCavemanFormat)) {
    normalized = _cavemanCheckpointFields(normalized);
  }

  const target = checkpointPath(forgeDir, taskId);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, target);
  return { written: true, path: target };
}

function readCheckpoint(forgeDir, taskId) {
  const target = checkpointPath(forgeDir, taskId);
  if (!fs.existsSync(target)) return null;
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    console.warn(`checkpoint: read failed for ${taskId}: ${e.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`checkpoint: corrupt JSON for ${taskId}: ${e.message}`);
    return null;
  }
  try {
    validateCheckpoint(parsed);
  } catch (e) {
    console.warn(`checkpoint: schema invalid for ${taskId}: ${e.message}`);
    return null;
  }
  return normalizeCheckpoint(parsed);
}

function deleteCheckpoint(forgeDir, taskId) {
  const target = checkpointPath(forgeDir, taskId);
  try {
    fs.unlinkSync(target);
    return { deleted: true, path: target };
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: false, path: target };
    throw e;
  }
}

function listCheckpoints(forgeDir) {
  const progressDir = path.join(forgeDir, 'progress');
  if (!fs.existsSync(progressDir)) return [];
  const entries = fs.readdirSync(progressDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json') && !f.endsWith('.tmp'));
  const out = [];
  for (const file of entries) {
    const taskId = file.replace(/\.json$/, '');
    const cp = readCheckpoint(forgeDir, taskId);
    if (cp) out.push(cp);
  }
  out.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''));
  return out;
}

function updateCheckpoint(forgeDir, taskId, updates, opts) {
  const current = readCheckpoint(forgeDir, taskId);
  if (!current) {
    throw new Error(`checkpoint: cannot update missing checkpoint for ${taskId}`);
  }
  // Shallow merge, but context_bundle merges one level deep so partial keys do not clobber
  const merged = Object.assign({}, current, updates);
  if (updates && updates.context_bundle && typeof updates.context_bundle === 'object') {
    merged.context_bundle = Object.assign({}, current.context_bundle, updates.context_bundle);
  }
  if (updates && Array.isArray(updates.error_log)) {
    // Append rather than replace
    merged.error_log = current.error_log.concat(updates.error_log);
  }
  if (updates && Array.isArray(updates.artifacts_produced)) {
    // Union, keep order: existing first, then new ones not already present
    const seen = new Set(current.artifacts_produced);
    const additions = updates.artifacts_produced.filter(p => !seen.has(p));
    merged.artifacts_produced = current.artifacts_produced.concat(additions);
  }
  return writeCheckpoint(forgeDir, taskId, merged, opts);
}

// Build a context bundle file for a task, assembling only relevant context
function buildContextBundle(forgeDir, task, specContent, frontierTasks) {
  const bundleDir = path.join(forgeDir, 'context-bundles');
  try { fs.mkdirSync(bundleDir, { recursive: true }); } catch (e) {}

  const sections = [];
  sections.push(`# Context for ${task.id}: ${task.name}\n`);

  // Extract relevant spec requirements (match R-numbers from task name/description)
  if (specContent) {
    const reqBlocks = [];
    const reqMatches = specContent.match(/### R\d+:[\s\S]*?(?=### R\d+:|## Future|$)/g);
    if (reqMatches) {
      // Include requirements referenced in task consumes or all if none specified
      for (const block of reqMatches) {
        reqBlocks.push(block.trim());
      }
    }
    if (reqBlocks.length > 0) {
      sections.push('## Relevant Requirements\n' + reqBlocks.join('\n\n'));
    }
  }

  // Artifact summaries from dependencies
  if (task.depends.length > 0) {
    const summary = buildArtifactSummary(forgeDir, task.depends);
    if (summary) sections.push('## ' + summary);
  }

  // Remaining frontier overview (compact)
  if (frontierTasks) {
    const remaining = frontierTasks.filter(t => t.id !== task.id && t.status !== 'complete');
    if (remaining.length > 0) {
      const overview = remaining.slice(0, 10).map(t =>
        `- ${t.id}: ${t.name}${t.depends.length ? ` (depends: ${t.depends.join(', ')})` : ''}`
      ).join('\n');
      sections.push(`## Remaining Tasks (${remaining.length} total)\n${overview}`);
    }
  }

  const bundlePath = path.join(bundleDir, `${task.id}.md`);
  fs.writeFileSync(bundlePath, sections.join('\n\n'));
  return bundlePath;
}

function cleanupContextBundle(forgeDir, taskId) {
  try {
    fs.unlinkSync(path.join(forgeDir, 'context-bundles', `${taskId}.md`));
  } catch (e) { /* already cleaned or never created */ }
}

// === Capability Discovery ===

function discoverCapabilities(projectDir, claudeJsonPath) {
  const caps = { mcp_servers: {}, skills: {}, plugins: {}, discovered_at: new Date().toISOString() };

  // Read MCP config
  const mcpPaths = [
    claudeJsonPath || path.join(projectDir, '.claude.json'),
    path.join(projectDir, '.mcp.json'),
  ];
  // Also check home directory
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) mcpPaths.push(path.join(home, '.claude.json'));

  for (const mcpPath of mcpPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (data.mcpServers) {
        for (const [name, config] of Object.entries(data.mcpServers)) {
          caps.mcp_servers[name] = { command: config.command, use_for: inferMcpUse(name) };
        }
      }
    } catch (e) { /* file not found or invalid */ }
  }

  // Read installed plugins (best-effort, internal path)
  try {
    const pluginsPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const plugins = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
    if (Array.isArray(plugins)) {
      for (const p of plugins) {
        if (p.name) caps.plugins[p.name] = { scope: p.scope || 'user' };
      }
    }
  } catch (e) { /* best-effort */ }

  // Discover CLI tools available on the system
  const cliToolChecks = [
    { name: 'gh', check: 'gh --version', use_for: 'GitHub PR/issue management, CI/CD, and API access' },
    { name: 'vercel', check: 'vercel --version', use_for: 'deployment, preview URLs, and serverless functions' },
    { name: 'stripe', check: 'stripe --version', use_for: 'payment testing, webhook simulation, and billing' },
    { name: 'ffmpeg', check: 'ffmpeg -version', use_for: 'video/audio processing, transcoding, and rendering' },
    { name: 'playwright', check: 'npx playwright --version', use_for: 'browser automation and E2E testing' },
    { name: 'gws', check: 'gws --version', use_for: 'Google Workspace — Drive, Gmail, Calendar, Sheets, Docs' },
    { name: 'notebooklm', check: 'python -m notebooklm --version', use_for: 'research with grounded citations from knowledge bases' },
    { name: 'supabase', check: 'supabase --version', use_for: 'database, auth, edge functions, and realtime' },
    { name: 'firebase', check: 'firebase --version', use_for: 'app hosting, auth, Firestore, and cloud functions' },
    { name: 'docker', check: 'docker --version', use_for: 'container management and isolated environments' },
    { name: 'wrangler', check: 'wrangler --version', use_for: 'Cloudflare Workers deployment and KV management' },
  ];

  caps.cli_tools = {};
  for (const tool of cliToolChecks) {
    try {
      const output = execSync(tool.check, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      const version = output.split('\n')[0].replace(/^[^0-9]*/, '').trim();
      caps.cli_tools[tool.name] = { available: true, use_for: tool.use_for, version: version || 'unknown' };
    } catch (e) { /* tool not installed — skip */ }
  }

  // Discover CLI-Anything generated CLIs (cli-anything-*)
  caps.generated_clis = {};
  try {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const seen = new Set();
    for (const dir of pathDirs) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const name = f.replace(/\.exe$/i, '');
          if (name.startsWith('cli-anything-') && !seen.has(name)) {
            seen.add(name);
            const app = name.replace('cli-anything-', '');
            caps.generated_clis[app] = { command: name, use_for: `CLI-Anything generated CLI for ${app}` };
          }
        }
      } catch (e) { /* dir not readable */ }
    }
  } catch (e) { /* best-effort */ }

  // Check if CLI-Anything plugin is available for on-demand CLI generation
  const cliAnythingPaths = [
    path.join(home, '.claude', 'plugins', 'cli-anything'),
    path.join(home, '.claude', 'plugins', 'cli-anything-plugin'),
    path.join(home, '.claude', 'plugins', 'cache', 'cli-anything'),
  ];
  caps.cli_anything_available = cliAnythingPaths.some(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  // Detect Codex CLI and plugin availability
  caps.codex = { available: false, reason: 'not checked' };
  try {
    // Check Codex CLI
    let codexVersion = null;
    try {
      codexVersion = execFileSync('codex', ['--version'], {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (e) {
      caps.codex = { available: false, reason: 'Codex CLI not installed' };
      return caps;
    }

    // Check codex-companion.mjs in plugin cache
    let pluginRoot = null;
    const pluginSearchPaths = [
      path.join(home, '.claude', 'plugins', 'cache', 'openai-codex'),
      path.join(home, '.claude', 'plugins', 'marketplaces', 'openai-codex'),
    ];
    for (const searchPath of pluginSearchPaths) {
      try {
        const walkDir = (dir, depth) => {
          if (depth > 3) return null;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'codex-companion.mjs') return dir;
            if (e.isDirectory()) {
              const found = walkDir(path.join(dir, e.name), depth + 1);
              if (found) return found;
            }
          }
          return null;
        };
        const found = walkDir(searchPath, 0);
        if (found) { pluginRoot = found; break; }
      } catch (e) { /* path not found */ }
    }

    if (!pluginRoot) {
      caps.codex = { available: false, version: codexVersion, reason: 'Codex plugin not installed' };
    } else {
      caps.codex = {
        available: true,
        version: codexVersion,
        pluginRoot,
        companionPath: path.join(pluginRoot, 'codex-companion.mjs'),
        reason: null
      };
    }
  } catch (e) {
    caps.codex = { available: false, reason: 'Detection failed: ' + e.message };
  }

  return caps;
}

function inferMcpUse(name) {
  const map = {
    context7: 'library documentation lookup',
    playwright: 'browser automation and E2E testing',
    mongodb: 'database queries and schema inspection',
    langsmith: 'LLM tracing and prompt management',
    firecrawl: 'web research and documentation scraping',
    grafana: 'observability and monitoring',
    stripe: 'payment testing, webhook simulation, and billing management',
    github: 'PR management, issue tracking, and CI/CD workflows',
    vercel: 'deployment, preview URLs, and serverless function management',
    notebooklm: 'research with grounded citations from knowledge bases',
    gws: 'Google Workspace — Drive, Gmail, Calendar, Sheets, Docs access',
    ffmpeg: 'video/audio processing, transcoding, and media pipelines',
    'cli-anything': 'agent-native CLI generation for desktop software',
    supabase: 'database management, auth, edge functions, and realtime',
    firebase: 'app hosting, auth, Firestore, and cloud functions',
    slack: 'team messaging, channel management, and notifications',
    linear: 'issue tracking, project management, and sprint workflows',
    figma: 'design inspection, asset export, and design-to-code',
    'semantic-scholar': 'academic paper search, citations, and research discovery',
    arxiv: 'academic pre-print search, download, and analysis',
    rfc: 'IETF RFC document retrieval and search',
  };
  const lower = name.toLowerCase();
  for (const [key, use] of Object.entries(map)) {
    if (lower.includes(key)) return use;
  }
  return 'custom integration';
}

// === Resume Prompt Generation ===

function generateResumePrompt(stateData, projectDir) {
  return `You are resuming a Forge execution session. Read these files to restore context:

1. Read .forge/state.md — your current position, what's done, what's next, key decisions
2. Read .forge/plans/ — the task frontier for the current spec
3. Read .forge/specs/ — the specification you're implementing
4. Read .forge/token-ledger.json — remaining token budget
5. Read .forge/capabilities.json — available MCP servers and skills
6. Read .forge/task-status.json — programmatic task completion registry

Current state:
- Phase: ${stateData.phase || 'unknown'}
- Spec: ${stateData.spec || 'unknown'}
- Current task: ${stateData.current_task || 'unknown'}
- Iteration: ${stateData.iteration || 0}

IMPORTANT: Do NOT re-read completed tasks. Do NOT re-plan.
Pick up exactly where you left off. Run any failing tests first
to re-establish context, then continue implementing.

After reading the state files, continue working. When you complete
a task, commit it and update .forge/state.md before moving to the next task.`;
}

// === Execution Summary Generation ===
// Fix #9: Wire up the summary.md template. Previously the template existed
// but was never called. Now generateSummary() runs at completion, between
// specs (gated mode), and on the 'summary' CLI command.

function generateSummary(forgeDir) {
  const state = readState(forgeDir);
  const registry = readTaskRegistry(forgeDir);
  const config = loadConfig(path.dirname(forgeDir));

  // Read ledger
  let ledger = { total: 0, iterations: 0 };
  try {
    ledger = JSON.parse(fs.readFileSync(path.join(forgeDir, 'token-ledger.json'), 'utf8'));
  } catch (e) {}

  // Gather task statuses
  const completedTasks = [];
  const blockedTasks = [];
  for (const [id, info] of Object.entries(registry.tasks)) {
    if (info.status === 'complete') {
      completedTasks.push(`- ${id}: complete${info.commit ? ` (${info.commit})` : ''}`);
    } else if (info.status !== 'pending') {
      blockedTasks.push(`- ${id}: ${info.status}`);
    }
  }

  const totalTasks = Object.keys(registry.tasks).length;
  const budget = state.data.tokens_budget || config.token_budget;
  const used = ledger.total;
  const percent = budget > 0 ? Math.round((used / budget) * 100) : 0;
  const avg = completedTasks.length > 0 ? Math.round(used / completedTasks.length) : 0;

  // Collect deviations
  const deviations = [];

  // Check for depth downgrades via progress history
  try {
    const progressHistory = JSON.parse(fs.readFileSync(
      path.join(forgeDir, '.progress-history.json'), 'utf8'));
    const hadDowngrade = progressHistory.some(h =>
      h.task_status === 'quick' && state.data.depth !== 'quick');
    if (hadDowngrade) {
      deviations.push('- Depth auto-downgraded to quick due to budget pressure');
    }
  } catch (e) {}

  if (blockedTasks.length > 0) {
    deviations.push(`- Blocked tasks:\n${blockedTasks.join('\n')}`);
  }

  if (deviations.length === 0) {
    deviations.push('- None — all tasks completed as planned');
  }

  // Gather recent git commits
  const commitLog = gitLogOneline(20).trim();

  const summary = `---
spec: ${state.data.spec || 'unknown'}
completed_at: ${new Date().toISOString().split('T')[0]}
total_tasks: ${totalTasks}
total_tokens: ${used}
duration_iterations: ${ledger.iterations || 0}
---

# ${state.data.spec || 'Unknown'} Execution Summary

## Tasks Completed
${completedTasks.length > 0 ? completedTasks.join('\n') : '- None'}

## Deviations from Plan
${deviations.join('\n')}

## Token Usage
- Budget: ${budget}
- Used: ${used} (${percent}%)
- Average per task: ${avg}

## Recent Commits
\`\`\`
${commitLog || 'No commits found'}
\`\`\`
`;

  const summaryPath = path.join(forgeDir, `summary-${state.data.spec || 'execution'}.md`);
  fs.writeFileSync(summaryPath, summary);
  return summaryPath;
}

// === State Verification ===
// Fix #6: Verify that Claude's self-reported state in state.md matches
// reality (git commits, task registry). Auto-fixes simple inconsistencies
// like a task marked complete in registry but not in state, or vice versa.

/**
 * Validates that the Forge workflow prerequisites are met before execution.
 * Enforces: brainstorm (approved specs) -> plan (valid frontiers) -> execute.
 * Returns an array of error strings. Empty array = all clear.
 */
function validateWorkflowPrerequisites(forgeDir) {
  const errors = [];
  const specsDir = path.join(forgeDir, 'specs');
  const plansDir = path.join(forgeDir, 'plans');

  // 1. Check specs directory exists and has spec files
  if (!fs.existsSync(specsDir)) {
    errors.push('No specs directory found. Run /forge brainstorm first.');
    return errors;
  }

  const specFiles = fs.readdirSync(specsDir).filter(f => f.startsWith('spec-') && f.endsWith('.md'));
  if (specFiles.length === 0) {
    errors.push('No spec files found in .forge/specs/. Run /forge brainstorm first.');
    return errors;
  }

  // 2. Check ALL spec files have status: approved
  const unapproved = [];
  for (const specFile of specFiles) {
    const content = fs.readFileSync(path.join(specsDir, specFile), 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed.data || parsed.data.status !== 'approved') {
      unapproved.push(specFile + ' (status: ' + (parsed.data && parsed.data.status || 'missing') + ')');
    }
  }
  if (unapproved.length > 0) {
    errors.push('Unapproved specs found: ' + unapproved.join(', ') + '. The brainstorm workflow must complete with user approval before planning/executing.');
  }

  // 3. Check plans directory exists and has frontier files
  if (!fs.existsSync(plansDir)) {
    errors.push('No plans directory found. Run /forge plan first to decompose specs into tasks.');
    return errors;
  }

  const frontierFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('-frontier.md'));
  if (frontierFiles.length === 0) {
    errors.push('No frontier files found in .forge/plans/. Run /forge plan first.');
  }

  // 4. Check each approved spec has a corresponding frontier
  for (const specFile of specFiles) {
    const domain = specFile.replace(/^spec-/, '').replace(/\.md$/, '');
    const hasFrontier = frontierFiles.some(f => f.includes(domain));
    if (!hasFrontier) {
      errors.push('Spec "' + domain + '" has no corresponding frontier file. Run /forge plan for this spec.');
    }
  }

  return errors;
}

function verifyStateConsistency(forgeDir, state) {
  const issues = [];
  const registry = readTaskRegistry(forgeDir);
  const currentTask = state.data.current_task;

  // If state says complete but registry doesn't — check git to reconcile
  if (state.data.task_status === 'complete' && currentTask) {
    const registryEntry = registry.tasks[currentTask];
    if (!registryEntry || registryEntry.status !== 'complete') {
      const log = gitLogOneline(10);
      const hasCommit = log.includes(currentTask);

      if (hasCommit) {
        markTaskComplete(forgeDir, currentTask, 'verified-from-git');
        issues.push(`Auto-fixed: ${currentTask} confirmed complete from git, updated registry`);
      } else {
        issues.push(`${currentTask} marked complete in state.md but no matching commit found`);
      }
    }
  }

  // If registry says complete but state disagrees — auto-advance state
  if (currentTask && registry.tasks[currentTask]
      && registry.tasks[currentTask].status === 'complete'
      && state.data.task_status && state.data.task_status !== 'complete') {
    issues.push(`Auto-fixed: ${currentTask} already complete in registry, advancing state`);
    state.data.task_status = 'complete';
    writeState(forgeDir, state.data, state.content);
  }

  return issues;
}

// === Parallel Task Detection ===
// Fix #5: The frontier defines tiers of parallelizable tasks, but
// findNextUnblockedTask returns only the first one. findAllUnblockedTasks
// returns all unblocked tasks so the routing can dispatch them in parallel
// when multiple same-tier tasks are ready.

function findAllUnblockedTasks(tasks, forgeDir) {
  const registry = readTaskRegistry(forgeDir);
  const doneTasks = new Set();
  const runningTasks = new Set();

  // Primary source: task registry
  for (const [id, info] of Object.entries(registry.tasks)) {
    if (info.status === 'complete') doneTasks.add(id);
    if (info.status === 'running') runningTasks.add(id);
  }

  // Fallback: state.md content (backwards compatibility)
  const state = readState(forgeDir);
  for (const line of (state.content || '').split('\n')) {
    const match = line.match(/^[\s*-]*\*{0,2}(T\d+(?:\.\d+)?)\*{0,2}[\s:—-]/);
    if (match) doneTasks.add(match[1]);
  }

  const unblocked = [];
  for (const task of tasks) {
    if (doneTasks.has(task.id) || runningTasks.has(task.id)) continue;
    const allDepsComplete = task.depends.every(d => doneTasks.has(d));
    if (allDepsComplete) unblocked.push(task);
  }
  return unblocked;
}

// === Streaming Dispatch: Get all ready tasks regardless of tier ===
// Unlike findAllUnblockedTasks (which was tier-aware), getReadyTasks
// returns ANY task whose individual dependencies are complete, enabling
// streaming topological dispatch where tasks start as soon as their
// specific deps finish, not when the whole tier finishes.

function getReadyTasks(tasks, forgeDir) {
  const config = loadConfig(path.dirname(forgeDir));
  const maxConcurrent = (config.parallelism || {}).max_concurrent_agents || 3;
  const maxPerRepo = (config.parallelism || {}).max_concurrent_per_repo || 2;

  const allUnblocked = findAllUnblockedTasks(tasks, forgeDir);

  // Apply concurrency limits
  const registry = readTaskRegistry(forgeDir);
  const runningCount = Object.values(registry.tasks).filter(t => t.status === 'running').length;
  const runningPerRepo = {};
  for (const [id, info] of Object.entries(registry.tasks)) {
    if (info.status === 'running' && info.repo) {
      runningPerRepo[info.repo] = (runningPerRepo[info.repo] || 0) + 1;
    }
  }

  const ready = [];
  for (const task of allUnblocked) {
    if (runningCount + ready.length >= maxConcurrent) break;
    if (task.repo && (runningPerRepo[task.repo] || 0) >= maxPerRepo) continue;
    // File overlap detection: skip if any running task shares estimated files
    if (hasFileOverlap(task, registry)) continue;
    ready.push(task);
  }
  return ready;
}

// === File Overlap Detection ===
// Prevents parallel tasks from modifying the same files

function hasFileOverlap(task, registry) {
  const taskFiles = new Set(task.estimated_files || []);
  if (taskFiles.size === 0) return false;
  for (const [id, info] of Object.entries(registry.tasks)) {
    if (info.status !== 'running') continue;
    const runningFiles = info.estimated_files || [];
    for (const f of runningFiles) {
      if (taskFiles.has(f)) return true;
    }
  }
  return false;
}

// === Codex Integration ===
// Checks whether Codex adversarial review or rescue should run for a given task.

function shouldRunCodexReview(task, depth, forgeDir) {
  const config = loadConfig(path.dirname(forgeDir));
  const codexConfig = config.codex || {};
  if (codexConfig.enabled === false) return false;
  const reviewConfig = codexConfig.review || {};
  if (reviewConfig.enabled === false) return false;

  // Check capability
  let caps;
  try {
    caps = JSON.parse(fs.readFileSync(path.join(forgeDir, '..', '.forge', 'capabilities.json'), 'utf8'));
  } catch (e) {
    try {
      caps = JSON.parse(fs.readFileSync(path.join(forgeDir, 'capabilities.json'), 'utf8'));
    } catch (e2) { return false; }
  }
  if (!caps.codex || !caps.codex.available) return false;

  // Depth gating
  if (depth === 'quick') return false;
  if (depth === 'thorough') return true;

  // Standard depth: only sensitive tasks
  const sensitiveTags = reviewConfig.sensitive_tags || ['security', 'shared', 'api-export'];
  const taskName = (task.name || '').toLowerCase();
  return sensitiveTags.some(tag => taskName.includes(tag));
}

function shouldRunCodexRescue(forgeDir, debugAttempts) {
  const config = loadConfig(path.dirname(forgeDir));
  const codexConfig = config.codex || {};
  if (codexConfig.enabled === false) return false;
  const rescueConfig = codexConfig.rescue || {};
  if (rescueConfig.enabled === false) return false;

  const threshold = rescueConfig.debug_attempts_before_rescue || 2;
  if (debugAttempts < threshold) return false;

  // Check capability
  let caps;
  try {
    caps = JSON.parse(fs.readFileSync(path.join(forgeDir, 'capabilities.json'), 'utf8'));
  } catch (e) { return false; }
  return caps.codex && caps.codex.available;
}

function buildCodexReviewPrompt(task, forgeDir) {
  const config = loadConfig(path.dirname(forgeDir));
  const model = (config.codex || {}).review?.model || 'gpt-5.4-mini';

  return `Run Codex adversarial review on the uncommitted changes for task ${task.id}: ${task.name}.

Dispatch the codex:codex-rescue subagent (or invoke codex-companion.mjs directly) with:

\`\`\`bash
node "\${CLAUDE_PLUGIN_ROOT_CODEX}/scripts/codex-companion.mjs" review --scope working-tree --model ${model}
\`\`\`

If Codex is not available via the companion script, use the Agent tool with subagent_type "codex:codex-rescue" and prompt:
"Review the uncommitted changes in the working tree. Focus on: race conditions, edge cases, hidden assumptions, security issues. Return findings with severity (CRITICAL/IMPORTANT/MINOR) and file:line references."

After receiving results:
- CRITICAL issues: fix them, re-run tests, update state.md task_status to "fixing"
- IMPORTANT/MINOR issues: log in state.md under "Key Decisions", proceed to commit
- No issues: proceed to commit

Update state.md task_status to "codex-reviewed" when done.`;
}

function buildCodexRescuePrompt(task, errorContext, debugAttempts) {
  return `Task ${task.id} is stuck after ${debugAttempts} debug attempts. Escalate to Codex rescue for a fresh perspective.

Dispatch the codex:codex-rescue subagent with this prompt:

<task>
Diagnose why tests are failing for "${task.name}" in this repository.
Claude Code attempted ${debugAttempts} fixes that didn't work.
Error context: ${errorContext}
</task>

<compact_output_contract>
Return: 1. most likely root cause, 2. evidence from the code, 3. smallest safe fix
</compact_output_contract>

<default_follow_through_policy>
Default to the most reasonable interpretation. Apply the fix directly (--write mode).
</default_follow_through_policy>

Use the --write flag so Codex can make changes directly.

After Codex returns:
- If tests pass with Codex's fix: update state.md task_status to "testing", continue
- If Codex also fails: update state.md task_status to "blocked", the loop will handle re-decomposition or human escalation`;
}

// === Adaptive Replanning ===
// After a wave of tasks completes, check if replanning is warranted.

function shouldReplan(forgeDir, completedTaskIds) {
  const config = loadConfig(path.dirname(forgeDir));
  const replanConfig = config.replanning || {};
  if (replanConfig.enabled === false) return false;

  const threshold = replanConfig.concern_threshold || 0.3;
  const registry = readTaskRegistry(forgeDir);

  let concernCount = 0;
  let totalChecked = 0;
  for (const id of completedTaskIds) {
    const info = registry.tasks[id];
    if (!info) continue;
    totalChecked++;
    if (info.status === 'complete_with_concerns' || info.concerns) {
      concernCount++;
    }
  }

  if (totalChecked === 0) return false;
  return (concernCount / totalChecked) >= threshold;
}

// === CLI: Route Command (called by stop-hook.sh) ===

// === Session Budget Gating + Circuit Breaker (T010, R003) ===
//
// Two recoverable hard ceilings on the autonomous loop:
//   1. session_budget_tokens -- cumulative tokens in the ledger total.
//      Falls back to legacy `token_budget` for old config files.
//   2. max_iterations         -- raw iteration count from the stop hook.
//
// When either ceiling is hit, routeDecision() flips state.data.phase to
// `budget_exhausted`, writes a caveman-form handoff to .forge/resume.md,
// and returns an exit-action object so the stop hook can stop the loop.
// Both conditions are recoverable: user raises the ceiling in config,
// runs `/forge resume`, and the loop picks up where it left off.

function _resolveSessionBudget(config, forgeDir) {
  // Backward compat: if the user's raw config sets only legacy `token_budget`
  // and not `session_budget_tokens`, honour the legacy value as the session
  // ceiling. Reads the raw user config to distinguish "user explicitly set"
  // from "default injected by deepMerge". Falls through to merged config if
  // no raw file is present.
  if (forgeDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(forgeDir, 'config.json'), 'utf8'));
      const hasNew = raw && Object.prototype.hasOwnProperty.call(raw, 'session_budget_tokens');
      const hasLegacy = raw && Object.prototype.hasOwnProperty.call(raw, 'token_budget');
      if (!hasNew && hasLegacy) return raw.token_budget;
    } catch (e) { /* no user config -> fall through to merged value */ }
  }
  const sessionBudget = getConfig(config, 'session_budget_tokens', null);
  if (sessionBudget != null) return sessionBudget;
  return getConfig(config, 'token_budget', 500000);
}

function checkSessionBudget(forgeDir, config, iteration) {
  // Returns null if under budget, otherwise an object describing which
  // ceiling was hit. Pure: no side effects, safe to call repeatedly.
  const ledger = readLedger(forgeDir);
  const total = (ledger && typeof ledger.total === 'number') ? ledger.total : 0;
  const sessionBudget = _resolveSessionBudget(config, forgeDir);
  if (sessionBudget > 0 && total >= sessionBudget) {
    return {
      exhausted: true,
      type: 'session_budget_exhausted',
      total: total,
      ceiling: sessionBudget
    };
  }
  const maxIter = getConfig(config, 'max_iterations', 100);
  const currentIter = (typeof iteration === 'number') ? iteration : 0;
  if (maxIter > 0 && currentIter >= maxIter) {
    return {
      exhausted: true,
      type: 'iteration_budget_exhausted',
      total: currentIter,
      ceiling: maxIter
    };
  }
  return null;
}

function writeBudgetExhaustedHandoff(forgeDir, info, stateData) {
  // Caveman form per R013: short fragments, dropped articles, arrows for
  // causality. No em dashes (per CLAUDE.md style for this task).
  const data = stateData || {};
  const phaseBefore = data.phase || 'unknown';
  const spec = data.spec || 'unknown';
  const currentTask = data.current_task || 'none';
  const lastDone = data.last_completed_task || 'unknown';
  const nextPending = data.next_pending_task || 'see frontier';
  const reason = info && info.type ? info.type : 'session_budget_exhausted';
  const ceiling = info && info.ceiling != null ? info.ceiling : 'unknown';
  const total = info && info.total != null ? info.total : 'unknown';

  const lines = [
    '# resume.md -- budget exhausted',
    '',
    `reason -> ${reason}`,
    `ceiling -> ${ceiling}`,
    `used -> ${total}`,
    '',
    'state before stop:',
    `  phase -> ${phaseBefore}`,
    `  spec -> ${spec}`,
    `  current task -> ${currentTask}`,
    `  last done -> ${lastDone}`,
    `  next pending -> ${nextPending}`,
    '',
    'recover steps:',
    reason === 'iteration_budget_exhausted'
      ? '  1. raise max_iterations in .forge/config.json'
      : '  1. raise session_budget_tokens in .forge/config.json (or wait for next billing cycle)',
    '  2. run /forge resume',
    '  3. loop pick up from current task -> no replan needed',
    '',
    'no spec gap. no bug. budget ceiling only.',
    ''
  ];

  try {
    fs.writeFileSync(path.join(forgeDir, 'resume.md'), lines.join('\n'));
    return { written: true };
  } catch (e) {
    return { written: false, reason: e.code || 'unknown' };
  }
}

function _enterBudgetExhausted(forgeDir, info, state) {
  // Centralised state mutation: phase -> budget_exhausted, write handoff,
  // return the exit-action object the stop hook understands.
  try {
    state.data.phase = 'budget_exhausted';
    state.data.budget_exhausted_reason = info.type;
    state.data.budget_exhausted_at = new Date().toISOString();
    writeState(forgeDir, state.data, state.content);
  } catch (e) { /* state write failed -- still write handoff and exit */ }
  writeBudgetExhaustedHandoff(forgeDir, info, state.data);
  return { action: 'exit', reason: info.type };
}

function routeDecision(forgeDir, iteration, transcriptPath) {
  const config = loadConfig(path.dirname(forgeDir));
  let state = readState(forgeDir);

  // --- Session + iteration budget gating (T010, R003) ---
  // Hard ceiling check at every routeDecision call. Each call corresponds
  // to a state-machine transition, so this fires before any phase logic.
  // If we are already in budget_exhausted phase, short-circuit to exit so
  // the loop doesn't keep re-firing on top of an exhausted ledger.
  if (state.data.phase === 'budget_exhausted') {
    return { action: 'exit', reason: state.data.budget_exhausted_reason || 'budget_exhausted' };
  }
  const budgetCheck = checkSessionBudget(forgeDir, config, iteration);
  if (budgetCheck && budgetCheck.exhausted) {
    return _enterBudgetExhausted(forgeDir, budgetCheck, state);
  }

  const phase = state.data.phase || 'idle';
  const taskStatus = state.data.task_status || null;
  const currentTask = state.data.current_task || null;
  const autonomy = state.data.autonomy || config.autonomy;
  const depth = state.data.depth || config.depth;

  // --- Fix #6: Verify state consistency before routing ---
  const stateIssues = verifyStateConsistency(forgeDir, state);
  if (stateIssues.length > 0) {
    // Re-read state after auto-fixes
    state = readState(forgeDir);
  }
  const effectiveTaskStatus = state.data.task_status || taskStatus;

  // --- Token budget check (Fix #7: atomic ledger update) ---
  if (transcriptPath) {
    const totalTranscriptTokens = estimateTokensFromTranscript(transcriptPath);
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');
    let ledger = { total: 0, iterations: 0, per_spec: {}, last_transcript_tokens: 0 };
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) {}
    const prevTokens = ledger.last_transcript_tokens || 0;
    const iterationDelta = Math.max(0, totalTranscriptTokens - prevTokens);
    // Single atomic write includes both total and last_transcript_tokens
    const updated = updateTokenLedger(forgeDir, iterationDelta, totalTranscriptTokens);

    const budget = state.data.tokens_budget || config.token_budget;
    const usage = updated.total / budget;

    if (usage >= 1.0) {
      return ''; // Budget exhausted — allow exit
    }
    if (usage >= 0.7) {
      state.data.depth = 'quick';
      writeState(forgeDir, state.data, state.content);
    }
  }

  // --- Context window check ---
  if (transcriptPath) {
    try {
      const stats = fs.statSync(transcriptPath);
      const estimatedContextPercent = (stats.size / 4 / 200000) * 100;
      if (estimatedContextPercent >= (config.context_reset_threshold || 60)) {
        if (state.data.handoff_requested) {
          const prompt = generateResumePrompt(state.data, path.dirname(forgeDir));
          fs.writeFileSync(path.join(forgeDir, '.forge-resume.md'), prompt);
          return ''; // Allow exit for context reset
        } else {
          state.data.handoff_requested = true;
          writeState(forgeDir, state.data, state.content);
          return 'Context approaching limit. Save comprehensive handoff to .forge/state.md including: current task, what\'s done, what\'s next, in-flight decisions, and any files you were editing. Write the handoff NOW, then stop.';
        }
      }
    } catch (e) { /* transcript not accessible */ }
  }

  // Handoff was requested and completed
  if (state.data.handoff_requested) {
    const prompt = generateResumePrompt(state.data, path.dirname(forgeDir));
    fs.writeFileSync(path.join(forgeDir, '.forge-resume.md'), prompt);
    return ''; // Allow exit for context reset
  }

  // --- Fix #2: No-progress circuit breaker ---
  if (phase === 'executing') {
    const snapshot = getProgressSnapshot(forgeDir);
    const hasProgress = checkProgress(forgeDir, snapshot);
    if (!hasProgress) {
      const noProgressCount = getNoProgressCount(forgeDir);
      const threshold = config.loop.circuit_breaker_no_progress || 2;
      if (noProgressCount >= threshold) {
        state.data.task_status = 'blocked';
        state.data.blocked_reason = 'no_progress';
        writeState(forgeDir, state.data, state.content);
        return ''; // Allow exit — needs human intervention
      }
    }
  }

  // Phase-based routing
  switch (phase) {
    case 'idle':
      return ''; // Nothing to do

    case 'executing': {
      // Read frontier to find current/next task
      let plans;
      try {
        plans = fs.readdirSync(path.join(forgeDir, 'plans')).filter(f => f.endsWith('-frontier.md'));
      } catch (e) {
        plans = [];
      }
      if (plans.length === 0) return '';

      const currentSpec = state.data.spec;
      const frontierFile = plans.find(f => f.includes(currentSpec)) || plans[0];
      const frontierText = fs.readFileSync(path.join(forgeDir, 'plans', frontierFile), 'utf8');
      const tasks = parseFrontier(frontierText);

      // Find current task
      const task = tasks.find(t => t.id === currentTask);

      if (!task && currentTask) {
        // Task not found — may be complete, find next
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (!effectiveTaskStatus || effectiveTaskStatus === 'pending') {
        return buildTaskPrompt(task || tasks[0], forgeDir, depth);
      }

      if (effectiveTaskStatus === 'implementing') {
        return `Task ${currentTask} implemented. Now run the tests. If any fail, fix them. Update .forge/state.md task_status to "testing" when tests pass.`;
      }

      if (effectiveTaskStatus === 'testing') {
        if (depth !== 'quick') {
          // --- Fix #11: Initialize and track review iteration count ---
          state.data.review_iterations = (state.data.review_iterations || 0) + 1;
          state.data.task_status = 'reviewing';
          writeState(forgeDir, state.data, state.content);
          return `Tests passing for ${currentTask}. Review iteration ${state.data.review_iterations}/${config.loop.circuit_breaker_review_iterations}. Review the implementation against the spec. Check for: missing acceptance criteria, over-engineering, edge cases, security issues. Report PASS or ISSUES with file:line references.`;
        }
        // Quick mode — skip review, commit and advance
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (effectiveTaskStatus === 'reviewing') {
        // --- Fix #11: Enforce review iteration circuit breaker ---
        const reviewCount = state.data.review_iterations || 0;
        const maxReviews = config.loop.circuit_breaker_review_iterations || 3;
        if (reviewCount >= maxReviews) {
          return advanceToNextTask(tasks, state, forgeDir, currentSpec,
            `Review circuit breaker triggered (${reviewCount}/${maxReviews} iterations). Accepting current implementation with warnings. Commit and move on.`);
        }
        // Check if Codex adversarial review should run before committing
        const currentTaskObj = tasks.find(t => t.id === currentTask);
        if (currentTaskObj && shouldRunCodexReview(currentTaskObj, depth, forgeDir)) {
          state.data.task_status = 'codex-reviewing';
          writeState(forgeDir, state.data, state.content);
          return buildCodexReviewPrompt(currentTaskObj, forgeDir);
        }
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (effectiveTaskStatus === 'codex-reviewing' || effectiveTaskStatus === 'codex-reviewed') {
        // Codex review done, proceed to commit
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (effectiveTaskStatus === 'fixing') {
        return `Fix the issues identified in review for ${currentTask}, then re-run tests to confirm they still pass. Update .forge/state.md task_status to "testing" when done.`;
      }

      if (effectiveTaskStatus === 'codex-rescuing') {
        // Codex rescue completed -- check if it worked
        return `Codex rescue for ${currentTask} has been dispatched. Check if tests pass now. If yes, update state.md task_status to "testing" and continue. If still failing, update to "blocked".`;
      }

      if (effectiveTaskStatus === 'debugging') {
        const debugAttempts = state.data.debug_attempts || 0;

        // Codex rescue: try before exhausting debug circuit breaker
        if (shouldRunCodexRescue(forgeDir, debugAttempts)) {
          const currentTaskObj = tasks.find(t => t.id === currentTask);
          if (currentTaskObj) {
            state.data.task_status = 'codex-rescuing';
            writeState(forgeDir, state.data, state.content);
            const errorContext = state.data.blocked_reason || state.content.match(/error[:\s](.{0,200})/i)?.[1] || 'unknown';
            return buildCodexRescuePrompt(currentTaskObj, errorContext, debugAttempts);
          }
        }

        if (debugAttempts >= config.loop.circuit_breaker_debug_attempts) {
          // --- Fix #10: Auto-invoke backprop before giving up ---
          // Instead of immediately blocking, give Claude one chance to trace
          // the failure back to a spec gap and self-correct.
          state.data.task_status = 'blocked';
          state.data.blocked_reason = 'debug_exhausted';
          writeState(forgeDir, state.data, state.content);
          return `Debug circuit breaker triggered for ${currentTask} (${debugAttempts} attempts exhausted).

Before marking as blocked, run backpropagation to trace this failure to a spec gap:

1. Read the test failure output and identify what behavior is broken
2. Trace to the spec requirement in .forge/specs/ that should cover this case
3. Check if the acceptance criteria are missing or incomplete for this edge case
4. Log your findings to .forge/state.md under "Key Decisions"

If you identify a spec gap that explains the failure:
- Update .forge/state.md task_status to "implementing" to retry with the corrected understanding
- Note the spec gap so it can be fixed via /forge backprop later

If the issue is not a spec gap (infrastructure, environment, dependency):
- Describe the root cause clearly in state.md
- The loop will exit and wait for human intervention.`;
        }
        state.data.debug_attempts = debugAttempts + 1;
        writeState(forgeDir, state.data, state.content);
        return `Debug attempt ${debugAttempts + 1}/${config.loop.circuit_breaker_debug_attempts} for ${currentTask}. Investigate the root cause systematically: 1) Read error messages carefully, 2) Find a working example of similar code, 3) Form a hypothesis, 4) Test it minimally. Do NOT guess — investigate first.`;
      }

      if (effectiveTaskStatus === 'blocked') {
        // Attempt re-decomposition before giving up to human
        const redecompConfig = config.redecomposition || {};
        if (redecompConfig.enabled !== false) {
          const expansionDepth = state.data.expansion_depth || 0;
          const maxDepth = redecompConfig.max_expansion_depth || 1;
          if (expansionDepth < maxDepth) {
            state.data.task_status = 'redecomposing';
            state.data.expansion_depth = expansionDepth + 1;
            writeState(forgeDir, state.data, state.content);
            const reason = state.data.blocked_reason || 'unknown';
            return `Task ${currentTask} is blocked after exhausting debug attempts. Before escalating to human, attempt to re-decompose this task into 2-3 smaller sub-tasks.

Use the Agent tool to dispatch a forge-planner agent with:
- The failed task description and blocked reason: "${reason}"
- The spec file for context
- Instructions to break ${currentTask} into sub-tasks with decimal IDs (e.g., ${currentTask}.1, ${currentTask}.2)

Sub-tasks should:
- Inherit ${currentTask}'s dependencies
- Each tackle a smaller, more isolated piece of the problem
- Be written to the frontier file as new entries

After creating sub-tasks, update .forge/task-status.json to mark ${currentTask} as "redecomposed" and add the new sub-task entries as "pending". Then update state.md task_status to "complete" so the loop advances to the next ready task.`;
          }
        }
        return ''; // Allow exit — needs human
      }

      // Default: try to advance
      return advanceToNextTask(tasks, state, forgeDir, currentSpec);
    }

    case 'reviewing_branch': {
      // Holistic branch review runs after all tasks complete, before phase verification.
      // This catches cross-task integration issues, blast radius problems, and
      // convention drift that per-task reviews miss.
      const baseBranch = config.repos?.[Object.keys(config.repos || {})[0]]?.base_branch || 'main';
      const currentSpec = state.data.spec || 'unknown';
      const reviewDepth = state.data.depth || config.depth || 'standard';

      state.data.phase = 'verifying';
      writeState(forgeDir, state.data, state.content);

      return `All tasks for spec "${currentSpec}" are complete. Before phase verification, run a holistic branch review.

Use /forge review-branch with:
- --base ${baseBranch}
- --spec .forge/specs/spec-${currentSpec}.md
- --depth ${reviewDepth}

This reviews the ENTIRE branch diff (not commit-by-commit) for:
1. Blast radius: check all dependents of modified files for breaking changes
2. Convention compliance: verify new code matches existing codebase patterns
3. Spec coverage: every acceptance criterion in the spec is met
4. Cross-task integration: components from different tasks are properly wired

If CRITICAL issues are found, fix them before verification proceeds.
If the review passes, proceed to phase verification.

After review, update .forge/state.md phase to "verifying".`;
    }

    case 'verifying': {
      // Autonomy mode: gated pauses between specs/phases
      const effectiveAutonomy = state.data.autonomy || config.autonomy;
      if (effectiveAutonomy === 'gated' || effectiveAutonomy === 'supervised') {
        // Fix #9: Generate summary before pausing
        try { generateSummary(forgeDir); } catch (e) {}
        return ''; // Allow exit between phases
      }

      // Verification complete — check for next spec or finish
      let specs;
      try {
        specs = fs.readdirSync(path.join(forgeDir, 'specs')).filter(f => f.endsWith('.md'));
      } catch (e) {
        specs = [];
      }
      const currentIdx = specs.findIndex(f => f.includes(state.data.spec));
      const nextSpec = specs[currentIdx + 1];

      if (nextSpec) {
        // Fix #9: Generate summary for completed spec before moving on
        try { generateSummary(forgeDir); } catch (e) {}
        const domain = nextSpec.replace('spec-', '').replace('.md', '');
        state.data.spec = domain;
        state.data.phase = 'executing';
        state.data.current_task = null;
        state.data.task_status = 'pending';
        state.data.review_iterations = 0;
        state.data.debug_attempts = 0;
        writeState(forgeDir, state.data, state.content);
        return `Phase verified. Moving to next spec: ${domain}. Read .forge/specs/${nextSpec} and .forge/plans/${domain}-frontier.md, then start implementing the first task.`;
      }

      // All specs done — generate final summary
      try { generateSummary(forgeDir); } catch (e) {}
      return ''; // Allow exit — loop complete
    }

    default:
      return '';
  }
}

// Fix #4: findNextUnblockedTask now uses task registry as primary source
// with a more flexible regex fallback for state.md content.
function findNextUnblockedTask(tasks, state, forgeDir) {
  const doneTasks = new Set();

  // Primary: task registry (programmatic, reliable)
  if (forgeDir) {
    const registry = readTaskRegistry(forgeDir);
    for (const [id, info] of Object.entries(registry.tasks)) {
      if (info.status === 'complete') doneTasks.add(id);
    }
  }

  // Fallback: state.md content (more flexible regex for backwards compat)
  const doneContent = state.content || '';
  for (const line of doneContent.split('\n')) {
    // Handles: "- T001:", "- **T001**:", "  - T001 —", "- T001 -" etc.
    const match = line.match(/^[\s*-]*\*{0,2}(T\d+)\*{0,2}[\s:—-]/);
    if (match) doneTasks.add(match[1]);
  }

  for (const task of tasks) {
    if (doneTasks.has(task.id)) continue;
    if (task.status === 'complete') continue;
    const allDepsComplete = task.depends.every(d => doneTasks.has(d));
    if (allDepsComplete) return task;
  }
  return null;
}

function buildTaskPrompt(task, forgeDir, depth) {
  // Look up spec by domain name from state, not by repo name
  const state = readState(forgeDir);
  const specName = state.data.spec || 'main';
  let specInfo = `Read the spec at .forge/specs/spec-${specName}.md for acceptance criteria.`;
  // Verify the spec file exists, fall back to first spec if not
  try {
    const specPath = path.join(forgeDir, 'specs', `spec-${specName}.md`);
    if (!fs.existsSync(specPath)) {
      const specs = fs.readdirSync(path.join(forgeDir, 'specs')).filter(f => f.endsWith('.md'));
      if (specs.length > 0) specInfo = `Read the spec at .forge/specs/${specs[0]} for acceptance criteria.`;
    }
  } catch (e) { /* no specs dir */ }

  let prompt = `Implement task ${task.id}: ${task.name}\n\n`;

  // Context bundle (pre-assembled, curated context)
  const bundlePath = path.join(forgeDir, 'context-bundles', `${task.id}.md`);
  if (fs.existsSync(bundlePath)) {
    prompt += `Read the context bundle at .forge/context-bundles/${task.id}.md for curated context (spec requirements, dependency artifacts, conventions).\n\n`;
  } else {
    prompt += `${specInfo}\n\n`;
  }

  // Artifact summaries from dependencies
  if (task.depends && task.depends.length > 0) {
    const summary = buildArtifactSummary(forgeDir, task.depends);
    if (summary) prompt += `${summary}\n\n`;
  }

  if (task.repo) prompt += `This task targets the "${task.repo}" repo.\n`;

  // Model advisory (from router)
  try {
    const config = loadConfig(path.dirname(forgeDir));
    if (config.model_routing && config.model_routing.enabled !== false) {
      const router = require('./forge-router.cjs');
      const budget = require('./forge-budget.cjs');
      const budgetState = budget.getBudgetState(forgeDir, config);
      const advisory = router.buildModelAdvisory(task, 'forge-executor', config, budgetState);
      prompt += `\n## Model Advisory\n${advisory.advisory}\n`;
    }
  } catch (e) { /* router not available, skip */ }

  if (depth === 'thorough') {
    prompt += `Use TDD: write failing test first, then implement, then verify tests pass.\n`;
  } else if (depth === 'standard') {
    prompt += `Implement the feature and write tests. Commit when tests pass.\n`;
  } else {
    prompt += `Implement the feature. Run existing tests if available. Commit.\n`;
  }

  prompt += `\nAfter completing, update .forge/state.md: set task_status to "testing" and describe what you implemented under "In-Flight Work".`;
  prompt += `\nAlso update .forge/task-status.json to track this task's completion status.`;

  // Artifact writing instruction
  if (task.provides && task.provides.length > 0) {
    prompt += `\n\nThis task provides artifacts: ${task.provides.join(', ')}. After committing, write an artifact file to .forge/artifacts/${task.id}.json with the artifact names as keys and descriptions of what was produced as values.`;
  }

  return prompt;
}

// Fix #5: advanceToNextTask now checks for multiple unblocked same-tier tasks
// and instructs Claude to dispatch them in parallel using the Agent tool.
function advanceToNextTask(tasks, state, forgeDir, currentSpec, overrideMessage) {
  const config = loadConfig(path.dirname(forgeDir));
  const effectiveAutonomy = state.data.autonomy || config.autonomy;

  // --- Fix #4: Mark current task complete in registry ---
  const currentTask = state.data.current_task;
  if (currentTask) {
    // T021/R004: if the task ran inside a worktree and produced commits,
    // squash-merge them into the parent branch before declaring it done.
    // Merge failure -> stay in-progress with conflict_resolution phase.
    let mergedSha = null;
    try {
      const projectRoot = path.dirname(forgeDir);
      const result = completeTaskInWorktree(forgeDir, currentTask, projectRoot);
      if (result && result.merged) {
        mergedSha = result.commit_sha || null;
      } else if (result && result.reason === 'merge_conflict') {
        // Halt advancement so the scheduler can fall back to sequential.
        return state;
      }
    } catch (e) { /* squash-merge is best-effort here */ }

    markTaskComplete(forgeDir, currentTask, mergedSha);

    const doneEntry = `- ${currentTask}: complete`;
    if (!state.content.includes(currentTask)) {
      state.content = state.content.replace('## What\'s Done', `## What's Done\n${doneEntry}`);
    }
  }

  // --- Fix #5: Find all unblocked tasks, not just the first ---
  const unblockedTasks = findAllUnblockedTasks(tasks, forgeDir);

  if (unblockedTasks.length === 0) {
    // All tasks done — always route to holistic branch review before verification
    state.data.phase = 'reviewing_branch';
    state.data.current_task = null;
    state.data.task_status = null;
    state.data.review_iterations = 0;
    writeState(forgeDir, state.data, state.content);
    const prefix = overrideMessage ? overrideMessage + '\n\n' : '';
    return `${prefix}All tasks complete. Before phase verification, run a holistic branch review to catch cross-task integration issues, blast radius problems, and convention drift. Commit your work first, then run the branch review.`;
  }

  // Supervised mode: pause after every task for human review
  if (effectiveAutonomy === 'supervised') {
    state.data.current_task = unblockedTasks[0].id;
    state.data.task_status = 'pending';
    state.data.review_iterations = 0;
    writeState(forgeDir, state.data, state.content);
    return ''; // Allow exit — user must /forge resume
  }

  // --- Fix #5: Parallel dispatch for multiple unblocked same-tier tasks ---
  if (unblockedTasks.length > 1) {
    const sameTier = unblockedTasks.filter(t => t.tier === unblockedTasks[0].tier);
    if (sameTier.length > 1) {
      // Set state to track the first task
      state.data.current_task = sameTier[0].id;
      state.data.task_status = 'pending';
      state.data.review_iterations = 0;
      state.data.debug_attempts = 0;
      writeState(forgeDir, state.data, state.content);

      const taskList = sameTier.map(t =>
        `- ${t.id}: ${t.name}${t.repo ? ` (repo: ${t.repo})` : ''}`
      ).join('\n');
      const prefix = overrideMessage ? overrideMessage + '\n\n' : '';

      return `${prefix}${sameTier.length} tasks in Tier ${sameTier[0].tier} are ready for parallel execution:
${taskList}

Use the Agent tool to dispatch each task as an independent subagent with isolation: "worktree". Each agent should:
1. Read the spec at .forge/specs/spec-${currentSpec}.md for acceptance criteria
2. Implement its assigned task following the project conventions
3. Write tests and verify they pass
4. Commit atomically with the task ID in the message

After all agents complete, update .forge/state.md and .forge/task-status.json with results.
Start ${sameTier[0].id} yourself and dispatch the rest as agents.`;
    }
  }

  // Single task — normal sequential execution
  state.data.current_task = unblockedTasks[0].id;
  state.data.task_status = 'pending';
  state.data.review_iterations = 0;
  state.data.debug_attempts = 0;
  writeState(forgeDir, state.data, state.content);
  const prefix = overrideMessage ? overrideMessage + '\n\n' : '';
  return prefix + buildTaskPrompt(unblockedTasks[0], forgeDir, state.data.depth || 'standard');
}

// === Headless Mode (T011, R009/R010) ===
//
// The "actual" Forge execution loop runs inside Claude Code via the stop hook
// in hooks/. This module is a CLI helper, not an LLM caller, so the headless
// `execute` subcommand cannot itself invoke Claude. Instead it:
//   1. Acquires the forge loop lock so concurrent runs cannot collide.
//   2. Initializes a `.forge/runs/{ts}/` directory and a caveman-form log.txt.
//   3. Records mode/spec/notify_url/pid in the log header so the actual
//      executor (started separately, e.g. by a CI wrapper that launches
//      `claude` with the forge plugin) can pick up where this left off.
//
// The headless `query` / `status` subcommand is a pure-read state snapshot.
// No LLM calls. Target: well under 100ms on a small .forge/.

// Exit codes for headless execute (R010).
const HEADLESS_EXIT = {
  COMPLETE: 0,
  FAILED: 1,
  BUDGET_EXHAUSTED: 2,
  BLOCKED_NEEDS_HUMAN: 3,
  LOCK_CONFLICT: 4
};

function _headlessTimestamp() {
  // ISO 8601 with colons replaced for Windows path safety.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function _findFrontierTasks(forgeDir) {
  const plansDir = path.join(forgeDir, 'plans');
  const tasks = [];
  if (!fs.existsSync(plansDir)) return tasks;
  for (const f of fs.readdirSync(plansDir)) {
    if (!f.endsWith('-frontier.md')) continue;
    try {
      const text = fs.readFileSync(path.join(plansDir, f), 'utf8');
      tasks.push(...parseFrontier(text));
    } catch (e) { /* skip unreadable plan */ }
  }
  return tasks;
}

function _readLastError(forgeDir, state) {
  // Prefer state.md frontmatter, fall back to most recent checkpoint error_log.
  if (state && state.data && state.data.last_error) return state.data.last_error;
  try {
    const cps = listCheckpoints(forgeDir);
    for (const cp of cps) {
      if (Array.isArray(cp.error_log) && cp.error_log.length > 0) {
        const last = cp.error_log[cp.error_log.length - 1];
        if (typeof last === 'string') return last;
        if (last && last.message) return last.message;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Headless status JSON schema version. Bump only on backward-incompatible
// changes (removed/renamed fields, changed value types). Additive fields do
// not require a bump. See references/headless-status-schema.md.
const HEADLESS_STATUS_SCHEMA_VERSION = '1.0';

function queryHeadlessState(forgeDir) {
  const state = readState(forgeDir);
  const ledger = readLedger(forgeDir);
  const lockRaw = readLock(forgeDir);
  let lockStatus = 'free';
  let lastHeartbeat = null;
  if (lockRaw) {
    const stale = detectStaleLock(forgeDir);
    lockStatus = (stale && stale.is_stale) ? 'stale' : 'held';
    lastHeartbeat = (lockRaw.heartbeat && typeof lockRaw.heartbeat === 'string') ? lockRaw.heartbeat : null;
  }

  const tasks = _findFrontierTasks(forgeDir);
  const completedTasks = tasks.filter(t => t.status === 'complete').length;
  // Frontier parser leaves status='pending' for everything; cross-reference registry.
  let completedFromRegistry = 0;
  let totalFromRegistry = tasks.length;
  try {
    const reg = readTaskRegistry(forgeDir);
    if (reg && reg.tasks) {
      const ids = Object.keys(reg.tasks);
      totalFromRegistry = Math.max(totalFromRegistry, ids.length);
      completedFromRegistry = ids.filter(k => reg.tasks[k] && reg.tasks[k].status === 'complete').length;
    }
  } catch (e) { /* registry optional */ }
  const completed = Math.max(completedTasks, completedFromRegistry);
  const remaining = Math.max(0, totalFromRegistry - completed);

  const budget = (state.data && typeof state.data.tokens_budget === 'number') ? state.data.tokens_budget : 0;
  const used = (ledger && typeof ledger.total === 'number') ? ledger.total : 0;

  let activeCheckpoints = 0;
  try { activeCheckpoints = listCheckpoints(forgeDir).length; } catch (e) { /* ignore */ }

  // T022 / R010 additive fields. All default to null when not present in
  // state, never undefined, so JSON consumers see a stable shape.
  const data = state.data || {};
  const specDomain = (typeof data.spec === 'string' && data.spec) ? data.spec : null;
  const tier = (data.tier !== undefined && data.tier !== null && data.tier !== '')
    ? (typeof data.tier === 'number' ? data.tier : String(data.tier))
    : null;
  const autonomy = (typeof data.autonomy === 'string' && data.autonomy) ? data.autonomy : null;
  const depth = (typeof data.depth === 'string' && data.depth) ? data.depth : null;
  // tool_count: best-effort proxy from ledger.iterations (PostToolUse hook
  // increments this). Always integer, never null.
  const toolCount = (ledger && Number.isFinite(ledger.iterations)) ? Math.trunc(ledger.iterations) : 0;

  return {
    schema_version: HEADLESS_STATUS_SCHEMA_VERSION,
    queried_at: new Date().toISOString(),
    phase: (data.phase) || 'unknown',
    spec_domain: specDomain,
    tier: tier,
    autonomy: autonomy,
    depth: depth,
    current_task: (data.current_task) || null,
    completed_tasks: completed,
    remaining_tasks: remaining,
    token_budget_used: used,
    token_budget_remaining: Math.max(0, budget - used),
    tool_count: toolCount,
    last_error: _readLastError(forgeDir, state),
    lock_status: lockStatus,
    last_heartbeat: lastHeartbeat,
    active_checkpoints: activeCheckpoints
  };
}

function _formatHeadlessQuery(snap) {
  const rows = [
    ['schema_version', snap.schema_version],
    ['queried_at', snap.queried_at],
    ['phase', snap.phase],
    ['spec_domain', snap.spec_domain || '-'],
    ['tier', snap.tier == null ? '-' : String(snap.tier)],
    ['autonomy', snap.autonomy || '-'],
    ['depth', snap.depth || '-'],
    ['current_task', snap.current_task || '-'],
    ['completed_tasks', String(snap.completed_tasks)],
    ['remaining_tasks', String(snap.remaining_tasks)],
    ['token_budget_used', String(snap.token_budget_used)],
    ['token_budget_remaining', String(snap.token_budget_remaining)],
    ['tool_count', String(snap.tool_count)],
    ['lock_status', snap.lock_status],
    ['last_heartbeat', snap.last_heartbeat || '-'],
    ['active_checkpoints', String(snap.active_checkpoints)],
    ['last_error', snap.last_error ? String(snap.last_error).slice(0, 80) : '-']
  ];
  const keyW = Math.max(...rows.map(r => r[0].length));
  return rows.map(r => r[0].padEnd(keyW) + '  ' + r[1]).join('\n') + '\n';
}

// Performance budget for the headless query (R010): must complete in under
// 100ms on a typical .forge/. Reads are pure-fs, no LLM/git/network.
const HEADLESS_QUERY_BUDGET_MS = 100;

function _runQueryOnce(forgeDir, json) {
  const startNs = process.hrtime.bigint();
  const snap = queryHeadlessState(forgeDir);
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  if (json) {
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  } else {
    process.stdout.write(_formatHeadlessQuery(snap));
    process.stdout.write(`query_elapsed_ms  ${elapsedMs.toFixed(2)}\n`);
  }
  if (elapsedMs > HEADLESS_QUERY_BUDGET_MS) {
    process.stderr.write(
      `forge headless query: SLOW (${elapsedMs.toFixed(2)}ms > ${HEADLESS_QUERY_BUDGET_MS}ms budget)\n`
    );
  }
  return { snap, elapsedMs };
}

function runHeadless(args) {
  const sub = args[1];
  const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';

  if (sub === 'query' || sub === 'status') {
    const json = args.includes('--json');
    const watch = args.includes('--watch');

    if (!watch) {
      _runQueryOnce(forgeDir, json);
      return 0;
    }

    // --watch: re-query every 5s until SIGINT. Cross-platform clear via
    // ANSI escape; falls back to a separator on terminals that ignore it.
    const intervalMs = 5000;
    const tick = () => {
      try {
        // ESC[2J clears screen, ESC[H homes cursor. Works in Git Bash,
        // Windows Terminal, and POSIX terminals.
        process.stdout.write('\x1b[2J\x1b[H');
      } catch (e) { /* ignore */ }
      process.stdout.write(`# forge headless query (watch, every ${intervalMs / 1000}s, ctrl-c to exit)\n`);
      try {
        _runQueryOnce(forgeDir, json);
      } catch (e) {
        process.stderr.write(`forge headless query: ${e.message}\n`);
      }
    };
    tick();
    const handle = setInterval(tick, intervalMs);
    process.on('SIGINT', () => {
      clearInterval(handle);
      process.stderr.write('\nforge headless query: watch stopped\n');
      process.exit(0);
    });
    // Keep the event loop alive; setInterval already does this, but be
    // explicit so the function does not return prematurely.
    return 0;
  }

  if (sub === 'execute') {
    const spec = args.find((a, i) => args[i - 1] === '--spec') || '';
    const notifyUrl = args.find((a, i) => args[i - 1] === '--notify-url') || '';

    // Acquire forge loop lock. Refuse if a live lock is held by someone else.
    const lockResult = acquireLock(forgeDir, 'headless');
    if (!lockResult.acquired) {
      const holder = lockResult.holder || {};
      process.stderr.write(
        'forge headless: lock conflict (' +
        (lockResult.reason || 'unknown') +
        (holder.pid ? `, pid=${holder.pid}` : '') +
        ')\n'
      );
      return HEADLESS_EXIT.LOCK_CONFLICT;
    }

    // Initialize run directory + log.
    const ts = _headlessTimestamp();
    const runDir = path.join(forgeDir, 'runs', ts);
    _ensureDir(runDir);
    const logPath = path.join(runDir, 'log.txt');

    let forgeVersion = 'unknown';
    try {
      const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
      forgeVersion = manifest.version || 'unknown';
    } catch (e) { /* optional */ }

    // Caveman-form header (R013): short fragment values, one per line, then ---.
    const header = [
      `started: ${new Date().toISOString()}`,
      `spec: ${spec || '-'}`,
      `mode: headless_execute`,
      `pid: ${process.pid}`,
      `forge_version: ${forgeVersion}`,
      `notify_url: ${notifyUrl || 'none'}`,
      `args: ${args.join(' ')}`,
      `run_dir: ${runDir}`,
      `---`,
      ''
    ].join('\n');
    fs.writeFileSync(logPath, header);

    const append = (line) => {
      const stamp = new Date().toISOString().replace(/^.*T/, '').replace(/\..*$/, 'Z');
      fs.appendFileSync(logPath, `[${stamp}] ${line}\n`);
    };

    append('lock acquired' + (lockResult.tookOverStale ? ' (took over stale lock)' : ''));

    const tasks = _findFrontierTasks(forgeDir);
    append(`spec loaded -> ${tasks.length} tasks`);
    append('headless wrapper initialized; actual loop runs via Claude Code stop hook');
    append('to execute: run claude with the forge plugin in this directory');
    if (notifyUrl) append(`notify_url stored for executor: ${notifyUrl}`);

    // Release lock. The actual executor (Claude Code stop hook) will reacquire.
    releaseLock(forgeDir);
    append('lock released; ready for executor handoff');

    process.stdout.write(`headless run initialized: ${runDir}\n`);
    process.stdout.write(`log: ${logPath}\n`);
    return HEADLESS_EXIT.COMPLETE;
  }

  process.stderr.write(`forge headless: unknown subcommand '${sub || ''}'. Use execute|query|status.\n`);
  return HEADLESS_EXIT.FAILED;
}

// === Forensic Recovery (T020, R007/R008) ===
// Reconstruct execution state after a crashed/interrupted session.
// Triggered by /forge resume when stale lock, budget_exhausted, recovering
// phase, or orphan worktrees are detected. Returns a structured report and
// never throws on partial state. Does NOT continue execution and does NOT
// destroy user work without explicit action.

function _safeReadFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function _safeReadJson(p) {
  const text = _safeReadFile(p);
  if (text == null) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Parse `git log --pretty=format:%H|%s` output and pull task IDs from
// commit subjects matching forge(*): ... [Tnnn] or (Tnnn) or T### tail.
function _gitLogForgeCommits(projectRoot, sinceCount) {
  const root = projectRoot || process.cwd();
  let stdout = '';
  try {
    stdout = execFileSync(
      'git',
      ['log', `-${sinceCount || 200}`, '--pretty=format:%H|%s'],
      { cwd: root, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    return [];
  }
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf('|');
    if (sep === -1) continue;
    const hash = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    // Match forge(scope): ... patterns and extract any T### task ids.
    if (!/forge\s*\(/i.test(subject) && !/\bT\d+(\.\d+)?\b/.test(subject)) continue;
    const taskIds = [];
    const re = /\bT\d+(?:\.\d+)?\b/g;
    let m;
    while ((m = re.exec(subject)) !== null) {
      taskIds.push(m[0]);
    }
    out.push({ hash: hash.slice(0, 7), subject, task_ids: taskIds });
  }
  return out;
}

// Discover all frontier task IDs from .forge/plans/*-frontier.md so we can
// cross-reference orphan worktrees and reconstruct DAG order.
function _collectAllFrontierTasks(forgeDir) {
  const plansDir = path.join(forgeDir, 'plans');
  let files = [];
  try {
    files = fs.readdirSync(plansDir).filter(f => f.endsWith('-frontier.md'));
  } catch (e) {
    return [];
  }
  const all = [];
  for (const f of files) {
    const text = _safeReadFile(path.join(plansDir, f));
    if (!text) continue;
    try {
      const tasks = parseFrontier(text);
      for (const t of tasks) {
        t.frontier_file = f;
        all.push(t);
      }
    } catch (e) { /* skip malformed */ }
  }
  return all;
}

function performForensicRecovery(forgeDir) {
  const report = {
    reconstructed: {
      committed_tasks: [],
      resume_point: null,
      active_checkpoints: [],
      orphan_worktrees: []
    },
    actions_taken: [],
    warnings: [],
    needs_human: false
  };

  forgeDir = forgeDir || '.forge';
  const projectRoot = path.dirname(path.resolve(forgeDir));

  // 1. Mark phase as recovering immediately so a parallel resume sees it.
  let stateBefore = null;
  try {
    stateBefore = readState(forgeDir);
  } catch (e) {
    report.warnings.push(`state_read_failed: ${e.code || e.message || 'unknown'}`);
  }
  const priorPhase = stateBefore && stateBefore.data ? (stateBefore.data.phase || 'unknown') : 'unknown';
  try {
    writeState(forgeDir, { phase: 'recovering', recovery_started_at: new Date().toISOString() });
    report.actions_taken.push('phase -> recovering');
  } catch (e) {
    report.warnings.push(`writeState_recovering_failed: ${e.code || e.message || 'unknown'}`);
  }

  // 2. Inspect lock file.
  let lockInfo = null;
  try {
    lockInfo = detectStaleLock(forgeDir);
  } catch (e) {
    report.warnings.push(`lock_inspect_failed: ${e.message || 'unknown'}`);
  }
  if (lockInfo) {
    if (lockInfo.is_stale) {
      report.warnings.push(`stale_lock pid=${lockInfo.pid} hb=${lockInfo.heartbeat || 'none'}`);
      // Try takeover. acquireLock handles stale takeover internally.
      try {
        const taken = acquireLock(forgeDir, lockInfo.task || '');
        if (taken && taken.acquired) {
          report.actions_taken.push(`stale lock taken over (was pid ${lockInfo.pid})`);
          // Update heartbeat immediately so subsequent code knows we own it.
          heartbeat(forgeDir);
        } else {
          report.warnings.push(`stale_lock_takeover_failed: ${taken && taken.reason}`);
          report.needs_human = true;
        }
      } catch (e) {
        report.warnings.push(`acquireLock_threw: ${e.message || 'unknown'}`);
        report.needs_human = true;
      }
    } else {
      report.warnings.push(`live_lock pid=${lockInfo.pid} -- another session may be running`);
      report.needs_human = true;
    }
  }

  // 3. Read state, token ledger.
  const ledger = _safeReadJson(path.join(forgeDir, 'token-ledger.json')) || {};
  const tokensUsed = (ledger && (ledger.total || ledger.session_used)) || 0;

  // 4. Active checkpoints.
  let checkpoints = [];
  try {
    checkpoints = listCheckpoints(forgeDir) || [];
  } catch (e) {
    report.warnings.push(`listCheckpoints_failed: ${e.message || 'unknown'}`);
  }
  // Active = not at terminal step.
  const activeCps = checkpoints.filter(cp => cp.current_step !== 'complete');
  report.reconstructed.active_checkpoints = activeCps.map(cp => ({
    task_id: cp.task_id,
    current_step: cp.current_step,
    next_step: cp.next_step,
    last_updated: cp.last_updated,
    worktree_path: cp.worktree_path || null
  }));

  // 5. Cross-reference git log for committed forge tasks.
  const recentCommits = _gitLogForgeCommits(projectRoot, 200);
  const committedTaskIds = new Set();
  for (const c of recentCommits) {
    for (const tid of c.task_ids) committedTaskIds.add(tid);
  }
  // Augment from task-status.json registry too.
  let registry = { tasks: {} };
  try { registry = readTaskRegistry(forgeDir); } catch (e) {}
  for (const [tid, info] of Object.entries(registry.tasks || {})) {
    if (info && info.status === 'complete') committedTaskIds.add(tid);
  }
  report.reconstructed.committed_tasks = Array.from(committedTaskIds).sort();

  // 6. Reconstruct frontier position.
  const frontierTasks = _collectAllFrontierTasks(forgeDir);
  const frontierIds = new Set(frontierTasks.map(t => t.id));
  let resumePoint = null;
  // Prefer the oldest active checkpoint whose task is not committed yet.
  const activeNonCommitted = activeCps
    .filter(cp => !committedTaskIds.has(cp.task_id))
    .sort((a, b) => (a.last_updated || '').localeCompare(b.last_updated || ''));
  if (activeNonCommitted.length > 0) {
    const cp = activeNonCommitted[0];
    resumePoint = {
      source: 'checkpoint',
      task_id: cp.task_id,
      step: cp.current_step,
      next_step: cp.next_step
    };
  } else {
    // Otherwise: first uncommitted task in DAG order (by tier then id).
    const sorted = frontierTasks.slice().sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.id.localeCompare(b.id);
    });
    const next = sorted.find(t => !committedTaskIds.has(t.id));
    if (next) {
      resumePoint = { source: 'frontier', task_id: next.id, step: 'pending', next_step: 'spec_loaded' };
    }
  }
  report.reconstructed.resume_point = resumePoint;

  // 7. Orphan worktree detection.
  let worktrees = [];
  try {
    worktrees = listTaskWorktrees(forgeDir, projectRoot) || [];
  } catch (e) {
    report.warnings.push(`listTaskWorktrees_failed: ${e.message || 'unknown'}`);
  }
  for (const wt of worktrees) {
    if (!wt.task_id) continue; // not a forge task worktree
    const inFrontier = frontierIds.has(wt.task_id);
    const alreadyCommitted = committedTaskIds.has(wt.task_id);
    if (!inFrontier || alreadyCommitted) {
      report.reconstructed.orphan_worktrees.push({
        task_id: wt.task_id,
        path: wt.path,
        branch: wt.branch,
        reason: !inFrontier ? 'not_in_frontier' : 'already_committed'
      });
    }
  }
  if (report.reconstructed.orphan_worktrees.length > 0) {
    report.warnings.push(`orphan_worktrees: ${report.reconstructed.orphan_worktrees.length} (manual cleanup required)`);
  }

  // 8. Handle budget_exhausted explicitly: read handoff doc.
  if (priorPhase === 'budget_exhausted') {
    const handoff = _safeReadFile(path.join(forgeDir, 'resume.md'));
    if (handoff) {
      report.actions_taken.push('budget_exhausted handoff read');
      report.budget_handoff = handoff;
    } else {
      report.warnings.push('budget_exhausted but no resume.md handoff found');
    }
    report.warnings.push('budget exhausted -> adjust .forge/config.json before continuing');
    report.needs_human = true;
  }

  // 9. Decide final phase.
  // If anything needs human attention, leave phase as needs_human; otherwise idle.
  const finalPhase = report.needs_human ? 'needs_human' : 'idle';
  try {
    const updates = {
      phase: finalPhase,
      recovery_completed_at: new Date().toISOString()
    };
    if (resumePoint) updates.current_task = resumePoint.task_id;
    writeState(forgeDir, updates);
    report.actions_taken.push(`phase -> ${finalPhase}`);
  } catch (e) {
    report.warnings.push(`writeState_final_failed: ${e.code || e.message || 'unknown'}`);
  }

  // 10. Append caveman-form notes to state.md content section (R013).
  try {
    const cur = readState(forgeDir);
    const ts = new Date().toISOString();
    const notes = [];
    notes.push('');
    notes.push(`## forensic recovery -- ${ts}`);
    notes.push(`prior phase -> ${priorPhase}`);
    notes.push(`tokens used -> ${tokensUsed}`);
    notes.push(`committed tasks -> ${report.reconstructed.committed_tasks.length}`);
    notes.push(`active checkpoints -> ${report.reconstructed.active_checkpoints.length}`);
    notes.push(`orphan worktrees -> ${report.reconstructed.orphan_worktrees.length}`);
    if (resumePoint) {
      notes.push(`resume point -> ${resumePoint.task_id} (${resumePoint.source}, step ${resumePoint.step})`);
    } else {
      notes.push('resume point -> none (all done?)');
    }
    for (const a of report.actions_taken) notes.push(`action -> ${a}`);
    for (const w of report.warnings) notes.push(`warn -> ${w}`);
    if (report.reconstructed.orphan_worktrees.length > 0) {
      notes.push('orphans:');
      for (const o of report.reconstructed.orphan_worktrees) {
        notes.push(`  ${o.task_id} at ${o.path} (${o.reason})`);
      }
      notes.push('cleanup -> run `git worktree remove <path>` after review. no auto delete.');
    }
    notes.push('');
    const newContent = (cur.content || '') + notes.join('\n');
    writeState(forgeDir, cur.data, newContent);
  } catch (e) {
    report.warnings.push(`notes_append_failed: ${e.message || 'unknown'}`);
  }

  return report;
}

function _formatRecoveryReport(report) {
  const lines = [];
  lines.push('=== Forge Forensic Recovery Report ===');
  lines.push('');
  const r = report.reconstructed;
  lines.push(`Committed tasks:     ${r.committed_tasks.length}`);
  if (r.committed_tasks.length > 0) {
    lines.push(`  ${r.committed_tasks.join(', ')}`);
  }
  lines.push(`Active checkpoints:  ${r.active_checkpoints.length}`);
  for (const cp of r.active_checkpoints) {
    lines.push(`  ${cp.task_id} step=${cp.current_step} next=${cp.next_step} updated=${cp.last_updated}`);
  }
  lines.push(`Orphan worktrees:    ${r.orphan_worktrees.length}`);
  for (const o of r.orphan_worktrees) {
    lines.push(`  ${o.task_id} path=${o.path} reason=${o.reason}`);
  }
  lines.push('');
  if (r.resume_point) {
    lines.push(`Resume point: ${r.resume_point.task_id} (source=${r.resume_point.source}, step=${r.resume_point.step})`);
  } else {
    lines.push('Resume point: none (no uncommitted tasks found)');
  }
  lines.push('');
  lines.push(`Actions taken (${report.actions_taken.length}):`);
  for (const a of report.actions_taken) lines.push(`  - ${a}`);
  lines.push('');
  lines.push(`Warnings (${report.warnings.length}):`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  lines.push('');
  lines.push(`Needs human: ${report.needs_human ? 'YES' : 'no'}`);
  if (report.budget_handoff) {
    lines.push('');
    lines.push('--- budget handoff (resume.md) ---');
    lines.push(report.budget_handoff);
  }
  return lines.join('\n');
}

// === CLI Entry Point ===

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'route') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const iteration = parseInt(args.find((a, i) => args[i - 1] === '--iteration') || '1', 10);
    const transcript = args.find((a, i) => args[i - 1] === '--transcript') || '';

    const prompt = routeDecision(forgeDir, iteration, transcript);
    if (prompt && typeof prompt === 'object' && prompt.action === 'exit') {
      // Budget gating signalled an exit. Empty stdout -> stop hook stops loop.
      // Reason goes to stderr so the wrapper script can surface it.
      process.stderr.write(`forge: exit (${prompt.reason || 'unknown'})\n`);
    } else if (prompt) {
      process.stdout.write(prompt);
    }
  }

  if (command === 'discover') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const caps = discoverCapabilities(path.dirname(forgeDir));
    fs.writeFileSync(path.join(forgeDir, 'capabilities.json'), JSON.stringify(caps, null, 2));
    process.stdout.write(JSON.stringify(caps, null, 2));
  }

  // === Spec approval validation ===
  // Prevents /forge execute from running without approved specs and valid frontiers.
  if (command === 'validate-workflow') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const errors = validateWorkflowPrerequisites(forgeDir);
    if (errors.length > 0) {
      process.stderr.write(JSON.stringify({ valid: false, errors }));
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ valid: true }));
  }

  if (command === 'setup-state') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const spec = args.find((a, i) => args[i - 1] === '--spec') || '';
    const autonomy = args.find((a, i) => args[i - 1] === '--autonomy') || 'gated';
    const depth = args.find((a, i) => args[i - 1] === '--depth') || 'standard';
    const maxIter = args.find((a, i) => args[i - 1] === '--max-iterations') || '100';
    const budget = args.find((a, i) => args[i - 1] === '--token-budget') || '500000';
    const promise = args.find((a, i) => args[i - 1] === '--completion-promise') || 'FORGE_COMPLETE';

    // === WORKFLOW GATE: Validate specs are approved and frontiers exist ===
    const workflowErrors = validateWorkflowPrerequisites(forgeDir);
    if (workflowErrors.length > 0) {
      process.stderr.write('\nForge workflow validation failed:\n');
      for (const err of workflowErrors) {
        process.stderr.write('  - ' + err + '\n');
      }
      process.stderr.write('\nRun /forge brainstorm first, then /forge plan, then /forge execute.\n');
      process.exit(1);
    }

    // Create loop state
    const loopState = {
      active: true,
      iteration: 1,
      session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
      max_iterations: parseInt(maxIter, 10),
      completion_promise: promise,
      started_at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(forgeDir, '.forge-loop.json'), JSON.stringify(loopState, null, 2));

    // Update state
    const state = readState(forgeDir);
    state.data.phase = 'executing';
    state.data.spec = spec;
    state.data.autonomy = autonomy;
    state.data.depth = depth;
    state.data.tokens_budget = parseInt(budget, 10);
    state.data.iteration = 0;
    state.data.tokens_used = 0;
    state.data.review_iterations = 0;
    state.data.debug_attempts = 0;
    writeState(forgeDir, state.data, state.content);

    // Fix #4: Initialize task registry from all frontier files
    try {
      const plans = fs.readdirSync(path.join(forgeDir, 'plans')).filter(f => f.endsWith('-frontier.md'));
      const allTasks = [];
      for (const plan of plans) {
        const text = fs.readFileSync(path.join(forgeDir, 'plans', plan), 'utf8');
        allTasks.push(...parseFrontier(text));
      }
      initTaskRegistry(forgeDir, allTasks);
    } catch (e) { /* no plans yet */ }

    // Clear progress history for fresh start
    try { fs.unlinkSync(path.join(forgeDir, '.progress-history.json')); } catch (e) {}

    process.stdout.write('Loop state initialized');
  }

  // Fix #9: CLI command to generate summary on demand
  if (command === 'summary') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const summaryPath = generateSummary(forgeDir);
    process.stdout.write(`Summary written to ${summaryPath}`);
  }

  // T012/R001: record per-task token consumption from PostToolUse hook,
  // then immediately check the resulting budget percentage. Performs the
  // 80% warning gate and 100% circuit breaker in a single node invocation
  // so the bash hook only spawns node once per tool call.
  //
  // Usage:
  //   forge-tools record-task-tokens <task-id> <tokens> [--forge-dir .forge]
  //
  // Output (stdout, single line, machine-parseable):
  //   pct=<float> used=<int> budget=<int> warn=<0|1> escalated=<0|1>
  //
  // Side effects:
  //   - Increments task counter in token ledger
  //   - At >=100% writes task_status=budget_exhausted +
  //     blocked_reason=per_task_budget_hit into state.md frontmatter
  if (command === 'record-task-tokens') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    // Positional args after subcommand: <task-id> <tokens>
    const positional = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--forge-dir') { i++; continue; }
      if (a.startsWith('--')) continue;
      positional.push(a);
    }
    const taskId = positional[0];
    const tokens = Number(positional[1]) || 0;
    if (!taskId) {
      process.stdout.write('pct=0 used=0 budget=0 warn=0 escalated=0\n');
      return;
    }
    try {
      recordTaskTokens(taskId, tokens, forgeDir);
      const status = checkTaskBudget(taskId, forgeDir);
      const pct = status.percentage || 0;
      const warn = (pct >= 80 && pct < 100) ? 1 : 0;
      let escalated = 0;
      if (pct >= 100) {
        escalated = 1;
        try {
          writeState(forgeDir, {
            task_status: 'budget_exhausted',
            blocked_reason: 'per_task_budget_hit'
          });
        } catch (e) { /* state.md may be locked; the warning still fires */ }
      }
      process.stdout.write(
        `pct=${pct} used=${status.used} budget=${status.budget} warn=${warn} escalated=${escalated}\n`
      );
    } catch (e) {
      // Fall back gracefully so the hook never breaks the user's session.
      process.stdout.write('pct=0 used=0 budget=0 warn=0 escalated=0\n');
    }
    return;
  }

  // R001: report per-task token budgets. Optionally scope to a single task
  // and emit machine-parseable JSON when --json is passed.
  if (command === 'budget-status') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const taskArg = args.find((a, i) => args[i - 1] === '--task');
    // Positional task id: first non-flag arg after the subcommand.
    let positional = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) { i++; continue; }
      if (args[i - 1] && args[i - 1].startsWith('--')) continue;
      positional = a;
      break;
    }
    const taskId = taskArg || positional || null;
    const json = args.includes('--json');
    const report = budgetStatusReport(forgeDir, taskId);
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      const lines = [];
      const pad = (s, n) => String(s).padEnd(n);
      const lpad = (s, n) => String(s).padStart(n);
      if (report.tasks.length === 0) {
        lines.push('No tasks recorded in token ledger.');
      } else {
        lines.push('task        used / budget       remaining   pct');
        lines.push('----        -------------       ---------   ---');
        for (const t of report.tasks) {
          lines.push(
            pad(t.task_id, 12) +
            lpad(t.used, 6) + ' / ' + lpad(t.budget, 6) +
            '       ' + lpad(t.remaining, 7) +
            '   ' + lpad(t.percentage + '%', 6) +
            (t.registered === false ? '  (unregistered)' : '')
          );
        }
        if (report.totals) {
          lines.push('');
          lines.push('PER-TASK TOTAL: ' + report.totals.used + ' / ' + report.totals.budget +
            ' (' + report.totals.percentage + '%, ' + report.totals.remaining + ' remaining)');
        }
      }
      if (report.session) {
        const s = report.session;
        lines.push('');
        lines.push('Session budget: ' + s.session_used + ' / ' + s.session_budget_tokens +
          ' (' + s.session_percentage + '%, ' + s.session_remaining + ' remaining)');
        lines.push('Iterations:     ' + s.iteration + ' / ' + s.max_iterations);
      }
      process.stdout.write(lines.join('\n') + '\n');
    }
  }

  // T011: headless dispatcher (execute / query / status)
  if (command === 'headless') {
    const code = runHeadless(args);
    process.exit(code);
  }

  // T020 (R007/R008): forensic recovery from crashed/interrupted sessions.
  if (command === 'forensic-recover') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const json = args.includes('--json');
    let report;
    try {
      report = performForensicRecovery(forgeDir);
    } catch (e) {
      // Should never happen (function never throws), but be defensive.
      report = {
        reconstructed: { committed_tasks: [], resume_point: null, active_checkpoints: [], orphan_worktrees: [] },
        actions_taken: [],
        warnings: [`recovery_threw: ${e.message || 'unknown'}`],
        needs_human: true
      };
    }
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(_formatRecoveryReport(report) + '\n');
    }
    process.exit(report.needs_human ? 2 : 0);
  }

  // T021/R004: squash-merge a task's worktree into the parent branch.
  if (command === 'complete-task-worktree') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const projectRoot = args.find((a, i) => args[i - 1] === '--project-root') || path.dirname(forgeDir);
    // Positional task id: first non-flag arg after the subcommand.
    let taskId = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--forge-dir' || a === '--project-root') { i++; continue; }
      if (a.startsWith('--')) continue;
      taskId = a;
      break;
    }
    if (!taskId) {
      process.stdout.write(JSON.stringify({ merged: false, reason: 'missing_task_id' }) + '\n');
      process.exit(1);
    }
    const result = completeTaskInWorktree(forgeDir, taskId, projectRoot);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.merged || result.reason === 'no_worktree' || result.reason === 'no_new_commits' ? 0 : 1);
  }

  // T021/R004: discard a task's worktree without merging anything.
  if (command === 'abort-task-worktree') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const projectRoot = args.find((a, i) => args[i - 1] === '--project-root') || path.dirname(forgeDir);
    let taskId = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--forge-dir' || a === '--project-root') { i++; continue; }
      if (a.startsWith('--')) continue;
      taskId = a;
      break;
    }
    if (!taskId) {
      process.stdout.write(JSON.stringify({ aborted: false, reason: 'missing_task_id' }) + '\n');
      process.exit(1);
    }
    const result = abortTaskInWorktree(forgeDir, taskId, projectRoot);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.aborted || result.reason === 'no_worktree' ? 0 : 1);
  }

  // Fix #4: CLI command to mark a task complete programmatically
  if (command === 'mark-complete') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const taskId = args.find((a, i) => args[i - 1] === '--task') || '';
    const commit = args.find((a, i) => args[i - 1] === '--commit') || '';
    if (taskId) {
      markTaskComplete(forgeDir, taskId, commit || null);
      process.stdout.write(`Task ${taskId} marked complete`);
    }
  }
}

module.exports = {
  parseFrontmatter, serializeFrontmatter,
  loadConfig, DEFAULT_CONFIG, deepMerge, getConfig,
  estimateTokensFromTranscript, readState, writeState, formatCavemanValue,
  acquireLock, releaseLock, heartbeat, detectStaleLock, readLock,
  updateTokenLedger, parseFrontier,
  detectFileConflicts, serializeConflictingTasks, logConflictEvent, planTierExecution,
  readLedger, writeLedgerAtomic, resolveTaskBudget,
  registerTask, recordTaskTokens, checkTaskBudget,
  getTaskBudgetRemaining, budgetStatusReport,
  discoverCapabilities, generateResumePrompt, generateSummary, inferMcpUse,
  routeDecision, checkSessionBudget, writeBudgetExhaustedHandoff,
  findNextUnblockedTask, findAllUnblockedTasks,
  getReadyTasks, hasFileOverlap, shouldReplan,
  shouldRunCodexReview, shouldRunCodexRescue,
  buildCodexReviewPrompt, buildCodexRescuePrompt,
  writeArtifact, readArtifact, buildArtifactSummary,
  createTaskWorktree, removeTaskWorktree, listTaskWorktrees,
  completeTaskInWorktree, abortTaskInWorktree,
  writeCheckpoint, readCheckpoint, deleteCheckpoint, listCheckpoints, updateCheckpoint,
  buildContextBundle, cleanupContextBundle,
  buildTaskPrompt, advanceToNextTask,
  readTaskRegistry, writeTaskRegistry, markTaskComplete, initTaskRegistry,
  getProgressSnapshot, checkProgress, getNoProgressCount,
  verifyStateConsistency,
  runHeadless, queryHeadlessState, HEADLESS_EXIT, HEADLESS_STATUS_SCHEMA_VERSION,
  performForensicRecovery,
  validateWorkflowPrerequisites
};
