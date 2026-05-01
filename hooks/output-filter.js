#!/usr/bin/env node
// PostToolUse hook -- generalized output filter for non-test Bash commands.
// Matcher: "Bash"
//
// Reads PostToolUse JSON from stdin. If the tool was a Bash invocation
// running a recognised command class (package install, build, git diff,
// find, curl), and the output exceeds the per-class threshold, replaces
// the output with a condensed view that preserves errors/warnings/summary.
// Outputs nothing (exit 0) when not applicable -- zero context cost.
//
// Sibling to hooks/test-output-filter.js (which handles test runners).
// The two are deliberately separate to keep each rule set focused.

'use strict';

// --- thresholds ----------------------------------------------------------

var DEFAULT_THRESHOLD = 2000;
var CURL_THRESHOLD = 10240;
var TIMEOUT_MS = 3000;

// Per-class strategy parameters
var INSTALL_HEAD = 5;
var INSTALL_TAIL = 3;
var BUILD_TAIL = 3;
var DIFF_LINES_PER_FILE = 100;
var FIND_HEAD = 50;
var FIND_TAIL = 10;
var CURL_BODY_BYTES = 1024;

// --- command matchers ----------------------------------------------------

var INSTALL_PATTERNS = [
  /^(npm|yarn|pnpm|bun|pip|pip3)\s+(install|ci|add)\b/,
  /^cargo\s+add\b/
];

var BUILD_PATTERNS = [
  /^webpack\b/,
  /^vite\s+build\b/,
  /^tsc(\s|$)/, // tsc, tsc --noEmit, tsc -b
  /^cargo\s+build\b/,
  /^go\s+build\b/,
  /^swc\b/,
  /^esbuild\b/
];

var DIFF_PATTERN = /^git\s+diff\b/;
var FIND_PATTERN = /^find\b/;
var CURL_PATTERN = /^curl\b/;

// Lines worth keeping in install/build output (warnings + errors).
var WARN_ERR_PATTERN = /\b(WARN|WARNING|warning|ERR|ERROR|error|err!)\b/;

// --- helpers -------------------------------------------------------------

function trimCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  // Strip leading "$ ", "sudo ", and surrounding whitespace.
  var s = cmd.replace(/^\s+/, '').replace(/^\$\s+/, '').replace(/^sudo\s+/, '');
  return s;
}

function matchesAny(patterns, cmd) {
  var s = trimCommand(cmd);
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(s)) return true;
  }
  return false;
}

function matches(pattern, cmd) {
  return pattern.test(trimCommand(cmd));
}

// --- filter classes ------------------------------------------------------

// Package install: keep first 5 lines + warn/err lines + last 3 lines.
function filterPackageInstall(output, cmd) {
  if (typeof output !== 'string') return output;
  if (!matchesAny(INSTALL_PATTERNS, cmd)) return output;
  if (output.length <= DEFAULT_THRESHOLD) return output;

  var lines = output.split('\n');
  var n = lines.length;
  var keep = new Array(n);
  for (var i = 0; i < INSTALL_HEAD && i < n; i++) keep[i] = true;
  for (var t = Math.max(0, n - INSTALL_TAIL); t < n; t++) keep[t] = true;
  for (var k = 0; k < n; k++) {
    if (WARN_ERR_PATTERN.test(lines[k])) keep[k] = true;
  }
  return joinKept(lines, keep, 'package-install');
}

// Build: keep error/warning lines + last 3 lines (final status).
function filterBuild(output, cmd) {
  if (typeof output !== 'string') return output;
  if (!matchesAny(BUILD_PATTERNS, cmd)) return output;
  if (output.length <= DEFAULT_THRESHOLD) return output;

  var lines = output.split('\n');
  var n = lines.length;
  var keep = new Array(n);
  for (var t = Math.max(0, n - BUILD_TAIL); t < n; t++) keep[t] = true;
  for (var k = 0; k < n; k++) {
    if (WARN_ERR_PATTERN.test(lines[k])) keep[k] = true;
  }
  // If nothing matched (no errors, no warnings) we still need head context
  // so the user knows what ran -- keep first line.
  var any = false;
  for (var x = 0; x < n; x++) if (keep[x]) { any = true; break; }
  if (!any && n > 0) keep[0] = true;
  return joinKept(lines, keep, 'build');
}

// Git diff: per-file keep header + first 100 lines, replace omitted
// per-file body with a single truncation marker line.
function filterGitDiff(output, cmd) {
  if (typeof output !== 'string') return output;
  if (!matches(DIFF_PATTERN, cmd)) return output;
  if (output.length <= DEFAULT_THRESHOLD) return output;

  var lines = output.split('\n');
  // Split into per-file blocks separated by "diff --git" headers.
  var out = [];
  var block = [];
  function flushBlock() {
    if (block.length === 0) return;
    if (block.length <= DIFF_LINES_PER_FILE) {
      for (var b = 0; b < block.length; b++) out.push(block[b]);
    } else {
      var keptCount = DIFF_LINES_PER_FILE;
      for (var b2 = 0; b2 < keptCount; b2++) out.push(block[b2]);
      var truncated = block.length - keptCount;
      out.push('[' + truncated + ' lines truncated, full diff in worktree]');
    }
    block = [];
  }
  for (var i = 0; i < lines.length; i++) {
    if (/^diff --git /.test(lines[i])) {
      flushBlock();
    }
    block.push(lines[i]);
  }
  flushBlock();
  return out.join('\n');
}

// Find: keep first 50 + last 10 + total count.
function filterFind(output, cmd) {
  if (typeof output !== 'string') return output;
  if (!matches(FIND_PATTERN, cmd)) return output;
  if (output.length <= DEFAULT_THRESHOLD) return output;

  var lines = output.split('\n');
  // Strip a single trailing empty line so the count reflects real entries.
  var hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();
  var n = lines.length;
  if (n <= FIND_HEAD + FIND_TAIL) return output;

  var head = lines.slice(0, FIND_HEAD);
  var tail = lines.slice(n - FIND_TAIL);
  var omitted = n - FIND_HEAD - FIND_TAIL;
  var marker = '[' + omitted + ' lines truncated, ' + n + ' total entries]';
  var result = head.concat([marker], tail).join('\n');
  if (hadTrailingNewline) result += '\n';
  return result;
}

// Curl: keep status + headers + first 1024 chars of body + truncation marker.
// Body is delimited from headers by the first blank line.
function filterCurl(output, cmd) {
  if (typeof output !== 'string') return output;
  if (!matches(CURL_PATTERN, cmd)) return output;
  if (output.length <= CURL_THRESHOLD) return output;

  // Split headers from body at the first "\r\n\r\n" or "\n\n".
  var sep = output.indexOf('\r\n\r\n');
  var sepLen = 4;
  if (sep === -1) {
    sep = output.indexOf('\n\n');
    sepLen = 2;
  }
  if (sep === -1) {
    // No header/body delimiter visible -- treat entire output as body.
    var tail = output.slice(0, CURL_BODY_BYTES);
    return tail + '\n[' + (output.length - CURL_BODY_BYTES) + ' bytes truncated, full body in worktree]';
  }
  var headers = output.slice(0, sep);
  var body = output.slice(sep + sepLen);
  if (body.length <= CURL_BODY_BYTES) return output;
  var keptBody = body.slice(0, CURL_BODY_BYTES);
  var omitted = body.length - CURL_BODY_BYTES;
  return headers + '\n\n' + keptBody +
    '\n[' + omitted + ' bytes truncated, full body in worktree]';
}

// --- shared join with skip markers ---------------------------------------

function joinKept(lines, keep, label) {
  var out = [];
  var lastKept = -1;
  for (var i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (lastKept >= 0 && i - lastKept > 1) {
        var skipped = i - lastKept - 1;
        out.push('... (' + skipped + ' lines filtered) ...');
      }
      out.push(lines[i]);
      lastKept = i;
    }
  }
  // If trailing lines were dropped, mark that too.
  if (lastKept >= 0 && lastKept < lines.length - 1) {
    var trailing = lines.length - 1 - lastKept;
    out.push('... (' + trailing + ' lines filtered) ...');
  }
  void label;
  return out.join('\n');
}

// --- top-level dispatch --------------------------------------------------

function applyFilter(output, cmd) {
  // Kill switch -- pass-through when token optimisation is disabled.
  if (process.env.FORGE_TOKEN_OPT === '0') return output;
  if (typeof output !== 'string') return output;

  if (matchesAny(INSTALL_PATTERNS, cmd)) return filterPackageInstall(output, cmd);
  if (matchesAny(BUILD_PATTERNS, cmd))   return filterBuild(output, cmd);
  if (matches(DIFF_PATTERN, cmd))        return filterGitDiff(output, cmd);
  if (matches(FIND_PATTERN, cmd))        return filterFind(output, cmd);
  if (matches(CURL_PATTERN, cmd))        return filterCurl(output, cmd);
  return output;
}

// --- hook entrypoint -----------------------------------------------------

function main() {
  var timer = setTimeout(function () { process.exit(0); }, TIMEOUT_MS);
  if (timer.unref) timer.unref();

  var chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) { chunks.push(chunk); });

  process.stdin.on('end', function () {
    clearTimeout(timer);
    try {
      var raw = chunks.join('');
      if (!raw.trim()) { process.exit(0); return; }

      var payload = JSON.parse(raw);
      var toolName = payload.tool_name || '';
      if (toolName !== 'Bash') { process.exit(0); return; }

      var toolInput = payload.tool_input || {};
      var command = toolInput.command || '';
      var toolOutput = payload.tool_output || '';
      if (typeof toolOutput !== 'string') { process.exit(0); return; }

      var filtered = applyFilter(toolOutput, command);
      if (filtered === toolOutput) { process.exit(0); return; }

      var header = '[Output Filtered: ' + toolOutput.length + ' chars -> ' +
                   filtered.length + ' chars]';
      var result = header + '\n' + filtered;

      var output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: result
        }
      };
      process.stdout.write(JSON.stringify(output) + '\n');
      process.exit(0);
    } catch (e) {
      process.exit(0);
    }
  });

  process.stdin.on('error', function () { process.exit(0); });
}

if (require.main === module) main();

// Export internals for unit tests.
module.exports = {
  applyFilter,
  filterPackageInstall,
  filterBuild,
  filterGitDiff,
  filterFind,
  filterCurl,
  INSTALL_PATTERNS,
  BUILD_PATTERNS,
  DIFF_PATTERN,
  FIND_PATTERN,
  CURL_PATTERN,
  DEFAULT_THRESHOLD,
  CURL_THRESHOLD
};
