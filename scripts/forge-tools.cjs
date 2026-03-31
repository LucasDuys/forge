const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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

function readState(forgeDir) {
  const statePath = path.join(forgeDir, 'state.md');
  try {
    return parseFrontmatter(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { data: {}, content: '' };
  }
}

function writeState(forgeDir, data, content) {
  const statePath = path.join(forgeDir, 'state.md');
  fs.writeFileSync(statePath, serializeFrontmatter(data, content));
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
        status: 'pending'
      });
    }
  }
  return tasks;
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

function routeDecision(forgeDir, iteration, transcriptPath) {
  const config = loadConfig(path.dirname(forgeDir));
  let state = readState(forgeDir);
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
    markTaskComplete(forgeDir, currentTask, null);

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

// === CLI Entry Point ===

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'route') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const iteration = parseInt(args.find((a, i) => args[i - 1] === '--iteration') || '1', 10);
    const transcript = args.find((a, i) => args[i - 1] === '--transcript') || '';

    const prompt = routeDecision(forgeDir, iteration, transcript);
    if (prompt) process.stdout.write(prompt);
  }

  if (command === 'discover') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const caps = discoverCapabilities(path.dirname(forgeDir));
    fs.writeFileSync(path.join(forgeDir, 'capabilities.json'), JSON.stringify(caps, null, 2));
    process.stdout.write(JSON.stringify(caps, null, 2));
  }

  if (command === 'setup-state') {
    const forgeDir = args.find((a, i) => args[i - 1] === '--forge-dir') || '.forge';
    const spec = args.find((a, i) => args[i - 1] === '--spec') || '';
    const autonomy = args.find((a, i) => args[i - 1] === '--autonomy') || 'gated';
    const depth = args.find((a, i) => args[i - 1] === '--depth') || 'standard';
    const maxIter = args.find((a, i) => args[i - 1] === '--max-iterations') || '100';
    const budget = args.find((a, i) => args[i - 1] === '--token-budget') || '500000';
    const promise = args.find((a, i) => args[i - 1] === '--completion-promise') || 'FORGE_COMPLETE';

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
  loadConfig, DEFAULT_CONFIG, deepMerge,
  estimateTokensFromTranscript, readState, writeState,
  updateTokenLedger, parseFrontier,
  discoverCapabilities, generateResumePrompt, generateSummary, inferMcpUse,
  routeDecision, findNextUnblockedTask, findAllUnblockedTasks,
  getReadyTasks, hasFileOverlap, shouldReplan,
  shouldRunCodexReview, shouldRunCodexRescue,
  buildCodexReviewPrompt, buildCodexRescuePrompt,
  writeArtifact, readArtifact, buildArtifactSummary,
  buildContextBundle, cleanupContextBundle,
  buildTaskPrompt, advanceToNextTask,
  readTaskRegistry, writeTaskRegistry, markTaskComplete, initTaskRegistry,
  getProgressSnapshot, checkProgress, getNoProgressCount,
  verifyStateConsistency
};
