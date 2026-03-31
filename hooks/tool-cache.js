#!/usr/bin/env node
// PreToolUse hook -- caches idempotent tool calls, returns cached results
// Matcher: "Bash|Grep|Glob|Read"

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 120000; // 2 minutes
const MAX_CACHE_OUTPUT = 8000;

const CACHEABLE_COMMANDS = [
  /^git (status|log|diff|branch|ls-files|show)/,
  /^(ls|find|which|wc)\b/,
];

const MUTATING_COMMANDS = [
  /^(git (add|commit|push|checkout|merge|reset|rebase|cherry-pick)|rm|mv|cp|mkdir|npm (install|run|exec)|yarn|pnpm)\b/,
];

function hashInput(toolName, toolInput) {
  const key = JSON.stringify({ toolName, toolInput });
  return crypto.createHash('md5').update(key).digest('hex');
}

let input = '';
const timeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;
    const toolInput = data.tool_input || {};
    const sessionId = data.session_id || 'default';

    if (!['Bash', 'Grep', 'Glob', 'Read'].includes(toolName)) {
      process.exit(0);
    }

    // For Bash, check if command is cacheable
    if (toolName === 'Bash') {
      const cmd = toolInput.command || '';
      const isCacheable = CACHEABLE_COMMANDS.some(p => p.test(cmd));
      const isMutating = MUTATING_COMMANDS.some(p => p.test(cmd));
      if (!isCacheable || isMutating) process.exit(0);
    }

    const cacheDir = path.join(os.tmpdir(), `forge-tool-cache-${sessionId}`);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const hash = hashInput(toolName, toolInput);
    const cachePath = path.join(cacheDir, `${hash}.json`);

    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const age = Date.now() - cached.timestamp;

      if (age < DEFAULT_TTL_MS) {
        const result = {
          hookSpecificOutput: {
            permissionDecision: 'deny'
          },
          systemMessage: `[Cached result from ${Math.round(age / 1000)}s ago]\n\n${cached.output}`
        };
        process.stdout.write(JSON.stringify(result));
        return;
      }
    }

    // Cache miss -- allow execution
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
