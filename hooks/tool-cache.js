#!/usr/bin/env node
// PreToolUse hook -- caches idempotent tool calls, returns cached results
// Matcher: "Bash|Grep|Glob|Read"
//
// Wave 2 / R001: pattern broadening + mutating-guard hardening.
//   - Original 6 v1 patterns preserved byte-for-byte when FORGE_TOKEN_OPT=0.
//   - When FORGE_TOKEN_OPT is unset (default-on) or any non-"0" value, the
//     extended pattern set + shell-substitution / redirect / pipe-mutator
//     guards are active.
//   - Every cache lookup (hit or miss) emits a recordCacheEvent so the T002
//     aggregator (queryHeadlessState tokens.cache) sees real traffic. The
//     pattern_class is provisional 'volatile' for now; T004 introduces real
//     tier classes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let recordCacheEvent;
try {
  ({ recordCacheEvent } = require('./tool-cache-store.js'));
} catch (e) {
  // Defensive: if the companion module fails to load, the cache hook still
  // works — it just doesn't emit telemetry.
  recordCacheEvent = function () { return { written: false, error: 'store-unavailable' }; };
}

const DEFAULT_TTL_MS = 120000; // 2 minutes
const MAX_CACHE_OUTPUT = 8000;

// --- v1 cacheable patterns (frozen; do NOT modify) ---
// These are the original 6 patterns that shipped before Wave 2. Preserving
// them byte-for-byte is acceptance criterion R001.AC5 and R006.AC1.
const V1_CACHEABLE_COMMANDS = [
  /^git (status|log|diff|branch|ls-files|show)/,
  /^(ls|find|which|wc)\b/,
];

// --- v2 additions (Wave 2 R001) ---
// Anchored with ^, word-boundary after the command, no shell-sub.
const VERSION_PATTERNS = [
  /^node\s+(-v|--version)\s*$/,
  /^python3?\s+--version\s*$/,
  /^bun\s+--version\s*$/,
  /^cargo\s+--version\s*$/,
  /^go\s+version\s*$/,
  /^rustc\s+--version\s*$/,
];

// Note on head/tail: only bare files OR an optional `-n <N>` flag are allowed.
// We disallow other flags (-c, -f, --bytes, etc.) because some, like
// `tail -f`, are streaming and unsafe to cache. Files may not start with `-`.
const READ_PATTERNS = [
  /^cat\s+[^-\s]\S*(?:\s+[^-\s]\S*)*\s*$/,
  /^head(?:\s+-n\s+\d+)?\s+[^-\s]\S*(?:\s+[^-\s]\S*)*\s*$/,
  /^tail(?:\s+-n\s+\d+)?\s+[^-\s]\S*(?:\s+[^-\s]\S*)*\s*$/,
  /^tree(?:\s+[^-\s]\S*)?\s*$/,
  /^file\s+[^-\s]\S*\s*$/,
];

const GH_VIEW_PATTERNS = [
  /^gh\s+(repo|issue|pr)\s+view(\s+\S+)*\s*$/,
];

const PKG_LIST_PATTERNS = [
  /^npm\s+list(\s+--prod|\s+--depth\s+\d+)?\s*$/,
  /^pip\s+list\s*$/,
];

const V2_EXTRA_PATTERNS = [
  ...VERSION_PATTERNS,
  ...READ_PATTERNS,
  ...GH_VIEW_PATTERNS,
  ...PKG_LIST_PATTERNS,
];

const MUTATING_COMMANDS = [
  /^(git (add|commit|push|checkout|merge|reset|rebase|cherry-pick)|rm|mv|cp|mkdir|npm (install|run|exec)|yarn|pnpm|tee)\b/,
];

// Reject shell substitution outright (Wave 2 R001.AC3). We treat $(...),
// backticks, and process substitution <(...) as non-cacheable -- they may
// invoke arbitrary code with side effects.
//
// Note: backtick is a regex literal char so we escape via String.fromCharCode
// to keep the source readable and avoid template-literal confusion.
const _BACKTICK = String.fromCharCode(96);
const SHELL_SUBSTITUTION_RE = new RegExp('\\$\\(|' + _BACKTICK + '|<\\(');

// Reject any redirect (>, >>, <<<, >&, <&). None of our cacheable commands
// legitimately contain < or > in the unquoted form, so a coarse [<>] check
// is correct and simpler than disambiguating digraphs.
const REDIRECT_RE = /[<>]/;

function isCacheableCommand(cmd, killSwitchOff) {
  if (killSwitchOff) {
    // v1 parity mode: only the original 6 patterns, no guard rails (those
    // weren't in v1 either, so adding them would break byte-for-byte parity).
    return V1_CACHEABLE_COMMANDS.some(p => p.test(cmd));
  }

  // v2 path: shell-sub / redirect / pipe-mutator guards before pattern match.
  if (SHELL_SUBSTITUTION_RE.test(cmd)) return false;
  if (REDIRECT_RE.test(cmd)) return false;
  if (cmd.includes('|')) {
    const segments = cmd.split('|').map(s => s.trim());
    for (const seg of segments) {
      if (MUTATING_COMMANDS.some(p => p.test(seg))) return false;
    }
  }

  if (V1_CACHEABLE_COMMANDS.some(p => p.test(cmd))) return true;
  if (V2_EXTRA_PATTERNS.some(p => p.test(cmd))) return true;
  return false;
}

function isMutating(cmd) {
  return MUTATING_COMMANDS.some(p => p.test(cmd));
}

function hashInput(toolName, toolInput) {
  const key = JSON.stringify({ toolName, toolInput });
  return crypto.createHash('md5').update(key).digest('hex');
}

function safeRecord(event) {
  try {
    recordCacheEvent(event, { forgeDir: '.forge' });
  } catch (e) {
    // Telemetry must never break the cache hook's primary deny/allow path.
  }
}

function main() {
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

      const killSwitchOff = process.env.FORGE_TOKEN_OPT === '0';

      // For Bash, check if command is cacheable
      if (toolName === 'Bash') {
        const cmd = toolInput.command || '';
        if (!isCacheableCommand(cmd, killSwitchOff)) process.exit(0);
        if (isMutating(cmd)) process.exit(0);
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
          safeRecord({
            tool: toolName,
            pattern_class: 'volatile',
            hit: true,
            age_ms: age,
            output_bytes: typeof cached.output === 'string' ? cached.output.length : 0,
          });
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
      safeRecord({
        tool: toolName,
        pattern_class: 'volatile',
        hit: false,
        age_ms: 0,
        output_bytes: 0,
      });
      process.exit(0);
    } catch (e) {
      process.exit(0);
    }
  });
}

module.exports = {
  V1_CACHEABLE_COMMANDS,
  V2_EXTRA_PATTERNS,
  VERSION_PATTERNS,
  READ_PATTERNS,
  GH_VIEW_PATTERNS,
  PKG_LIST_PATTERNS,
  MUTATING_COMMANDS,
  SHELL_SUBSTITUTION_RE,
  REDIRECT_RE,
  isCacheableCommand,
  isMutating,
};

if (require.main === module) {
  main();
}
