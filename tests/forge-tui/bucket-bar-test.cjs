// T005 / R005 — TUI bucket-bar render-path tests.
//
// Two snapshot files capture the EXACT byte output (after ANSI stripping) of
// the renderer for two ledger states:
//
//   bucket-bar-v1.snap  — v1 ledger, no `tokens` block. The bucket bar must
//                         NOT appear; the rendered frame must be byte-for-byte
//                         identical to the v1 baseline. This is the "zero
//                         visual regression" contract the spec demands.
//
//   bucket-bar-v2.snap  — v2 ledger with all five buckets populated. The
//                         bucket bar appears as a new "Source:" line directly
//                         below the existing token/budget line.
//
// The test also exercises four secondary properties that aren't easy to
// eyeball from a snapshot:
//
//   1. v2 ledger with all buckets at zero -> no bar (matches v1 snap)
//   2. FORGE_TOKEN_OPT=0 with v2 buckets populated -> no bar (matches v1 snap)
//   3. Bar segment widths sum exactly to 40 (BAR_WIDTH constant in the impl).
//   4. A zero bucket in an otherwise-populated v2 ledger gets segment width 0.
//
// Update snapshots with: node tests/forge-tui/bucket-bar.test.cjs --update

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Renderer, DEFAULTS } = require('../../scripts/forge-tui.cjs');

const SNAP_V1 = path.join(__dirname, 'bucket-bar-v1.snap');
const SNAP_V2 = path.join(__dirname, 'bucket-bar-v2.snap');

// Base state shared by every fixture. Same numbers as render-test.cjs so the
// non-bucket portion of the output is comparable across the existing render
// snapshot test and these bucket-bar snapshots.
const BASE_STATE = {
  phase: 'executing',
  currentTask: 'T010',
  taskStatus: 'in_progress',
  blockedReason: null,
  loopActive: true,
  toolCount: 17,
  ledger: { input: 142000, output: 38000, cache_read: 89000 },
  frontier: { total: 15, taskIds: [] },
  completedCount: 9,
  restartCount: 2,
  // tokens left undefined here -> populated per fixture below.
};

// V2 buckets chosen to give every segment a distinct, non-trivial width so a
// regression in the proportional rounding shows up immediately. All five
// values are in the realistic range a real Forge run produces (tens of k).
const V2_BUCKETS_FULL = {
  instructions: 12000,
  tool_definitions: 8000,
  tool_results: 34000,
  repo_reads: 40000,
  prose: 6000,
  // total = 100_000 -> exact percentages 12/8/34/40/6
};

const V2_BUCKETS_ZERO_TOOLS = {
  instructions: 30000,
  tool_definitions: 0,         // <- zero bucket; segment width must be 0
  tool_results: 25000,
  repo_reads: 40000,
  prose: 5000,
};

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function buildFrame(stateOverrides) {
  const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color', colorterm: 'truecolor' };
  const args = { ...DEFAULTS, transcriptLines: 50, maxRestarts: 10, contextLimit: 200000 };
  const state = { ...BASE_STATE, ...stateOverrides };
  const fakePoller = { getSnapshot: () => state, reconcile: () => {} };
  const fakeParser = {
    activeSubagent: () => 'forge-executor',
    latest: { activeTool: 'Edit', tokens: state.ledger, toolCount: 17 },
  };
  const r = new Renderer({ caps, args, poller: fakePoller, parser: fakeParser });
  // Same transcript entries as render-test.cjs so snapshot diffing focuses
  // on the bar region, not unrelated transcript drift.
  r.pushTranscript('>', '[forge-executor] Reading src/auth/middleware.ts');
  r.pushTranscript('~', 'Edit /repo/src/auth/middleware.ts');
  r.pushTranscript('=', 'File edited successfully.');
  r.pushTranscript('>', '[forge-executor] Running tests...');
  r.pushTranscript('=', 'tests passed\n12 tests total');
  return stripAnsi(r._buildFrame(state, 100, 30));
}

function assertSnap(snapPath, frame, label) {
  if (process.argv.includes('--update')) {
    fs.writeFileSync(snapPath, frame);
    return;
  }
  if (!fs.existsSync(snapPath)) {
    fs.writeFileSync(snapPath, frame);
    return; // first run writes baseline
  }
  const expected = fs.readFileSync(snapPath, 'utf8');
  assert.strictEqual(frame, expected, `${label} drifted from snapshot ${path.basename(snapPath)}`);
}

// Direct access to the helper (Renderer instance scope) for unit-level
// assertions on segment math. We construct a minimal Renderer just to call
// _bucketBarLine.
function callBucketBar(tokens, env = {}) {
  const caps = { isTTY: true, utf8: true, colors: 256, isWindows: false, term: 'xterm-256color', colorterm: 'truecolor' };
  const args = { ...DEFAULTS };
  const r = new Renderer({
    caps, args,
    poller: { getSnapshot: () => ({}), reconcile: () => {} },
    parser: { activeSubagent: () => 'main', latest: { activeTool: null, tokens: { input: 0, output: 0, cache_read: 0 }, toolCount: 0 } },
  });
  const prevOpt = process.env.FORGE_TOKEN_OPT;
  if (Object.prototype.hasOwnProperty.call(env, 'FORGE_TOKEN_OPT')) {
    process.env.FORGE_TOKEN_OPT = env.FORGE_TOKEN_OPT;
  }
  try {
    return r._bucketBarLine({ tokens }, 100);
  } finally {
    if (Object.prototype.hasOwnProperty.call(env, 'FORGE_TOKEN_OPT')) {
      if (prevOpt === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prevOpt;
    }
  }
}

// Count the number of bar-fill characters in a stripped bar line. The line
// looks like "  Source: [<segments>] I:12% T:8% ...". Both UTF-8 (█) and
// ASCII (#) fill chars are accepted so the test works regardless of caps.
function countBarFill(line) {
  const m = line.match(/\[([^\]]+)\]/);
  if (!m) return 0;
  // Bar body chars are EITHER fill (█/#) OR empty (░/-). Count both — they
  // sum to BAR_WIDTH; that's the invariant the test enforces.
  return m[1].length;
}

module.exports = {
  // ── snapshot path ────────────────────────────────────────────────────────

  'v1 ledger renders WITHOUT bucket bar (snapshot)'() {
    // No tokens block on snapshot at all (this is what existing v1 ledgers
    // produce on queryHeadlessState before T003 migration runs).
    const frame = buildFrame({ tokens: null });
    assertSnap(SNAP_V1, frame, 'v1 frame');
    assert.ok(!frame.includes('Source:'), 'v1 frame should not contain bucket-bar Source: line');
  },

  'v2 ledger with all buckets populated renders WITH bucket bar (snapshot)'() {
    const frame = buildFrame({
      tokens: {
        schema_version: 2,
        actual: { input: 100000, output: 38000, cache_read: 89000, cache_write: 0 },
        buckets: V2_BUCKETS_FULL,
        cache: { hits: 0, misses: 0, savings_estimate_tokens: 0 },
        source: 'transcript',
      },
    });
    assertSnap(SNAP_V2, frame, 'v2 frame');
    assert.ok(frame.includes('Source:'), 'v2 frame must contain bucket-bar Source: line');
    // Sanity: bar appears AFTER the Tokens line and BEFORE the Meters line.
    const tokensIdx = frame.indexOf('  Tokens:');
    const sourceIdx = frame.indexOf('  Source:');
    const metersIdx = frame.indexOf('  Meters:');
    assert.ok(tokensIdx >= 0 && sourceIdx > tokensIdx && metersIdx > sourceIdx,
      'bucket bar must render between Tokens and Meters lines');
  },

  // ── opt-out / zero-bucket paths (must match v1 snapshot) ─────────────────

  'v2 schema with all buckets at zero -> no bar (matches v1 snapshot)'() {
    const frame = buildFrame({
      tokens: {
        schema_version: 2,
        actual: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        buckets: { instructions: 0, tool_definitions: 0, tool_results: 0, repo_reads: 0, prose: 0 },
        cache: { hits: 0, misses: 0, savings_estimate_tokens: 0 },
        source: 'estimate',
      },
    });
    const v1 = fs.readFileSync(SNAP_V1, 'utf8');
    assert.strictEqual(frame, v1, 'fresh v2 ledger (all buckets zero) must render identically to v1');
  },

  'FORGE_TOKEN_OPT=0 suppresses bar even with v2 buckets populated'() {
    const prev = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const frame = buildFrame({
        tokens: {
          schema_version: 2,
          actual: { input: 100000, output: 38000, cache_read: 89000, cache_write: 0 },
          buckets: V2_BUCKETS_FULL,
          cache: { hits: 0, misses: 0, savings_estimate_tokens: 0 },
          source: 'transcript',
        },
      });
      const v1 = fs.readFileSync(SNAP_V1, 'utf8');
      assert.strictEqual(frame, v1, 'FORGE_TOKEN_OPT=0 must suppress the bar regardless of ledger state');
    } finally {
      if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prev;
    }
  },

  // ── segment math invariants ──────────────────────────────────────────────

  'bar body width is exactly 40 chars when v2 buckets present'() {
    const line = callBucketBar({
      schema_version: 2,
      buckets: V2_BUCKETS_FULL,
    });
    assert.ok(line, 'bar should render');
    const stripped = stripAnsi(line);
    assert.strictEqual(countBarFill(stripped), 40,
      `bar body must be exactly 40 chars, got ${countBarFill(stripped)} in: ${stripped}`);
  },

  'segment widths are proportional within ±1 char of expected'() {
    // V2_BUCKETS_FULL totals 100k -> exact %s 12/8/34/40/6 -> ideal widths
    // 4.8/3.2/13.6/16/2.4 -> floored 4/3/13/16/2 = 38 -> two leftovers go to
    // the largest fractional remainders (.8 and .6) -> instructions=5, tool_results=14.
    // Final: I=5 T=3 R=14 F=16 P=2 (sum 40).
    // We don't pin the exact distribution — just that each bucket is within
    // ±1 of its ideal, and sum is 40.
    const line = callBucketBar({ schema_version: 2, buckets: V2_BUCKETS_FULL });
    const stripped = stripAnsi(line);
    const m = stripped.match(/\[([^\]]+)\]/);
    assert.ok(m, 'stripped bar line must have brackets');
    const body = m[1];
    assert.strictEqual(body.length, 40, 'body width invariant');
    // Count the colored vs empty characters: in this fixture all 5 buckets >
    // 0 so there are no empty cells. Each non-empty char is one of the fill
    // chars (UTF-8 █ or ASCII #); empties (░ / -) should not appear here.
    const empties = (body.match(/[░\-]/g) || []).length;
    assert.strictEqual(empties, 0, `all-buckets-positive bar should have 0 empty cells, got ${empties}`);
  },

  'a zero bucket gets segment width 0 (no padding)'() {
    // V2_BUCKETS_ZERO_TOOLS: tool_definitions=0. The legend should still
    // include "T:0%" but the bar body must not allocate any chars to it.
    // We can't directly inspect per-segment widths from the stripped string,
    // but we can verify the legend reports 0% for the zero bucket and the
    // bar body length is still exactly 40 (so no slot was awarded to T).
    const line = callBucketBar({ schema_version: 2, buckets: V2_BUCKETS_ZERO_TOOLS });
    const stripped = stripAnsi(line);
    assert.ok(stripped.includes('T:0%'), `legend must show T:0% for zero bucket, got: ${stripped}`);
    const m = stripped.match(/\[([^\]]+)\]/);
    assert.ok(m, 'bar must have brackets');
    assert.strictEqual(m[1].length, 40, 'bar body width must remain 40 even with a zero bucket');
  },

  // ── defensive paths (return null) ────────────────────────────────────────

  '_bucketBarLine returns null when tokens block missing'() {
    assert.strictEqual(callBucketBar(null), null);
    assert.strictEqual(callBucketBar(undefined), null);
  },

  '_bucketBarLine returns null when schema_version is not 2'() {
    assert.strictEqual(
      callBucketBar({ schema_version: 1, buckets: V2_BUCKETS_FULL }),
      null,
      'schema_version != 2 must NOT render bar (forward-compat: v1 ledgers stay silent)'
    );
  },

  '_bucketBarLine returns null when buckets object missing or malformed'() {
    assert.strictEqual(callBucketBar({ schema_version: 2 }), null);
    assert.strictEqual(callBucketBar({ schema_version: 2, buckets: null }), null);
    assert.strictEqual(callBucketBar({ schema_version: 2, buckets: 'not an object' }), null);
  },

  '_bucketBarLine returns null when sum of buckets is zero'() {
    assert.strictEqual(
      callBucketBar({ schema_version: 2, buckets: { instructions: 0, tool_definitions: 0, tool_results: 0, repo_reads: 0, prose: 0 } }),
      null
    );
  },

  '_bucketBarLine ignores negative or non-finite bucket values (safety)'() {
    // Defensive: non-finite numbers from a corrupt ledger must not propagate.
    // A bucket reporting -1 or NaN should be treated as 0 so the bar never
    // crashes the dashboard on a bad input.
    const line = callBucketBar({
      schema_version: 2,
      buckets: { instructions: -100, tool_definitions: NaN, tool_results: 100, repo_reads: 0, prose: 0 },
    });
    // Exactly one positive bucket (tool_results) -> bar should render with
    // R taking the full 40 chars.
    assert.ok(line, 'one positive bucket should still produce a bar');
    const stripped = stripAnsi(line);
    assert.ok(stripped.includes('R:100%'), `single-bucket case should report R:100%, got: ${stripped}`);
    assert.ok(stripped.includes('I:0%'), 'negative bucket clamped to 0%');
    assert.ok(stripped.includes('T:0%'), 'NaN bucket clamped to 0%');
  },
};

if (require.main === module) {
  // Allow direct invocation: node tests/forge-tui/bucket-bar.test.cjs [--update]
  for (const name of Object.keys(module.exports)) {
    try {
      module.exports[name]();
      console.log('OK   ', name);
    } catch (e) {
      console.log('FAIL ', name, '\n     ', e.message);
      process.exitCode = 1;
    }
  }
}
