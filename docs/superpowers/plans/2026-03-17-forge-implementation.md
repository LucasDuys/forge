# Forge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Forge Claude Code plugin — autonomous spec-driven development with smart loop, context management, token budgeting, and backpropagation.

**Architecture:** Claude Code plugin with commands (markdown), skills (markdown), agents (markdown), hooks (bash + JS), and one JS utility (forge-tools.cjs). All state persists in `.forge/` per-project. The Stop hook drives the autonomous loop via a state machine that reads state files and constructs targeted prompts.

**Tech Stack:** Bash (hooks), Node.js CommonJS (forge-tools.cjs), Markdown (commands/skills/agents/templates/references)

**Spec:** `docs/superpowers/specs/2026-03-17-forge-design.md`

---

## File Structure Map

### Plugin Manifest (already exists)
| File | Responsibility |
|------|---------------|
| `.claude-plugin/plugin.json` | Plugin manifest — name, version, author, entry points. **Already created.** Verify it matches spec before shipping. |

### Scripts (the "real code")
| File | Responsibility |
|------|---------------|
| `scripts/forge-tools.cjs` | State management, config loading/defaults, YAML frontmatter parsing, token estimation from transcript, capability discovery, complexity scoring, frontier parsing, resume prompt generation |
| `scripts/setup.sh` | Initialize `.forge/` directory structure with default config |

### Hooks (the loop engine)
| File | Responsibility |
|------|---------------|
| `hooks/hooks.json` | Register Stop hook and PostToolUse hook with Claude Code |
| `hooks/stop-hook.sh` | Core state machine — read state, route to next action, block or allow exit |
| `hooks/token-monitor.sh` | PostToolUse hook — lightweight iteration counter update |

### Commands (user interface)
| File | Responsibility |
|------|---------------|
| `commands/help.md` | Display usage guide for all commands |
| `commands/status.md` | Show current progress, budget, capabilities |
| `commands/brainstorm.md` | Entry point for spec generation |
| `commands/plan.md` | Entry point for frontier generation |
| `commands/execute.md` | Entry point for autonomous loop |
| `commands/resume.md` | Continue after interruption |
| `commands/backprop.md` | Bug-to-spec tracing |

### Skills (procedural workflows)
| File | Responsibility |
|------|---------------|
| `skills/brainstorming/SKILL.md` | Interactive Q&A → spec generation workflow |
| `skills/planning/SKILL.md` | Spec → frontier decomposition workflow |
| `skills/executing/SKILL.md` | Task implementation + inner loop workflow |
| `skills/reviewing/SKILL.md` | Claude-on-Claude review protocol |
| `skills/backpropagation/SKILL.md` | Bug → spec trace → regression test workflow |

### Agents (subagent definitions)
| File | Responsibility |
|------|---------------|
| `agents/forge-speccer.md` | Writes specs with R-numbered requirements |
| `agents/forge-planner.md` | Decomposes specs into tiered task frontiers |
| `agents/forge-executor.md` | Implements individual tasks (TDD) |
| `agents/forge-reviewer.md` | Reviews code against spec + quality |
| `agents/forge-verifier.md` | Goal-backward phase verification |
| `agents/forge-complexity.md` | Analyzes task, recommends depth level |

### Templates (output file formats)
| File | Responsibility |
|------|---------------|
| `templates/spec.md` | Spec file template with YAML frontmatter |
| `templates/plan.md` | Frontier file template with tier structure |
| `templates/state.md` | State file template with handoff sections |
| `templates/summary.md` | Execution summary template |
| `templates/backprop-report.md` | Backpropagation trace template |
| `templates/config.json` | Default config with all options documented |
| `templates/resume.md` | Resume prompt template |

### References (knowledge base)
| File | Responsibility |
|------|---------------|
| `references/token-profiles.md` | Token budgets per depth level |
| `references/complexity-heuristics.md` | How auto-detection scores tasks |
| `references/review-protocol.md` | Claude-on-Claude review standards |
| `references/multi-repo.md` | Cross-repo coordination rules |
| `references/backprop-patterns.md` | How to trace bugs to spec gaps |

---

## Task 1: Core Utility — forge-tools.cjs

**Files:**
- Create: `scripts/forge-tools.cjs`
- Create: `tests/forge-tools.test.cjs`

This is the only file with real logic. Everything else calls into it.

- [ ] **Step 1: Write tests for YAML frontmatter parser**

```javascript
// tests/forge-tools.test.cjs
const assert = require('assert');
const { parseFrontmatter, serializeFrontmatter } = require('../scripts/forge-tools.cjs');

// Test: parse YAML frontmatter from markdown
{
  const input = `---
phase: executing
spec: auth
current_task: T003
task_status: testing
iteration: 12
---

## What's Done
- T001: complete`;

  const result = parseFrontmatter(input);
  assert.strictEqual(result.data.phase, 'executing');
  assert.strictEqual(result.data.current_task, 'T003');
  assert.strictEqual(result.data.iteration, 12);
  assert(result.content.includes("## What's Done"));
  console.log('PASS: parseFrontmatter');
}

// Test: serialize frontmatter back to markdown
{
  const data = { phase: 'executing', spec: 'auth', iteration: 5 };
  const content = '## What\'s Done\n- Task 1 complete';
  const result = serializeFrontmatter(data, content);
  assert(result.startsWith('---\n'));
  assert(result.includes('phase: executing'));
  assert(result.includes('## What\'s Done'));
  console.log('PASS: serializeFrontmatter');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/forge-tools.test.cjs`
Expected: FAIL with "Cannot find module '../scripts/forge-tools.cjs'"

- [ ] **Step 3: Implement frontmatter parser**

```javascript
// scripts/forge-tools.cjs

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

module.exports = { parseFrontmatter, serializeFrontmatter };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/forge-tools.test.cjs`
Expected: PASS for both tests

- [ ] **Step 5: Write tests for config loading**

Append to `tests/forge-tools.test.cjs`:
```javascript
const { loadConfig, DEFAULT_CONFIG } = require('../scripts/forge-tools.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Test: loadConfig returns defaults when no file exists
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const config = loadConfig(tmpDir);
  assert.strictEqual(config.autonomy, 'gated');
  assert.strictEqual(config.depth, 'standard');
  assert.strictEqual(config.token_budget, 500000);
  assert.strictEqual(config.context_reset_threshold, 60);
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: loadConfig defaults');
}

// Test: loadConfig merges user config with defaults
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({
    autonomy: 'full',
    token_budget: 100000
  }));
  const config = loadConfig(tmpDir);
  assert.strictEqual(config.autonomy, 'full');
  assert.strictEqual(config.token_budget, 100000);
  assert.strictEqual(config.depth, 'standard'); // default preserved
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: loadConfig merge');
}
```

- [ ] **Step 6: Run to verify fail, then implement config loading**

Add to `scripts/forge-tools.cjs`:
```javascript
const fs = require('fs');
const path = require('path');

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

module.exports = { parseFrontmatter, serializeFrontmatter, loadConfig, DEFAULT_CONFIG, deepMerge };
```

- [ ] **Step 7: Run all tests**

Run: `node tests/forge-tools.test.cjs`
Expected: All PASS

- [ ] **Step 8: Write tests for token estimation + state management**

Append to `tests/forge-tools.test.cjs`:
```javascript
const { estimateTokensFromTranscript, readState, writeState, updateTokenLedger, parseFrontier } = require('../scripts/forge-tools.cjs');

// Test: estimate tokens from JSONL transcript
{
  const tmpFile = path.join(os.tmpdir(), 'transcript-test.jsonl');
  const lines = [
    JSON.stringify({ role: 'user', content: 'Hello world' }),
    JSON.stringify({ role: 'assistant', content: 'Hi there, how can I help you today?' }),
    JSON.stringify({ role: 'user', content: 'Build me a REST API' }),
  ];
  fs.writeFileSync(tmpFile, lines.join('\n'));
  const tokens = estimateTokensFromTranscript(tmpFile);
  assert(tokens > 0, 'should estimate positive tokens');
  assert(tokens < 1000, 'should be reasonable estimate for small transcript');
  fs.unlinkSync(tmpFile);
  console.log('PASS: estimateTokensFromTranscript');
}

// Test: readState / writeState roundtrip
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });

  const stateData = { phase: 'executing', spec: 'auth', current_task: 'T003', iteration: 5 };
  const stateContent = '## What\'s Done\n- T001 complete';
  writeState(forgeDir, stateData, stateContent);

  const state = readState(forgeDir);
  assert.strictEqual(state.data.phase, 'executing');
  assert.strictEqual(state.data.current_task, 'T003');
  assert(state.content.includes('T001 complete'));
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: readState/writeState roundtrip');
}

// Test: parseFrontier extracts tasks with tiers and dependencies
{
  const frontier = `---
spec: auth
total_tasks: 4
---

# Auth Frontier

## Tier 1 (parallel)
- [T001] User model | est: ~4k tokens | repo: api
- [T002] Auth controller | est: ~3k tokens | repo: api

## Tier 2 (depends on T001, T002)
- [T003] Registration | est: ~6k tokens | repo: api | depends: T001, T002
- [T004] Login | est: ~6k tokens | repo: api | depends: T001, T002`;

  const tasks = parseFrontier(frontier);
  assert.strictEqual(tasks.length, 4);
  assert.strictEqual(tasks[0].id, 'T001');
  assert.strictEqual(tasks[0].tier, 1);
  assert.strictEqual(tasks[0].repo, 'api');
  assert.deepStrictEqual(tasks[0].depends, []);
  assert.strictEqual(tasks[2].id, 'T003');
  assert.deepStrictEqual(tasks[2].depends, ['T001', 'T002']);
  console.log('PASS: parseFrontier');
}
```

- [ ] **Step 9: Implement token estimation, state management, frontier parsing**

Add to `scripts/forge-tools.cjs`:
```javascript
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

module.exports = {
  parseFrontmatter, serializeFrontmatter,
  loadConfig, DEFAULT_CONFIG, deepMerge,
  estimateTokensFromTranscript, readState, writeState,
  updateTokenLedger, parseFrontier
};
```

- [ ] **Step 10: Run all tests**

Run: `node tests/forge-tools.test.cjs`
Expected: All PASS

- [ ] **Step 11: Write tests for capability discovery + resume prompt generation**

Append to `tests/forge-tools.test.cjs`:
```javascript
const { discoverCapabilities, generateResumePrompt } = require('../scripts/forge-tools.cjs');

// Test: discoverCapabilities reads MCP config
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    mcpServers: {
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
    }
  }));
  const caps = discoverCapabilities(tmpDir, claudeJson);
  assert(caps.mcp_servers.context7, 'should find context7');
  assert(caps.mcp_servers.playwright, 'should find playwright');
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: discoverCapabilities');
}

// Test: generateResumePrompt produces readable prompt
{
  const stateData = { phase: 'executing', spec: 'auth', current_task: 'T003', iteration: 5 };
  const prompt = generateResumePrompt(stateData, '/tmp/test-project');
  assert(prompt.includes('.forge/state.md'), 'should reference state file');
  assert(prompt.includes('T003'), 'should reference current task');
  assert(!prompt.includes('/forge'), 'should NOT contain slash commands');
  console.log('PASS: generateResumePrompt');
}
```

- [ ] **Step 12: Implement capability discovery + resume prompt generation**

Add to `scripts/forge-tools.cjs`:
```javascript
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

module.exports = {
  parseFrontmatter, serializeFrontmatter,
  loadConfig, DEFAULT_CONFIG, deepMerge,
  estimateTokensFromTranscript, readState, writeState,
  updateTokenLedger, parseFrontier,
  discoverCapabilities, generateResumePrompt, inferMcpUse
};
```

- [ ] **Step 13: Run all tests**

Run: `node tests/forge-tools.test.cjs`
Expected: All PASS

- [ ] **Step 14: Commit**

```bash
git add scripts/forge-tools.cjs tests/forge-tools.test.cjs
git commit -m "feat: add forge-tools.cjs core utility with tests

State management, config loading, YAML frontmatter parsing,
token estimation, frontier parsing, capability discovery,
and resume prompt generation."
```

---

## Task 2: Templates + References + Setup Script

**Files:**
- Create: `templates/spec.md`
- Create: `templates/plan.md`
- Create: `templates/state.md`
- Create: `templates/summary.md`
- Create: `templates/backprop-report.md`
- Create: `templates/config.json`
- Create: `templates/resume.md`
- Create: `references/token-profiles.md`
- Create: `references/complexity-heuristics.md`
- Create: `references/review-protocol.md`
- Create: `references/multi-repo.md`
- Create: `references/backprop-patterns.md`
- Create: `scripts/setup.sh`

These are all static content files. No logic, just well-structured templates and reference docs that agents/skills will use.

- [ ] **Step 1: Create all template files**

`templates/spec.md`:
```markdown
---
domain: {{DOMAIN}}
status: draft
created: {{DATE}}
complexity: {{quick|medium|complex}}
linked_repos: []
---

# {{DOMAIN}} Spec

## Overview
{{Brief description of this domain and its purpose.}}

## Requirements

### R001: {{Requirement Name}}
{{Description of the requirement.}}
**Acceptance Criteria:**
- [ ] {{Criterion 1}}
- [ ] {{Criterion 2}}
```

`templates/plan.md`:
```markdown
---
spec: {{SPEC_NAME}}
total_tasks: {{N}}
estimated_tokens: {{TOTAL}}
depth: {{quick|standard|thorough}}
---

# {{SPEC_NAME}} Frontier

## Tier 1 (parallel — no dependencies)
- [T001] {{Task name}} | est: ~{{N}}k tokens | repo: {{REPO}}

## Tier 2 (depends on T001)
- [T002] {{Task name}} | est: ~{{N}}k tokens | repo: {{REPO}} | depends: T001
```

`templates/state.md`:
```markdown
---
phase: idle
spec: null
current_task: null
task_status: null
iteration: 0
tokens_used: 0
tokens_budget: 500000
depth: standard
autonomy: gated
handoff_requested: false
---

## What's Done

## In-Flight Work

## What's Next

## Key Decisions
```

`templates/summary.md`:
```markdown
---
spec: {{SPEC_NAME}}
completed_at: {{DATE}}
total_tasks: {{N}}
total_tokens: {{TOKENS}}
duration_iterations: {{N}}
---

# {{SPEC_NAME}} Execution Summary

## Tasks Completed
{{List of tasks with commit hashes}}

## Deviations from Plan
{{Any auto-fixes, skipped tasks, or circuit breaker triggers}}

## Token Usage
- Budget: {{BUDGET}}
- Used: {{USED}} ({{PERCENT}}%)
- Average per task: {{AVG}}
```

`templates/backprop-report.md`:
```markdown
---
id: {{N}}
date: {{DATE}}
spec: {{SPEC_NAME}}
requirement: {{R_ID}}
gap_type: {{missing_criterion|incomplete_criterion|missing_requirement}}
pattern: {{PATTERN_NAME}}
---

# Backprop #{{N}}

## Bug Description
{{What went wrong}}

## Root Spec
- Spec: {{spec file}}
- Requirement: {{R_ID}}: {{requirement name}}
- Gap: {{What the acceptance criteria missed}}

## Spec Update
{{New or modified acceptance criterion}}

## Regression Test
- File: {{test file path}}
- Verifies: {{What the test checks}}

## Pattern
- Category: {{pattern category}}
- Occurrences: {{count}}
- Systemic fix suggested: {{yes/no}}
```

`templates/config.json`:
```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "context_reset_threshold": 60,
  "repos": {},
  "cross_repo_rules": {
    "commit_in_source": true,
    "api_first": true,
    "shared_specs": true
  },
  "loop": {
    "circuit_breaker_test_fails": 3,
    "circuit_breaker_debug_attempts": 3,
    "circuit_breaker_review_iterations": 3,
    "circuit_breaker_no_progress": 2,
    "single_task_budget_percent": 20
  },
  "review": {
    "enabled": true,
    "min_depth": "standard",
    "model": "claude"
  },
  "verification": {
    "enabled": true,
    "min_depth": "standard",
    "stub_detection": true
  },
  "backprop": {
    "auto_generate_regression_tests": true,
    "re_run_after_spec_update": false
  },
  "capability_hints": {}
}
```

`templates/resume.md`:
```markdown
You are resuming a Forge execution session. Read these files to restore context:

1. Read .forge/state.md — your current position, what's done, what's next
2. Read .forge/plans/ — the task frontier for the current spec
3. Read .forge/specs/ — the specification you're implementing
4. Read .forge/token-ledger.json — remaining token budget
5. Read .forge/capabilities.json — available tools

IMPORTANT: Do NOT re-read completed tasks. Do NOT re-plan.
Pick up exactly where you left off.
```

- [ ] **Step 2: Create all reference files**

`references/token-profiles.md`:
```markdown
# Token Profiles

## Depth: Quick
- Target tasks per spec: 3-5
- Estimated tokens per task: ~3,000
- Review after task: No
- TDD enforcement: No
- Phase verification: Skip
- Context per task target: ~10% of window
- Best for: Simple features, bug fixes, familiar codebases

## Depth: Standard (default)
- Target tasks per spec: 6-12
- Estimated tokens per task: ~6,000
- Review after task: 1 pass
- TDD enforcement: If TDD skill available
- Phase verification: Quick check
- Context per task target: ~15% of window
- Best for: Most features, moderate complexity

## Depth: Thorough
- Target tasks per spec: 12-20
- Estimated tokens per task: ~12,000
- Review after task: Until clean (max 3 iterations)
- TDD enforcement: Always
- Phase verification: Full goal-backward
- Context per task target: ~25% of window
- Best for: Critical features, unfamiliar codebases, production systems

## Budget Thresholds
| Usage | Action |
|-------|--------|
| 0-70% | Run at configured depth |
| 70-90% | Auto-downgrade to quick |
| 90-100% | Save state, graceful exit |
```

`references/complexity-heuristics.md`:
```markdown
# Complexity Heuristics

Forge auto-detects task complexity to recommend a depth level. Override with `--depth`.

## Signals → Simple (recommend: quick)
- Single file or few files affected
- Clear, specific task description
- No cross-component dependencies
- Familiar technology (matches existing codebase patterns)
- Bug fix or small enhancement

## Signals → Medium (recommend: standard)
- Multiple files across 2-3 directories
- New feature with defined scope
- Some cross-component dependencies
- Standard technology stack
- Requires tests but no architectural decisions

## Signals → Complex (recommend: thorough)
- Touches many files across multiple directories
- New system or subsystem
- Cross-repo dependencies
- Unfamiliar technology or novel approach
- Architectural decisions required
- Security-sensitive code
- Multi-domain spec decomposition needed

## Scoring (used by forge-complexity agent)
Each signal adds weight. Sum determines recommendation:
- Score 0-3: quick
- Score 4-7: standard
- Score 8+: thorough
```

`references/review-protocol.md`:
```markdown
# Review Protocol

## Claude-on-Claude Review Standards

### What the Reviewer Checks
1. **Spec compliance** — Does the code satisfy every acceptance criterion for the task?
2. **Missing pieces** — Are there acceptance criteria with no corresponding implementation?
3. **Over-engineering** — Is there code that goes beyond what the spec requires?
4. **Edge cases** — Are obvious edge cases handled (nulls, empty, boundary values)?
5. **Security** — No injection, XSS, hardcoded secrets, or unsafe patterns
6. **Test quality** — Do tests actually test the right thing? Are assertions meaningful?

### What the Reviewer Does NOT Check
- Code style (trust linters)
- Performance optimization (unless spec requires it)
- Documentation (unless spec requires it)
- Refactoring opportunities in unrelated code

### Output Format
```
STATUS: PASS | ISSUES

ISSUES (if any):
- [CRITICAL] file:line — description
- [IMPORTANT] file:line — description
- [MINOR] file:line — description
```

### Severity Levels
- **CRITICAL**: Blocks completion. Spec requirement not met, security issue, broken functionality.
- **IMPORTANT**: Should fix. Missing edge case, questionable pattern, weak test.
- **MINOR**: Nice to fix. Naming, minor redundancy. Accept and move on if review budget is low.

### Review Loop Rules
- Max 3 review iterations per task
- After 3 iterations: accept with warnings, log unresolved issues
- Same implementer fixes issues (preserves context)
- CRITICAL issues must be fixed. IMPORTANT issues should be fixed. MINOR issues are optional.
```

`references/multi-repo.md`:
```markdown
# Multi-Repo Coordination

## Configuration
Repos are declared in `.forge/config.json` under the `repos` key:
```json
{
  "repos": {
    "api": { "path": "../my-api", "role": "primary", "order": 1 },
    "frontend": { "path": "../my-frontend", "role": "secondary", "order": 2 }
  }
}
```

## Rules
1. **API-first**: When both repos involved, implement API changes before frontend
2. **Commit in source**: Always commit in the repo where changes were made
3. **Read conventions**: Each repo may have its own CLAUDE.md — read and follow it
4. **Reference phases**: Commit messages reference the spec: `feat(spec-auth): add JWT middleware`
5. **Shared specs**: Specs live in `.forge/specs/` (not in either repo)
6. **State is central**: `.forge/` lives in the working directory, not inside any repo

## Task Tags
Each task in the frontier is tagged with `repo:`:
```
- [T001] User model | repo: api
- [T007] Auth context | repo: frontend | depends: T005
```

## Cross-Repo Dependencies
Tasks can depend on tasks in other repos:
- T007 (frontend) depends on T005 (api)
- This means: API endpoint must exist and be committed before frontend work starts
- The executor reads the dependency, verifies the API task is complete, then proceeds
```

`references/backprop-patterns.md`:
```markdown
# Backpropagation Patterns

## How to Trace a Bug to a Spec Gap

1. **Identify the behavior** — What went wrong? What was expected?
2. **Find the spec** — Which spec domain does this belong to?
3. **Find the requirement** — Which R-number requirement is closest?
4. **Check acceptance criteria** — Is there a criterion that should have caught this?
5. **Classify the gap**:
   - **Missing criterion**: The requirement exists but doesn't test this case
   - **Incomplete criterion**: The criterion exists but is too vague
   - **Missing requirement**: No requirement covers this behavior at all

## Common Gap Patterns

### Input Validation Gaps
- Special characters not tested (unicode, emoji, SQL chars)
- Boundary values not specified (max length, min value, empty)
- Format variations not covered (email with +, phone with country code)

### Concurrency Gaps
- Race conditions not specified (simultaneous writes)
- Ordering assumptions not documented
- Idempotency not required

### Error Handling Gaps
- Failure modes not specified (network timeout, disk full, rate limit)
- Error message content not defined
- Retry behavior not documented

### Integration Gaps
- Cross-component contract not specified
- Data format assumptions not documented
- Timing dependencies not captured

## When to Suggest Systemic Changes
After 3+ backprops of the same pattern category, suggest adding a standard
brainstorming question for that category. For example:
- 3 input validation gaps → add "What are the edge cases for input formats?"
- 3 concurrency gaps → add "What happens with concurrent access?"
```

- [ ] **Step 3: Create setup.sh**

`scripts/setup.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Initialize .forge/ directory structure for a project
PROJECT_DIR="${1:-.}"
FORGE_DIR="${PROJECT_DIR}/.forge"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -d "$FORGE_DIR" ]; then
  echo "Forge already initialized in ${FORGE_DIR}"
  exit 0
fi

echo "Initializing Forge in ${FORGE_DIR}..."

mkdir -p "${FORGE_DIR}/specs"
mkdir -p "${FORGE_DIR}/plans"
mkdir -p "${FORGE_DIR}/history/cycles"
mkdir -p "${FORGE_DIR}/summaries"

# Copy default config
cp "${PLUGIN_ROOT}/templates/config.json" "${FORGE_DIR}/config.json"

# Initialize state
cp "${PLUGIN_ROOT}/templates/state.md" "${FORGE_DIR}/state.md"

# Initialize empty token ledger
echo '{"total":0,"iterations":0,"per_spec":{}}' > "${FORGE_DIR}/token-ledger.json"

# Initialize empty backprop log
echo "# Backpropagation Log" > "${FORGE_DIR}/history/backprop-log.md"

# Add .forge to .gitignore if not already there
GITIGNORE="${PROJECT_DIR}/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q '^\.forge/' "$GITIGNORE" 2>/dev/null; then
    echo ".forge/" >> "$GITIGNORE"
    echo "Added .forge/ to .gitignore"
  fi
else
  echo ".forge/" > "$GITIGNORE"
  echo "Created .gitignore with .forge/"
fi

echo "Forge initialized. Run /forge brainstorm to get started."
```

- [ ] **Step 4: Make setup.sh executable and verify**

Run: `chmod +x scripts/setup.sh && bash scripts/setup.sh /tmp/forge-test-project && ls -la /tmp/forge-test-project/.forge/ && rm -rf /tmp/forge-test-project`
Expected: Directory created with config.json, state.md, token-ledger.json, and subdirectories

- [ ] **Step 5: Commit**

```bash
git add templates/ references/ scripts/setup.sh
git commit -m "feat: add templates, references, and setup script

All output file templates (spec, plan, state, summary, backprop-report,
config, resume) and reference docs (token-profiles, complexity-heuristics,
review-protocol, multi-repo, backprop-patterns). Setup script initializes
.forge/ directory structure."
```

---

## Task 3: Hook Registration + Stop Hook

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/stop-hook.sh`
- Create: `hooks/token-monitor.sh`

The core loop engine. This is the most critical piece.

- [ ] **Step 1: Create hooks.json**

```json
{
  "description": "Forge plugin hooks — autonomous loop engine and token monitoring",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/token-monitor.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Create token-monitor.sh (lightweight PostToolUse hook)**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Lightweight PostToolUse hook — just increments a counter file
# Heavy lifting (token estimation, budget checks) done in stop-hook.sh

FORGE_DIR=".forge"
COUNTER_FILE="${FORGE_DIR}/.tool-count"

# Only act if forge is active
[ ! -f "${FORGE_DIR}/.forge-loop.json" ] && exit 0

# Increment tool use counter
COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
echo $((COUNT + 1)) > "$COUNTER_FILE"

exit 0
```

- [ ] **Step 3: Create stop-hook.sh (the state machine)**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Forge Stop Hook — Smart Loop Engine
# Fires when Claude tries to exit. Reads state, routes to next action.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FORGE_DIR=".forge"
LOOP_FILE="${FORGE_DIR}/.forge-loop.json"
STATE_FILE="${FORGE_DIR}/state.md"
TOOLS_CJS="${PLUGIN_ROOT}/scripts/forge-tools.cjs"

# Read hook input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.session_id||'')}catch(e){}" 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(echo "$INPUT" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.transcript_path||'')}catch(e){}" 2>/dev/null || echo "")

# Not in a forge loop? Allow normal exit
[ ! -f "$LOOP_FILE" ] && exit 0

# Check for Ralph Loop conflict
if [ -f ".claude/ralph-loop.local.md" ]; then
  echo '{"decision":"block","reason":"WARNING: Ralph Loop is also active. Please run /cancel-ralph first, then /forge resume. Only one loop plugin should be active at a time."}'
  exit 0
fi

# Read loop state
LOOP_DATA=$(cat "$LOOP_FILE")
ITERATION=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.iteration||1)}catch(e){console.log(1)}")
MAX_ITERATIONS=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.max_iterations||100)}catch(e){console.log(100)}")
COMPLETION_PROMISE=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.completion_promise||'FORGE_COMPLETE')}catch(e){console.log('FORGE_COMPLETE')}")
LOOP_SESSION=$(echo "$LOOP_DATA" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.session_id||'')}catch(e){console.log('')}")

# Session isolation — only the owning session controls the loop
if [ -n "$LOOP_SESSION" ] && [ -n "$SESSION_ID" ] && [ "$LOOP_SESSION" != "$SESSION_ID" ]; then
  exit 0
fi

# Check max iterations
if [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
  echo "Max iterations ($MAX_ITERATIONS) reached. Saving state and exiting." >&2
  rm -f "$LOOP_FILE"
  exit 0
fi

# Check for completion promise in last output
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LAST_OUTPUT=$(tail -20 "$TRANSCRIPT_PATH" | node -e "
    const lines=require('fs').readFileSync('/dev/stdin','utf8').split('\n').filter(Boolean);
    let last='';
    for(const l of lines){try{const d=JSON.parse(l);if(d.role==='assistant'){
      if(typeof d.content==='string')last=d.content;
      else if(Array.isArray(d.content)){for(const b of d.content){if(b.type==='text')last=b.text;}}
    }}catch(e){}}
    console.log(last);
  " 2>/dev/null || echo "")

  if echo "$LAST_OUTPUT" | grep -qF "<promise>${COMPLETION_PROMISE}</promise>"; then
    rm -f "$LOOP_FILE"
    exit 0
  fi
fi

# === ROUTING DECISION ===
# Call forge-tools.cjs for the smart routing
NEXT_PROMPT=$(node "$TOOLS_CJS" route \
  --forge-dir "$FORGE_DIR" \
  --iteration "$ITERATION" \
  --transcript "$TRANSCRIPT_PATH" \
  2>/dev/null || echo "")

if [ -z "$NEXT_PROMPT" ]; then
  # No routing decision — allow exit
  exit 0
fi

# Update iteration counter
NEXT_ITERATION=$((ITERATION + 1))
echo "$LOOP_DATA" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  d.iteration=$NEXT_ITERATION;
  d.last_updated=new Date().toISOString();
  console.log(JSON.stringify(d,null,2));
" > "$LOOP_FILE" 2>/dev/null

# Block exit and feed next prompt (use node for proper JSON escaping)
node -e "console.log(JSON.stringify({decision:'block',reason:'[Forge iteration ${NEXT_ITERATION}/${MAX_ITERATIONS}]\\n\\n'+process.argv[1]}))" "$NEXT_PROMPT"
```

- [ ] **Step 4: Add the `route` CLI command to forge-tools.cjs**

Append to `scripts/forge-tools.cjs`:
```javascript
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
          return 'Context approaching limit. Save comprehensive handoff to .forge/state.md including: current task, what\\'s done, what\\'s next, in-flight decisions, and any files you were editing. Write the handoff NOW, then stop.';
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
      const plans = fs.readdirSync(path.join(forgeDir, 'plans')).filter(f => f.endsWith('-frontier.md'));
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
      const specs = fs.readdirSync(path.join(forgeDir, 'specs')).filter(f => f.endsWith('.md'));
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
```

- [ ] **Step 5: Make hooks executable**

Run: `chmod +x hooks/stop-hook.sh hooks/token-monitor.sh`

- [ ] **Step 6: Test stop hook with mock state**

Run:
```bash
# Create mock .forge state
mkdir -p /tmp/forge-hook-test/.forge/specs /tmp/forge-hook-test/.forge/plans
echo '{"active":true,"iteration":1,"max_iterations":10,"completion_promise":"DONE"}' > /tmp/forge-hook-test/.forge/.forge-loop.json
# Create a minimal state
cat > /tmp/forge-hook-test/.forge/state.md << 'EOF'
---
phase: executing
spec: auth
current_task: T001
task_status: pending
iteration: 1
---

## What's Done

## In-Flight Work

## What's Next
EOF

# Create a minimal frontier
cat > /tmp/forge-hook-test/.forge/plans/auth-frontier.md << 'EOF'
---
spec: auth
total_tasks: 2
---

# Auth Frontier

## Tier 1 (parallel)
- [T001] User model | est: ~4k tokens | repo: api
- [T002] Auth controller | est: ~3k tokens | repo: api
EOF

# Test the route command
cd /tmp/forge-hook-test && node /home/lucasduys/forge/scripts/forge-tools.cjs route --forge-dir .forge --iteration 1
```
Expected: Output containing "Implement task T001"

- [ ] **Step 7: Commit**

```bash
git add hooks/ scripts/forge-tools.cjs
git commit -m "feat: add stop hook state machine and token monitor

Core loop engine: stop-hook.sh reads state and routes to next action,
token-monitor.sh tracks tool usage. forge-tools.cjs extended with
route command, task advancement, and CLI entry point."
```

---

## Task 4: Commands — help + status

**Files:**
- Create: `commands/help.md`
- Create: `commands/status.md`

- [ ] **Step 1: Create help command**

`commands/help.md`:
```markdown
---
description: "Show Forge usage guide"
hide-from-slash-command-tool: "true"
---

# Forge Help

Display the following help text to the user:

## Commands

**`/forge brainstorm [topic]`** — Turn an idea into concrete specs
  - `--from-code` — Generate specs from existing codebase
  - `--from-docs path/` — Generate specs from PRDs, API docs, research files

**`/forge plan`** — Decompose specs into task frontiers
  - `--filter <name>` — Only plan a specific spec
  - `--depth quick|standard|thorough` — Set task granularity

**`/forge execute`** — Run the autonomous implementation loop
  - `--autonomy full|gated|supervised` — Set pause behavior
  - `--max-iterations N` — Safety cap on loop iterations
  - `--token-budget N` — Max tokens to spend
  - `--depth quick|standard|thorough` — Override task depth

**`/forge resume`** — Continue after context reset or interruption

**`/forge backprop "bug description"`** — Trace a bug back to a spec gap
  - `--from-test path/` — Trace from a failing test

**`/forge status`** — Show current progress and budget

**`/forge help`** — Show this help text

## Quick Start
1. `/forge brainstorm "build a REST API for task management"`
2. `/forge plan`
3. `/forge execute --autonomy gated`

## Configuration
Edit `.forge/config.json` to customize autonomy, depth, token budget, multi-repo setup, and circuit breaker thresholds.
```

- [ ] **Step 2: Create status command**

`commands/status.md`:
```markdown
---
description: "Show Forge progress and status"
allowed-tools: ["Read(*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)"]
hide-from-slash-command-tool: "true"
---

# Forge Status

Read the following files and present a concise status report:

1. Read `.forge/state.md` — current phase, spec, task, iteration
2. Read `.forge/token-ledger.json` — token usage vs budget
3. Read `.forge/config.json` — autonomy mode, depth setting
4. Read `.forge/capabilities.json` — discovered MCP servers and skills (if exists)

Present the status in this format:

```
Forge Status
═══════════════════════════════════
Phase:     {{phase}}
Spec:      {{spec}}
Task:      {{current_task}} ({{task_status}})
Iteration: {{iteration}}

Tokens:    {{used}} / {{budget}} ({{percent}}%)
Depth:     {{depth}}
Autonomy:  {{autonomy}}

Capabilities: {{count}} MCP servers, {{count}} skills
```

If `.forge/` does not exist, say: "Forge not initialized. Run `/forge brainstorm` to get started."

If `.forge/.forge-loop.json` exists, add: "Loop active (iteration {{N}}/{{max}})"
```

- [ ] **Step 3: Commit**

```bash
git add commands/help.md commands/status.md
git commit -m "feat: add /forge help and /forge status commands"
```

---

**Note on Tasks 5-10:** These tasks create markdown files (commands, skills, agents) whose content is procedural guidance, not executable code. Unlike Tasks 1-4 which provide exact code, Tasks 5-10 describe the structure and behavior each file must implement. The implementer should write the full markdown content based on the referenced spec sections and templates. Each task includes the YAML frontmatter and key sections that must be present.

---

## Task 5: Brainstorm Command + Skill + Agent

**Files:**
- Create: `commands/brainstorm.md`
- Create: `skills/brainstorming/SKILL.md`
- Create: `agents/forge-speccer.md`
- Create: `agents/forge-complexity.md`

- [ ] **Step 1: Create brainstorm command**

`commands/brainstorm.md`:
```markdown
---
description: "Turn an idea into concrete specs with testable requirements"
argument-hint: "[TOPIC] [--from-code] [--from-docs PATH]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh:*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Agent(*)"]
hide-from-slash-command-tool: "true"
---

# Forge Brainstorm

## Step 1: Initialize
If `.forge/` does not exist, run the setup script:
```!
"${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" "."
```

## Step 2: Discover Capabilities
Run capability discovery:
```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" discover --forge-dir .forge
```

## Step 3: Follow the Brainstorming Skill
Now invoke the `forge:brainstorming` skill and follow its workflow exactly. The user's arguments are: $ARGUMENTS
```

- [ ] **Step 2: Create brainstorming skill**

`skills/brainstorming/SKILL.md` — This is the most important skill file. It governs the entire brainstorming workflow.

Write the full SKILL.md content following the spec's Section 5.1 behavior. It should:
- Auto-detect complexity (dispatch forge-complexity agent)
- Conduct interactive Q&A (one question at a time, multiple choice)
- Propose 2-3 approaches with trade-offs
- Write specs to `.forge/specs/spec-{domain}.md` using the template
- Handle `--from-code` and `--from-docs` modes
- Each spec gets R-numbered requirements with testable acceptance criteria

- [ ] **Step 3: Create forge-speccer agent**

`agents/forge-speccer.md`:
Write the agent definition with YAML frontmatter (name, description) and a detailed system prompt covering:
- Role: write specs from brainstorm output
- Output format: `.forge/specs/spec-{domain}.md` matching the template
- R-numbered requirements with acceptance criteria
- One question at a time, multiple choice preferred
- Propose 2-3 approaches

- [ ] **Step 4: Create forge-complexity agent**

`agents/forge-complexity.md`:
Write the agent definition for analyzing task complexity and recommending depth level. References `references/complexity-heuristics.md`.

- [ ] **Step 5: Test locally**

Run: `claude --plugin-dir /home/lucasduys/forge` then type `/forge brainstorm "build a todo API"`
Expected: Interactive brainstorming session that produces a spec file

- [ ] **Step 6: Commit**

```bash
git add commands/brainstorm.md skills/brainstorming/SKILL.md agents/forge-speccer.md agents/forge-complexity.md
git commit -m "feat: add /forge brainstorm command with skill and agents

Interactive brainstorming pipeline: complexity detection, Q&A,
approach proposals, spec generation with R-numbered requirements."
```

---

## Task 6: Plan Command + Skill + Agent

**Files:**
- Create: `commands/plan.md`
- Create: `skills/planning/SKILL.md`
- Create: `agents/forge-planner.md`

- [ ] **Step 1: Create plan command**

`commands/plan.md` — Entry point that reads specs, invokes planning skill, dispatches forge-planner agent per spec. Supports `--filter`, `--depth`, `--repos` flags.

- [ ] **Step 2: Create planning skill**

`skills/planning/SKILL.md` — Workflow for decomposing specs into frontier files:
- Read specs from `.forge/specs/`
- Build dependency DAG
- Group into tiers
- Tag with repo, estimated tokens, dependencies
- Write frontier to `.forge/plans/{spec}-frontier.md`
- Initialize token ledger

- [ ] **Step 3: Create forge-planner agent**

`agents/forge-planner.md` — Agent that decomposes a single spec into tasks. References `references/token-profiles.md` for estimation.

- [ ] **Step 4: Test locally**

Run: (with a spec already in `.forge/specs/`) `/forge plan`
Expected: Frontier file created in `.forge/plans/`

- [ ] **Step 5: Commit**

```bash
git add commands/plan.md skills/planning/SKILL.md agents/forge-planner.md
git commit -m "feat: add /forge plan command with skill and agent

Spec decomposition pipeline: reads specs, builds dependency DAG,
groups tasks into tiers, writes frontier files with token estimates."
```

---

## Task 7: Execute Command + Skill + Agent

**Files:**
- Create: `commands/execute.md`
- Create: `skills/executing/SKILL.md`
- Create: `agents/forge-executor.md`

- [ ] **Step 1: Create execute command**

`commands/execute.md` — Entry point that:
- Parses flags (autonomy, max-iterations, token-budget, depth, filter)
- Calls `forge-tools.cjs setup-state` to create `.forge-loop.json`
- Reads the first frontier and starts working on the first task
- The Stop hook takes over from here

- [ ] **Step 2: Create executing skill**

`skills/executing/SKILL.md` — Workflow for implementing a single task:
- Read task from frontier
- Read spec for acceptance criteria
- Implement (TDD if depth >= thorough, or available)
- Run tests
- Update `.forge/state.md` with progress
- Commit atomically per task
- References capabilities for MCP/skill routing

- [ ] **Step 3: Create forge-executor agent**

`agents/forge-executor.md` — Agent that implements individual tasks. Follows repo conventions, commits atomically, updates state.

- [ ] **Step 4: Test the full loop**

Run: (with spec + frontier ready) `/forge execute --autonomy supervised --max-iterations 5`
Expected: Implements first task, stop hook fires, feeds next task, etc.

- [ ] **Step 5: Commit**

```bash
git add commands/execute.md skills/executing/SKILL.md agents/forge-executor.md
git commit -m "feat: add /forge execute command with autonomous loop

Execution pipeline: reads frontier, implements tasks via stop hook
state machine, supports autonomy modes (full/gated/supervised)."
```

---

## Task 8: Review + Verification Agents

**Files:**
- Create: `skills/reviewing/SKILL.md`
- Create: `agents/forge-reviewer.md`
- Create: `agents/forge-verifier.md`

- [ ] **Step 1: Create reviewing skill**

`skills/reviewing/SKILL.md` — Claude-on-Claude review protocol. References `references/review-protocol.md`. Defines:
- What to check (spec compliance, missing pieces, over-engineering, edge cases, security)
- Output format (PASS / ISSUES with severity + file:line)
- Review loop rules (max 3 iterations)

- [ ] **Step 2: Create forge-reviewer agent**

`agents/forge-reviewer.md` — Reviews actual code against spec. Returns PASS or ISSUES.

- [ ] **Step 3: Create forge-verifier agent**

`agents/forge-verifier.md` — Goal-backward verification:
- Checks observable truths (not task checkboxes)
- Detects stubs/placeholders
- Verifies cross-component wiring
- Returns PASSED or GAPS_FOUND

- [ ] **Step 4: Commit**

```bash
git add skills/reviewing/SKILL.md agents/forge-reviewer.md agents/forge-verifier.md
git commit -m "feat: add review and verification agents

Claude-on-Claude code review and goal-backward phase verification.
Review protocol with severity levels and max iteration limits."
```

---

## Task 9: Resume Command

**Files:**
- Create: `commands/resume.md`

- [ ] **Step 1: Create resume command**

`commands/resume.md` — Reads `.forge/.forge-resume.md` and `.forge/state.md`, presents context to Claude, re-activates the loop by writing a fresh `.forge-loop.json`:
- Read state files
- Show user what was in progress
- Re-initialize loop state
- Continue execution

- [ ] **Step 2: Test resume flow**

Run: Manually create a `.forge-resume.md` and `.forge/state.md`, then `/forge resume`
Expected: Claude picks up from where it left off

- [ ] **Step 3: Commit**

```bash
git add commands/resume.md
git commit -m "feat: add /forge resume command for session continuity

Reads handoff state, re-activates loop, continues from exact
interruption point after context resets or manual pauses."
```

---

## Task 10: Backprop Command + Skill

**Files:**
- Create: `commands/backprop.md`
- Create: `skills/backpropagation/SKILL.md`

- [ ] **Step 1: Create backprop command**

`commands/backprop.md` — Entry point for bug-to-spec tracing. Parses `--from-test` flag.

- [ ] **Step 2: Create backpropagation skill**

`skills/backpropagation/SKILL.md` — Full workflow:
1. Analyze bug/failing test
2. Scan specs for matching requirements
3. Identify gap (missing criterion, incomplete criterion, missing requirement)
4. Classify (one-off vs pattern)
5. Propose spec update
6. Generate regression test
7. Log to backprop-log.md
8. Pattern detection (3+ → suggest systemic change)

References `references/backprop-patterns.md`.

- [ ] **Step 3: Commit**

```bash
git add commands/backprop.md skills/backpropagation/SKILL.md
git commit -m "feat: add /forge backprop command for self-improvement

Bug-to-spec tracing, regression test generation, pattern detection,
and systemic prompt improvement suggestions."
```

---

## Task 11: Integration Testing + Polish

**Files:**
- Create: `scripts/forge-runner.sh`
- Modify: `scripts/forge-tools.cjs` (any bug fixes from testing)
- Modify: `hooks/stop-hook.sh` (any bug fixes from testing)

- [ ] **Step 1: Create forge-runner.sh (autonomous wrapper)**

`scripts/forge-runner.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Forge Runner — external loop for fully autonomous execution
# Handles context resets by restarting Claude with resume prompt

echo "Starting Forge autonomous runner..."
echo "Press Ctrl+C to stop"

while true; do
  if [ ! -f .forge/.forge-resume.md ]; then
    echo "No resume prompt found. Run /forge execute first."
    exit 1
  fi

  claude --print -p "$(cat .forge/.forge-resume.md)"

  # Check if forge is done
  if [ ! -f .forge/.forge-loop.json ]; then
    echo "Forge complete!"
    break
  fi

  # Check if human intervention needed
  if grep -q 'status: blocked' .forge/state.md 2>/dev/null; then
    echo "Forge paused — needs human input."
    echo "Review .forge/state.md, then run /forge resume"
    break
  fi

  echo "Context reset. Starting fresh session in 3 seconds..."
  sleep 3
done
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/forge-runner.sh`

- [ ] **Step 3: End-to-end test**

Test the full pipeline manually:
1. `claude --plugin-dir /home/lucasduys/forge`
2. `/forge help` — verify help text shows
3. `/forge brainstorm "build a simple counter CLI tool"` — walk through brainstorm
4. `/forge plan --depth quick` — generate frontier
5. `/forge status` — verify status shows progress
6. `/forge execute --autonomy supervised --max-iterations 3` — test loop
7. Verify stop hook fires and routes correctly

Document any bugs found and fix them.

- [ ] **Step 4: Run forge-tools.cjs tests**

Run: `node tests/forge-tools.test.cjs`
Expected: All PASS

- [ ] **Step 5: Final commit**

```bash
git add scripts/forge-runner.sh
git add -u  # Any bug fixes
git commit -m "feat: add forge-runner.sh and integration fixes

Autonomous wrapper script for fully unattended execution.
Bug fixes from end-to-end testing."
```

---

## Task 12: README + License

**Files:**
- Create: `README.md`
- Create: `LICENSE`

- [ ] **Step 1: Create README.md**

Write a concise README covering:
- What Forge is (one paragraph)
- Installation (`claude plugin install forge`)
- Quick start (3 commands)
- All commands with brief descriptions
- Configuration options
- Architecture diagram (text-based)
- Contributing guide (brief)
- License (MIT)

- [ ] **Step 2: Create LICENSE (MIT)**

Standard MIT license with Lucas Duys as author.

- [ ] **Step 3: Final commit**

```bash
git add README.md LICENSE
git commit -m "docs: add README and MIT license"
```

---

## Execution Order & Dependencies

```
Task 1: forge-tools.cjs (no deps)
  ↓
Task 2: Templates + References + setup.sh (needs templates/config.json for setup.sh)
  ↓
Task 3: Hooks (needs forge-tools.cjs for route command)
  ↓
Task 4: help + status commands (needs .forge/ structure)
  ↓
Task 5: brainstorm command + skill + agents (needs setup.sh, templates)
  ↓
Task 6: plan command + skill + agent (needs specs from brainstorm)
  ↓
Task 7: execute command + skill + agent (needs frontier from plan, stop hook)
  ↓
Task 8: review + verification agents (used by execute loop)
  ↓
Task 9: resume command (needs stop hook, state management)
  ↓
Task 10: backprop command + skill (needs specs, state)
  ↓
Task 11: Integration testing + forge-runner.sh
  ↓
Task 12: README + License
```

Tasks 4-6 can partially overlap. Tasks 8-10 are independent of each other.
