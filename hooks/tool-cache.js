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
// stable:           30 minutes -- version queries, immutable git refs (sha-pinned).
// volatile:         2 minutes  -- ls/find/git status/git diff/gh views/cat/...
// head_pinned:      2 minutes  -- STUB matching volatile until T006 wires the
//                                 per-HEAD invalidation check (depends on T001
//                                 HEAD helper). Class boundary is established now
//                                 so T006 only needs to swap the TTL resolver.
// read_stat_pinned: 10 minutes -- Read-tool entries keyed on (path, mtime, size).
//                                 Long TTL is safe because the (mtime, size) tuple
//                                 in the cache key changes whenever the file
//                                 changes, naturally invalidating stale entries.
//                                 R003 (T005). Falls back to 'volatile' (120s)
//                                 when fs.statSync fails.
const TTL_BY_CLASS = Object.freeze({
  stable: 1800000,            // 30 min
  volatile: 120000,           // 2 min
  head_pinned: 120000,        // 2 min (stub; T006 → per-HEAD invalidation)
  read_stat_pinned: 600000,   // 10 min (R003 / T005)
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

// --- R003: Read-tool mtime+size keying (T005) ---
//
// getReadFileStat(filePath)
//   Cheap stat (≤1ms) for the Read tool's PreToolUse hook. Returns
//   { mtime_ms, size_bytes } on success; returns { mtime_ms: null,
//   size_bytes: null } on any error (file not found, permission denied,
//   non-string path, ...).  MUST NEVER throw -- callers rely on a sentinel
//   "stat unavailable" return value to fall back to v1 cache-key shape.
function getReadFileStat(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { mtime_ms: null, size_bytes: null };
  }
  try {
    // Prefer { throwIfNoEntry: false } when available (Node ≥ 14.17). On older
    // runtimes, the option is silently ignored and ENOENT throws -- handled by
    // the try/catch.
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      return { mtime_ms: null, size_bytes: null };
    }
    return { mtime_ms: stat.mtimeMs, size_bytes: stat.size };
  } catch (e) {
    return { mtime_ms: null, size_bytes: null };
  }
}

// computeReadCacheKey(toolInput, statResult)
//   Returns a string suitable for use as the cache filename (md5 hex, with an
//   optional "_mtime_size" suffix when stat is available). Uses underscore as
//   the separator (not colon) so the resulting filename is valid on Windows.
//
//   - When statResult has non-null mtime_ms AND size_bytes, the return is
//     `<md5(toolName, toolInput)>_<mtime_ms>_<size_bytes>` -- a file change
//     produces a brand-new key, so the old entry is naturally invalidated
//     (no entry-side equality check required at read time). The mtime_ms is
//     floored to integer milliseconds so floating-point dust on some
//     filesystems doesn't perturb the key for unchanged files. Underscores
//     in mtime/size are not present (decimals only).
//   - When stat is unavailable (null fields), returns the v1 shape:
//     `<md5(toolName, toolInput)>` -- backward-compatible with v1 cache files.
//
//   Returned string is safe to use as a filename component on all platforms
//   (hex digits + decimal digits + underscores; no path separators, no shell
//   metachars, no Windows-reserved characters).
function computeReadCacheKey(toolInput, statResult) {
  const baseHash = hashInput('Read', toolInput);
  if (statResult && statResult.mtime_ms != null && statResult.size_bytes != null) {
    const mtime = Math.floor(statResult.mtime_ms);
    const size = statResult.size_bytes;
    return baseHash + '_' + mtime + '_' + size;
  }
  return baseHash;
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

      // R003 (T005): For Read tool calls in v2 path, compute a stat-keyed
      // cache filename. The (mtime_ms, size_bytes) tuple is folded into the
      // filename itself, so a file mutation produces a brand-new key -- old
      // entries are naturally invalidated without any entry-side check at
      // read time. Stat errors fall back to v1 hashing + volatile/120s TTL.
      // FORGE_TOKEN_OPT=0 short-circuits to v1 behavior (no stat call).
      let cacheFileKey;
      if (toolName === 'Read' && !killSwitchOff) {
        const filePath = toolInput && toolInput.file_path;
        const statResult = getReadFileStat(filePath);
        if (statResult.mtime_ms != null && statResult.size_bytes != null) {
          patternClass = 'read_stat_pinned';
          cacheFileKey = computeReadCacheKey(toolInput, statResult);
        } else {
          patternClass = 'volatile';
          cacheFileKey = hashInput(toolName, toolInput);
        }
      } else {
        cacheFileKey = hashInput(toolName, toolInput);
      }

      const cacheDir = path.join(os.tmpdir(), `forge-tool-cache-${sessionId}`);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const hash = cacheFileKey;
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
  hashInput,
  getReadFileStat,
  computeReadCacheKey,
  _resetCacheConfig,
};

if (require.main === module) {
  main();
}
