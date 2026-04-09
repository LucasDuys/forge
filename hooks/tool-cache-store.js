#!/usr/bin/env node
// PostToolUse hook -- stores results of cacheable tool calls
// Companion to tool-cache.js (PreToolUse)
// Matcher: "Bash|Grep|Glob|Read"

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_CACHED_OUTPUT = 8000;

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
    const sessionId = data.session_id || 'default';
    const toolName = data.tool_name;
    const toolInput = data.tool_input || {};
    const output = typeof data.tool_output === 'string'
      ? data.tool_output
      : JSON.stringify(data.tool_output);

    if (!output || output.length > MAX_CACHED_OUTPUT) process.exit(0);
    if (!['Bash', 'Grep', 'Glob', 'Read'].includes(toolName)) process.exit(0);

    const cacheDir = path.join(os.tmpdir(), `forge-tool-cache-${sessionId}`);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const hash = hashInput(toolName, toolInput);
    fs.writeFileSync(
      path.join(cacheDir, `${hash}.json`),
      JSON.stringify({ timestamp: Date.now(), output })
    );
  } catch (e) { /* silent */ }
  process.exit(0);
});
