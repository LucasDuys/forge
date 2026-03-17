const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseFrontmatter, serializeFrontmatter,
  loadConfig, DEFAULT_CONFIG, deepMerge,
  estimateTokensFromTranscript, readState, writeState,
  updateTokenLedger, parseFrontier,
  discoverCapabilities, generateResumePrompt, inferMcpUse,
  routeDecision, findNextUnblockedTask, buildTaskPrompt, advanceToNextTask
} = require('../scripts/forge-tools.cjs');

// === Frontmatter Tests ===

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

// === Config Tests ===

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

// === Token Estimation Tests ===

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

// === State Management Tests ===

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

// === Frontier Parsing Tests ===

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

// === Capability Discovery Tests ===

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

// === Resume Prompt Tests ===

// Test: generateResumePrompt produces readable prompt
{
  const stateData = { phase: 'executing', spec: 'auth', current_task: 'T003', iteration: 5 };
  const prompt = generateResumePrompt(stateData, '/tmp/test-project');
  assert(prompt.includes('.forge/state.md'), 'should reference state file');
  assert(prompt.includes('T003'), 'should reference current task');
  assert(!prompt.includes('/forge'), 'should NOT contain slash commands');
  console.log('PASS: generateResumePrompt');
}

// === Route Decision Tests ===

// Test: routeDecision returns task prompt for pending task
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(forgeDir, 'specs'), { recursive: true });

  // Write state
  writeState(forgeDir, {
    phase: 'executing',
    spec: 'auth',
    current_task: 'T001',
    task_status: 'pending',
    iteration: 1,
    autonomy: 'full',
    depth: 'standard'
  }, '## What\'s Done\n\n## In-Flight Work\n\n## What\'s Next\n');

  // Write frontier
  fs.writeFileSync(path.join(forgeDir, 'plans', 'auth-frontier.md'), `---
spec: auth
total_tasks: 2
---

# Auth Frontier

## Tier 1 (parallel)
- [T001] User model | est: ~4k tokens | repo: api
- [T002] Auth controller | est: ~3k tokens | repo: api
`);

  const result = routeDecision(forgeDir, 1, '');
  assert(result.includes('T001'), 'should mention task T001');
  assert(result.includes('Implement'), 'should be an implementation prompt');
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: routeDecision pending task');
}

// Test: routeDecision returns empty for idle phase
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });

  writeState(forgeDir, { phase: 'idle' }, '');
  const result = routeDecision(forgeDir, 1, '');
  assert.strictEqual(result, '', 'idle phase should return empty');
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: routeDecision idle');
}

// Test: findNextUnblockedTask skips done tasks
{
  const tasks = [
    { id: 'T001', name: 'Model', tier: 1, depends: [], status: 'pending' },
    { id: 'T002', name: 'Controller', tier: 1, depends: [], status: 'pending' },
    { id: 'T003', name: 'Registration', tier: 2, depends: ['T001', 'T002'], status: 'pending' }
  ];
  const state = { data: {}, content: '## What\'s Done\n- T001: complete\n- T002: complete' };
  const next = findNextUnblockedTask(tasks, state);
  assert.strictEqual(next.id, 'T003');
  console.log('PASS: findNextUnblockedTask skips done');
}

// Test: findNextUnblockedTask respects dependencies
{
  const tasks = [
    { id: 'T001', name: 'Model', tier: 1, depends: [], status: 'pending' },
    { id: 'T002', name: 'Controller', tier: 2, depends: ['T001'], status: 'pending' }
  ];
  const state = { data: {}, content: '## What\'s Done\n' };
  const next = findNextUnblockedTask(tasks, state);
  assert.strictEqual(next.id, 'T001', 'should pick T001 first since T002 depends on it');
  console.log('PASS: findNextUnblockedTask respects deps');
}

// Test: advanceToNextTask in supervised mode returns empty (pause)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(forgeDir, 'specs'), { recursive: true });

  writeState(forgeDir, {
    phase: 'executing',
    spec: 'auth',
    current_task: 'T001',
    task_status: 'reviewing',
    autonomy: 'supervised',
    depth: 'standard'
  }, '## What\'s Done\n- T001: complete\n\n## In-Flight Work\n\n## What\'s Next\n');

  const tasks = [
    { id: 'T001', name: 'Model', tier: 1, depends: [], status: 'pending' },
    { id: 'T002', name: 'Controller', tier: 1, depends: [], status: 'pending' }
  ];

  const state = readState(forgeDir);
  const result = advanceToNextTask(tasks, state, forgeDir, 'auth');
  assert.strictEqual(result, '', 'supervised mode should pause between tasks');
  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: advanceToNextTask supervised pause');
}

// Test: updateTokenLedger increments correctly
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });

  const ledger1 = updateTokenLedger(forgeDir, 1000);
  assert.strictEqual(ledger1.total, 1000);
  assert.strictEqual(ledger1.iterations, 1);

  const ledger2 = updateTokenLedger(forgeDir, 2000);
  assert.strictEqual(ledger2.total, 3000);
  assert.strictEqual(ledger2.iterations, 2);
  assert.strictEqual(ledger2.avg_per_iteration, 1500);

  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: updateTokenLedger');
}

// Test: inferMcpUse returns correct mappings
{
  assert.strictEqual(inferMcpUse('context7'), 'library documentation lookup');
  assert.strictEqual(inferMcpUse('my-playwright-server'), 'browser automation and E2E testing');
  assert.strictEqual(inferMcpUse('custom-tool'), 'custom integration');
  console.log('PASS: inferMcpUse');
}

// Test: buildTaskPrompt includes spec reference and TDD for thorough
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const forgeDir = path.join(tmpDir, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'specs'), { recursive: true });

  writeState(forgeDir, { phase: 'executing', spec: 'auth' }, '');

  const task = { id: 'T001', name: 'User model', tier: 1, repo: 'api', depends: [] };
  const prompt = buildTaskPrompt(task, forgeDir, 'thorough');
  assert(prompt.includes('T001'), 'should mention task ID');
  assert(prompt.includes('User model'), 'should mention task name');
  assert(prompt.includes('TDD'), 'thorough should mention TDD');
  assert(prompt.includes('api'), 'should mention repo');

  fs.rmSync(tmpDir, { recursive: true });
  console.log('PASS: buildTaskPrompt');
}

console.log('\n=== ALL TESTS PASSED ===');
