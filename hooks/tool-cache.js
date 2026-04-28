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
//     aggregator (queryHeadlessState tokens.cache) sees real traffic.
//
// Wave 2 / R002: tiered TTL classes.
//   - Three classes: 'stable' (1800s), 'volatile' (120s), 'head_pinned'
//     (currently 120s as a STUB; T006 will swap this to per-HEAD invalidation).
//   - Class is determined at cache-write time via classifyPattern() and stored
//     in the cache entry alongside output and timestamp.
//   - Operators may override per-class TTL via .forge/config.json:
//       hooks_config.tool_cache_ttl_overrides: {
//         stable:      <seconds>,
//         volatile:    <seconds>,
//         head_pinned: <seconds>
//       }
//     Defaults are baked-in constants below; overrides are merged on top.
//   - Backward compat: cache entries written by v1 (no `class` field) are
//     treated as 'volatile' with a 120s TTL.
//   - When FORGE_TOKEN_OPT=0, all entries fall back to v1's flat 120s TTL
//     regardless of the pattern's class. The class field is still emitted to
//     recordCacheEvent as 'volatile' for forward compat.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let recordCacheEvent;
try {
  ({ recordCacheEvent } = require('./tool-cache-store.js'));
} catch (e) {
  // Defensive: if the companion module fails to load, the cache hook still
  // works -- it just doesn't emit telemetry.
  recordCacheEvent = function () { return { written: false, error: 'store-unavailable' }; };
}

// --- R002: tiered TTL classes (defaults, in milliseconds) ---
// stable:      30 minutes -- version queries, immutable git refs (sha-pinned).
// volatile:    2 minutes  -- ls/find/git status/git diff/gh views/cat/...
// head_pinned: 2 minutes  -- STUB matching volatile until T006 wires the
//                            per-HEAD invalidation check (depends on T001
//                            HEAD helper). Class boundary is established now
//                            so T006 only needs to swap the TTL resolver.
const TTL_BY_CLASS = Object.freeze({
  stable: 1800000,      // 30 min
  volatile: 120000,     // 2 min
  head_pinned: 120000,  // 2 min (stub; T006 → per-HEAD invalidation)
});

// v1 flat TTL retained for FORGE_TOKEN_OPT=0 parity.
const DEFAULT_TTL_MS = 120000;

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

// --- R002: classification regexes (subset of cacheable patterns) ---
//
// stable: TTL 30m. Two sub-classes:
//   - version queries (`node -v`, `python --version`, etc.) — output
//     changes only on toolchain upgrade.
//   - immutable git refs: `git show <sha>` where <sha> matches a 7-40 char
//     hex string. SHA-addressed objects never change.
const STABLE_GIT_SHA_RE = /^git\s+show\s+[0-9a-f]{7,40}\s*$/;

// head_pinned: TTL bound to the current HEAD commit. Stub for T004; T006
// wires per-HEAD invalidation. Patterns whose output changes if and only if
// HEAD moves: ls-files, show HEAD, rev-parse HEAD.
const HEAD_PINNED_PATTERNS = [
  /^git\s+ls-files(\s|$)/,
  /^git\s+show\s+HEAD(\s|$|~|\^)/,
  /^git\s+rev-parse\s+HEAD(\s|$|~|\^)/,
];

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

// --- R002: classifyPattern ---
// Determines which TTL class a (cacheable) command falls into. Caller is
// responsible for already having confirmed the command is cacheable; this
// function only routes between classes. Order matters:
//   1. stable (most specific: version queries + immutable git refs)
//   2. head_pinned (HEAD-bound git queries)
//   3. volatile (default for everything else cacheable)
function classifyPattern(cmd) {
  if (typeof cmd !== 'string') return 'volatile';
  // Stable: version queries (node -v, python --version, etc.)
  for (const p of VERSION_PATTERNS) {
    if (p.test(cmd)) return 'stable';
  }
  // Stable: immutable git refs (sha-pinned).
  if (STABLE_GIT_SHA_RE.test(cmd)) return 'stable';
  // head_pinned: HEAD-bound git queries.
  for (const p of HEAD_PINNED_PATTERNS) {
    if (p.test(cmd)) return 'head_pinned';
  }
  // Default: volatile (ls, find, git status, git diff, gh views, cat, ...)
  return 'volatile';
}

// --- R002: per-process config memo ---
// Reads .forge/config.json once and caches the resolved override map.
// Subsequent calls return the same object. Tests can clear via
// _resetCacheConfig() (exported below).
let _cacheConfigMemo = null;
let _cacheConfigMemoKey = null;

function _resetCacheConfig() {
  _cacheConfigMemo = null;
  _cacheConfigMemoKey = null;
}

function loadCacheConfig(forgeDir) {
  const dir = forgeDir || '.forge';
  const key = path.resolve(dir);
  if (_cacheConfigMemo && _cacheConfigMemoKey === key) {
    return _cacheConfigMemo;
  }
  const overrides = {};
  try {
    const cfgPath = path.join(dir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw);
      const hooksCfg = parsed && parsed.hooks_config;
      const ov = hooksCfg && hooksCfg.tool_cache_ttl_overrides;
      if (ov && typeof ov === 'object' && !Array.isArray(ov)) {
        for (const cls of ['stable', 'volatile', 'head_pinned']) {
          const v = ov[cls];
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            overrides[cls] = Math.floor(v) * 1000; // seconds → ms
          }
        }
      }
    }
  } catch (e) {
    // Malformed config → fall through to baked-in defaults.
  }
  _cacheConfigMemo = Object.freeze(overrides);
  _cacheConfigMemoKey = key;
  return _cacheConfigMemo;
}

// Resolve TTL (ms) for a given class, applying overrides on top of defaults.
// Unknown classes fall back to volatile.
function getTtl(cls, overrides) {
  const ov = overrides || {};
  if (ov[cls] != null) return ov[cls];
  if (TTL_BY_CLASS[cls] != null) return TTL_BY_CLASS[cls];
  return TTL_BY_CLASS.volatile;
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
      let patternClass = 'volatile';
      if (toolName === 'Bash') {
        const cmd = toolInput.command || '';
        if (!isCacheableCommand(cmd, killSwitchOff)) process.exit(0);
        if (isMutating(cmd)) process.exit(0);
        // Classify only when v2 path is active. In kill-switch mode we still
        // emit class='volatile' for forward compat (R002.AC5 commentary).
        if (!killSwitchOff) {
          patternClass = classifyPattern(cmd);
        }
      }

      const cacheDir = path.join(os.tmpdir(), `forge-tool-cache-${sessionId}`);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const hash = hashInput(toolName, toolInput);
      const cachePath = path.join(cacheDir, `${hash}.json`);

      // Resolve TTL: kill-switch → flat v1 120s; otherwise per-class with
      // operator overrides applied.
      let ttlForLookup = DEFAULT_TTL_MS;
      if (!killSwitchOff) {
        const overrides = loadCacheConfig('.forge');
        ttlForLookup = getTtl(patternClass, overrides);
      }

      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const age = Date.now() - cached.timestamp;

        // Backward compat: an entry without a `class` field was written by
        // v1 — treat as volatile with the v1 flat 120s TTL. We use the
        // entry's class (if present) over the request's classification when
        // resolving TTL on read, because the entry's class was determined at
        // write time and is the source of truth for the cached output.
        const entryClass = cached.class || 'volatile';
        let ttlForRead = DEFAULT_TTL_MS;
        if (!killSwitchOff) {
          const overrides = loadCacheConfig('.forge');
          ttlForRead = getTtl(entryClass, overrides);
        }

        if (age < ttlForRead) {
          safeRecord({
            tool: toolName,
            pattern_class: killSwitchOff ? 'volatile' : entryClass,
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
        pattern_class: killSwitchOff ? 'volatile' : patternClass,
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
  STABLE_GIT_SHA_RE,
  HEAD_PINNED_PATTERNS,
  TTL_BY_CLASS,
  DEFAULT_TTL_MS,
  isCacheableCommand,
  isMutating,
  classifyPattern,
  loadCacheConfig,
  getTtl,
  _resetCacheConfig,
};

if (require.main === module) {
  main();
}
