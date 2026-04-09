#!/usr/bin/env node
// PostToolUse hook -- filters test output to show only failures + summary
// Matcher: "Bash"
//
// Reads PostToolUse JSON from stdin. If the tool was a Bash invocation running
// a recognised test runner and the output exceeds 2000 chars, replaces the
// output with a condensed view: failure blocks with context + summary tail.
// Outputs nothing (exit 0) when not applicable -- zero context cost.

'use strict';

// --- constants -----------------------------------------------------------

var CHAR_THRESHOLD = 2000;
var CONTEXT_LINES = 8;
var SUMMARY_TAIL = 10;
var TIMEOUT_MS = 3000;

// Test runner patterns matched against the beginning of the command string.
// Order does not matter -- first match wins.
var TEST_COMMANDS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bnpm\s+test\b/,
  /\bnpx\s+test\b/,
  /\bmocha\b/
];

// Lines that signal a failure -- kept case-insensitive where noted.
var FAILURE_PATTERNS = [
  /\bFAIL\b/i,
  /\bFAILED\b/i,
  /\bERROR\b/i,
  /AssertionError/,
  /AssertError/,
  /TypeError/,
  /ReferenceError/,
  /Expected[\s\S]*Received/,
  /^>/,                  // code-frame pointer
  /\bnot ok\b/           // TAP format failure
];

// Lines that are passing noise -- skip these during filtering.
var PASS_PATTERNS = [
  /^\s*[✓✔]\s/,         // checkmark reporters
  /\bPASS\b/,
  /^\s*ok\s+\d+/,       // TAP pass
  /^\.+$/                // dot reporter
];

// --- helpers -------------------------------------------------------------

function isTestCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  for (var i = 0; i < TEST_COMMANDS.length; i++) {
    if (TEST_COMMANDS[i].test(cmd)) return true;
  }
  return false;
}

function isFailureLine(line) {
  for (var i = 0; i < FAILURE_PATTERNS.length; i++) {
    if (FAILURE_PATTERNS[i].test(line)) return true;
  }
  return false;
}

function isPassLine(line) {
  for (var i = 0; i < PASS_PATTERNS.length; i++) {
    if (PASS_PATTERNS[i].test(line)) return true;
  }
  return false;
}

// --- main ----------------------------------------------------------------

function main() {
  // Safety timeout -- never block the flow for more than 3 seconds
  var timer = setTimeout(function () {
    process.exit(0);
  }, TIMEOUT_MS);
  // Allow the process to exit naturally even if the timer is pending
  if (timer.unref) timer.unref();

  var chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    chunks.push(chunk);
  });

  process.stdin.on('end', function () {
    clearTimeout(timer);
    try {
      var raw = chunks.join('');
      if (!raw.trim()) {
        process.exit(0);
        return;
      }

      var payload = JSON.parse(raw);

      // Only act on Bash tool invocations
      var toolName = payload.tool_name || '';
      if (toolName !== 'Bash') {
        process.exit(0);
        return;
      }

      // Extract command and output
      var toolInput = payload.tool_input || {};
      var command = toolInput.command || '';
      var toolOutput = payload.tool_output || '';

      if (!isTestCommand(command)) {
        process.exit(0);
        return;
      }

      // Small outputs pass through unchanged -- not worth filtering
      if (toolOutput.length <= CHAR_THRESHOLD) {
        process.exit(0);
        return;
      }

      // --- filter the output -----------------------------------------------
      var lines = toolOutput.split('\n');
      var originalCount = lines.length;

      // Mark failure lines and their context windows
      var keep = {};
      for (var i = 0; i < lines.length; i++) {
        if (isFailureLine(lines[i]) && !isPassLine(lines[i])) {
          var start = Math.max(0, i - CONTEXT_LINES);
          var end = Math.min(lines.length - 1, i + CONTEXT_LINES);
          for (var j = start; j <= end; j++) {
            keep[j] = true;
          }
        }
      }

      // Always keep the summary tail (last N lines)
      var tailStart = Math.max(0, lines.length - SUMMARY_TAIL);
      for (var t = tailStart; t < lines.length; t++) {
        keep[t] = true;
      }

      // Build filtered output with separator markers for skipped regions
      var filtered = [];
      var lastKept = -1;
      for (var k = 0; k < lines.length; k++) {
        if (keep[k]) {
          if (lastKept >= 0 && k - lastKept > 1) {
            var skipped = k - lastKept - 1;
            filtered.push('  ... (' + skipped + ' lines filtered) ...');
          }
          filtered.push(lines[k]);
          lastKept = k;
        }
      }

      var filteredCount = filtered.length;

      // Build header
      var header = '[Test Output Filtered: ' + originalCount + ' lines -> ' + filteredCount + ' lines (showing failures + summary)]';
      var result = header + '\n' + filtered.join('\n');

      // Produce hook output
      var output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: result
        }
      };

      process.stdout.write(JSON.stringify(output) + '\n');
      process.exit(0);

    } catch (e) {
      // Graceful degradation -- never break the flow
      process.exit(0);
    }
  });

  process.stdin.on('error', function () {
    process.exit(0);
  });
}

main();
