#!/usr/bin/env node
// scripts/bench-caveman-writes.cjs
//
// T029 benchmark: measure character/token reduction from caveman formatting on
// the writeState and writeCheckpoint code paths. Writes 100 sample state
// updates and 100 sample checkpoints with and without the caveman transform,
// then reports the proxy token count (chars / 4) and the percent reduction.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('./forge-tools.cjs');
const { writeState, writeCheckpoint, readState, readCheckpoint } = tools;

const N = 100;

const SAMPLE_BODIES = [
  'I just finished implementing the registration endpoint. Basically, the endpoint accepts an email and a password, and it really validates them in order to ensure correctness before hashing the password with bcrypt.',
  'The reviewer noted that the validation logic should really be moved into a dedicated module. Please note that the existing tests cover the happy path but not the error cases.',
  'Added a new helper function to parse the YAML frontmatter. It handles a few edge cases that the previous implementation simply did not consider.',
  'I just modified the checkpoint writer in order to support partial updates. Prior to this change, every update required a full rewrite of the file.',
  'Basically, the issue was due to a race condition between the heartbeat writer and the lock acquisition. The fix utilizes an atomic rename to avoid the window.',
  'The benchmark really demonstrates that the new approach is approximately 30% faster than the previous one. In addition, memory usage is lower.',
  'Please note that this change modifies the public API. The old function signature is preserved for backward compatibility, but new callers should really use the new form.',
  'I just finished implementing tests for the edge cases. The tests cover the empty input case, the malformed input case, and the case where the file is just plain missing.',
  'The forensic recovery path was basically broken when the lock file was corrupted. I have just added a guard that detects this case and falls back to a clean state.',
  'In order to support multi-repo setups, the writer now accepts a repo tag in addition to the task id. This is essentially a no-op for single-repo projects.'
];

const SAMPLE_NOTES = [
  'I just really finished implementing the endpoint and it works correctly.',
  'The build basically failed due to a missing dependency in the lockfile.',
  'Please note that the validation logic was modified in order to handle the new edge case.',
  'I have implemented the helper and demonstrated that it works for approximately 95% of the test cases.',
  'The reviewer suggested that I should really move the parser into a dedicated module prior to landing this change.'
];

function tokens(s) {
  // Crude proxy: characters / 4. Good enough for relative comparisons.
  return Math.round(s.length / 4);
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bench-'));
  return dir;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

function runStateBench(skipCaveman) {
  const dir = makeTempDir();
  let totalBytes = 0;
  for (let i = 0; i < N; i++) {
    const body = SAMPLE_BODIES[i % SAMPLE_BODIES.length];
    writeState(dir, { phase: 'executing', iteration: i }, body, { skipCavemanFormat: skipCaveman });
    totalBytes += fileSize(path.join(dir, 'state.md'));
  }
  return totalBytes;
}

function runCheckpointBench(skipCaveman) {
  const dir = makeTempDir();
  let totalBytes = 0;
  for (let i = 0; i < N; i++) {
    const cp = {
      task_name: `sample task ${i}`,
      spec_domain: 'auth',
      current_step: 'implementation_started',
      next_step: 'tests_written',
      artifacts_produced: ['src/a.js', 'src/b.js'],
      context_bundle: {
        spec_section: 'R001',
        notes: SAMPLE_NOTES[i % SAMPLE_NOTES.length],
        background: SAMPLE_BODIES[i % SAMPLE_BODIES.length]
      },
      depth: 'standard',
      token_usage: 100 + i,
      error_log: [
        { ts: '2025-01-01T00:00:00Z', msg: SAMPLE_NOTES[(i + 1) % SAMPLE_NOTES.length] }
      ]
    };
    writeCheckpoint(dir, `T${String(i).padStart(3, '0')}`, cp, { skipCavemanFormat: skipCaveman });
    totalBytes += fileSize(path.join(dir, 'progress', `T${String(i).padStart(3, '0')}.json`));
  }
  return totalBytes;
}

function pct(a, b) {
  return ((1 - a / b) * 100).toFixed(1) + '%';
}

function fmt(label, verbose, caveman) {
  console.log(`\n${label}`);
  console.log(`  verbose:  ${verbose} bytes / ~${tokens(' '.repeat(verbose))} tokens`);
  console.log(`  caveman:  ${caveman} bytes / ~${tokens(' '.repeat(caveman))} tokens`);
  console.log(`  saved:    ${verbose - caveman} bytes (${pct(caveman, verbose)} reduction)`);
}

console.log('=== T029 caveman write-path benchmark ===');
console.log(`samples: ${N} state writes + ${N} checkpoint writes`);

const stateVerbose = runStateBench(true);
const stateCaveman = runStateBench(false);
fmt('state.md (cumulative file size after N writes)', stateVerbose, stateCaveman);

const cpVerbose = runCheckpointBench(true);
const cpCaveman = runCheckpointBench(false);
fmt('checkpoints/*.json (cumulative file size after N writes)', cpVerbose, cpCaveman);

const totalVerbose = stateVerbose + cpVerbose;
const totalCaveman = stateCaveman + cpCaveman;
fmt('TOTAL (state + checkpoints)', totalVerbose, totalCaveman);

// Prose-only measurement: pass each sample through formatCavemanValue directly
// and measure the reduction on just the free-text content. This isolates the
// transform from JSON/frontmatter structural overhead.
const { formatCavemanValue } = tools;
let proseVerbose = 0, proseCaveman = 0;
for (let i = 0; i < N; i++) {
  const body = SAMPLE_BODIES[i % SAMPLE_BODIES.length];
  const note = SAMPLE_NOTES[i % SAMPLE_NOTES.length];
  const all = body + '\n' + note;
  proseVerbose += all.length;
  proseCaveman += formatCavemanValue(all).length;
}
fmt('PROSE-ONLY (transform applied to free-text content)', proseVerbose, proseCaveman);

const overallReduction = (1 - totalCaveman / totalVerbose) * 100;
const proseReduction = (1 - proseCaveman / proseVerbose) * 100;
console.log('\n=== summary ===');
console.log(`overall file reduction: ${overallReduction.toFixed(1)}%  (state.md + checkpoints.json incl. structural overhead)`);
console.log(`prose-only reduction:   ${proseReduction.toFixed(1)}%  (the transform itself, on free-text only)`);
console.log(`target:                 >20% on prose-only path`);
console.log(`status:                 ${proseReduction >= 20 ? 'PASS' : 'FAIL'}`);
process.exit(proseReduction >= 20 ? 0 : 1);
