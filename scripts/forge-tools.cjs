const fs = require('fs');
const path = require('path');

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
  capability_hints: {}
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

// === Token Estimation ===

function estimateTokensFromTranscript(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    // ~4 chars per token heuristic
    return Math.ceil(content.length / 4);
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

function updateTokenLedger(forgeDir, iterationTokens) {
  const ledgerPath = path.join(forgeDir, 'token-ledger.json');
  let ledger = { total: 0, iterations: 0, per_spec: {} };
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (e) { /* new ledger */ }
  ledger.total += iterationTokens;
  ledger.iterations += 1;
  ledger.avg_per_iteration = Math.round(ledger.total / ledger.iterations);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return ledger;
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

    const taskMatch = line.match(/^- \[([A-Z]\d+)\]\s+(.+)/);
    if (taskMatch) {
      const id = taskMatch[1];
      const rest = taskMatch[2];

      const repoMatch = rest.match(/repo:\s*(\S+)/);
      const dependsMatch = rest.match(/depends:\s*([A-Z0-9,\s]+?)(?:\s*\||$)/);
      const estMatch = rest.match(/est:\s*~?(\d+)k/);
      const name = rest.split('|')[0].trim();

      tasks.push({
        id,
        name,
        tier: currentTier,
        repo: repoMatch ? repoMatch[1] : null,
        depends: dependsMatch ? dependsMatch[1].split(',').map(s => s.trim()) : [],
        estimated_tokens: estMatch ? parseInt(estMatch[1], 10) * 1000 : 0,
        status: 'pending'
      });
    }
  }
  return tasks;
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

// === CLI: Route Command (called by stop-hook.sh) ===

function routeDecision(forgeDir, iteration, transcriptPath) {
  const config = loadConfig(path.dirname(forgeDir));
  const state = readState(forgeDir);
  const phase = state.data.phase || 'idle';
  const taskStatus = state.data.task_status || null;
  const currentTask = state.data.current_task || null;
  const autonomy = state.data.autonomy || config.autonomy;
  const depth = state.data.depth || config.depth;

  // Token budget check (delta-based to avoid double-counting)
  if (transcriptPath) {
    const totalTranscriptTokens = estimateTokensFromTranscript(transcriptPath);
    const ledgerPath = path.join(forgeDir, 'token-ledger.json');
    let ledger = { total: 0, iterations: 0, per_spec: {}, last_transcript_tokens: 0 };
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) {}
    const prevTokens = ledger.last_transcript_tokens || 0;
    const iterationDelta = Math.max(0, totalTranscriptTokens - prevTokens);
    ledger.last_transcript_tokens = totalTranscriptTokens;
    const updated = updateTokenLedger(forgeDir, iterationDelta);
    // Restore the last_transcript_tokens field (updateTokenLedger may not preserve it)
    updated.last_transcript_tokens = totalTranscriptTokens;
    fs.writeFileSync(ledgerPath, JSON.stringify(updated, null, 2));

    const budget = state.data.tokens_budget || config.token_budget;
    const usage = updated.total / budget;

    if (usage >= 1.0) {
      return ''; // Budget exhausted — allow exit
    }
    if (usage >= 0.7) {
      // Spec says 70-90% -> downgrade to quick
      state.data.depth = 'quick';
      writeState(forgeDir, state.data, state.content);
    }
  }

  // Context window check (transcript size proxy)
  if (transcriptPath) {
    try {
      const stats = fs.statSync(transcriptPath);
      const estimatedContextPercent = (stats.size / 4 / 200000) * 100;
      if (estimatedContextPercent >= (config.context_reset_threshold || 60)) {
        if (state.data.handoff_requested) {
          // Second time — generate resume prompt and allow exit
          const prompt = generateResumePrompt(state.data, path.dirname(forgeDir));
          const resumePath = path.join(forgeDir, '.forge-resume.md');
          fs.writeFileSync(resumePath, prompt);
          return ''; // Allow exit
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
    const resumePath = path.join(forgeDir, '.forge-resume.md');
    fs.writeFileSync(resumePath, prompt);
    return ''; // Allow exit for context reset
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
        const nextTask = findNextUnblockedTask(tasks, state);
        if (!nextTask) {
          // All tasks done — move to verification
          state.data.phase = 'verifying';
          writeState(forgeDir, state.data, state.content);
          return `All tasks complete for spec "${currentSpec}". Verify that all spec requirements are met. Read .forge/specs/spec-${currentSpec}.md and check every acceptance criterion. Report PASSED or GAPS_FOUND.`;
        }
        state.data.current_task = nextTask.id;
        state.data.task_status = 'pending';
        writeState(forgeDir, state.data, state.content);
        return buildTaskPrompt(nextTask, forgeDir, depth);
      }

      if (!taskStatus || taskStatus === 'pending') {
        return buildTaskPrompt(task || tasks[0], forgeDir, depth);
      }

      if (taskStatus === 'implementing') {
        return `Task ${currentTask} implemented. Now run the tests. If any fail, fix them. Report the test results.`;
      }

      if (taskStatus === 'testing') {
        // Check if we should review
        if (depth !== 'quick') {
          state.data.task_status = 'reviewing';
          writeState(forgeDir, state.data, state.content);
          return `Tests passing for ${currentTask}. Review the implementation against the spec. Check for: missing acceptance criteria, over-engineering, edge cases, security issues. Report PASS or ISSUES with file:line references.`;
        }
        // Quick mode — skip review, commit and advance
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (taskStatus === 'reviewing') {
        return advanceToNextTask(tasks, state, forgeDir, currentSpec);
      }

      if (taskStatus === 'fixing') {
        return `Fix the issues identified in review for ${currentTask}, then re-run tests to confirm they still pass.`;
      }

      if (taskStatus === 'debugging') {
        const debugAttempts = state.data.debug_attempts || 0;
        if (debugAttempts >= config.loop.circuit_breaker_debug_attempts) {
          state.data.task_status = 'blocked';
          writeState(forgeDir, state.data, state.content);
          return ''; // Allow exit — needs human
        }
        state.data.debug_attempts = debugAttempts + 1;
        writeState(forgeDir, state.data, state.content);
        return `Debug attempt ${debugAttempts + 1} for ${currentTask}. Investigate the root cause systematically: 1) Read error messages carefully, 2) Find a working example of similar code, 3) Form a hypothesis, 4) Test it minimally. Do NOT guess — investigate first.`;
      }

      // Default: try to advance
      return advanceToNextTask(tasks, state, forgeDir, currentSpec);
    }

    case 'verifying': {
      // Autonomy mode: gated pauses between specs/phases
      const autonomy = state.data.autonomy || config.autonomy;
      if (autonomy === 'gated' || autonomy === 'supervised') {
        // Allow exit between phases — user must /forge resume
        return '';
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
        const domain = nextSpec.replace('spec-', '').replace('.md', '');
        state.data.spec = domain;
        state.data.phase = 'executing';
        state.data.current_task = null;
        state.data.task_status = 'pending';
        writeState(forgeDir, state.data, state.content);
        return `Phase verified. Moving to next spec: ${domain}. Read .forge/specs/${nextSpec} and .forge/plans/${domain}-frontier.md, then start implementing the first task.`;
      }

      // All specs done!
      return ''; // Allow exit — loop complete
    }

    default:
      return '';
  }
}

function findNextUnblockedTask(tasks, state) {
  const doneContent = state.content || '';
  const doneTasks = new Set();
  for (const line of doneContent.split('\n')) {
    const match = line.match(/^- (T\d+):/);
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

  let prompt = `Implement task ${task.id}: ${task.name}\n\n${specInfo}\n\n`;

  if (task.repo) prompt += `This task targets the "${task.repo}" repo.\n`;

  if (depth === 'thorough') {
    prompt += `Use TDD: write failing test first, then implement, then verify tests pass.\n`;
  } else if (depth === 'standard') {
    prompt += `Implement the feature and write tests. Commit when tests pass.\n`;
  } else {
    prompt += `Implement the feature. Run existing tests if available. Commit.\n`;
  }

  prompt += `\nAfter completing, update .forge/state.md: set task_status to "testing" and describe what you implemented under "In-Flight Work".`;

  return prompt;
}

function advanceToNextTask(tasks, state, forgeDir, currentSpec) {
  const config = loadConfig(path.dirname(forgeDir));
  const autonomy = state.data.autonomy || config.autonomy;
  const nextTask = findNextUnblockedTask(tasks, state);

  // Mark current task as done in state content
  const currentTask = state.data.current_task;
  if (currentTask) {
    const doneEntry = `- ${currentTask}: complete`;
    if (!state.content.includes(currentTask)) {
      state.content = state.content.replace('## What\'s Done', `## What's Done\n${doneEntry}`);
    }
  }

  if (!nextTask) {
    state.data.phase = 'verifying';
    state.data.current_task = null;
    state.data.task_status = null;
    writeState(forgeDir, state.data, state.content);
    return `All tasks complete. Commit your work, then verify all spec requirements are met. Read .forge/specs/ and check every acceptance criterion. Report PASSED or GAPS_FOUND.`;
  }

  // Autonomy mode: supervised pauses between every task
  if (autonomy === 'supervised') {
    state.data.current_task = nextTask.id;
    state.data.task_status = 'pending';
    writeState(forgeDir, state.data, state.content);
    return ''; // Allow exit — user must /forge resume
  }

  state.data.current_task = nextTask.id;
  state.data.task_status = 'pending';
  state.data.debug_attempts = 0;
  writeState(forgeDir, state.data, state.content);
  return buildTaskPrompt(nextTask, forgeDir, state.data.depth || 'standard');
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
    writeState(forgeDir, state.data, state.content);

    process.stdout.write('Loop state initialized');
  }
}

module.exports = {
  parseFrontmatter, serializeFrontmatter,
  loadConfig, DEFAULT_CONFIG, deepMerge,
  estimateTokensFromTranscript, readState, writeState,
  updateTokenLedger, parseFrontier,
  discoverCapabilities, generateResumePrompt, inferMcpUse,
  routeDecision, findNextUnblockedTask, buildTaskPrompt, advanceToNextTask
};
