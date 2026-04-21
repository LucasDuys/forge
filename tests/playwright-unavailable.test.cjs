// tests/playwright-unavailable.test.cjs -- T021 / R005
//
// Negative-path harness for the Playwright-unavailable scenario.
// Spec: docs/superpowers/specs/spec-mock-and-visual-verify.md R005.
//
// What this exercises (end-to-end through the T017 completion-promise gates):
//
//   1. Clone mock-projects/blurry-graph/ into os.tmpdir() so the test never
//      mutates the shipped fixture.
//   2. Seed the clone's .forge/ with a state.md (task_status: pending) plus a
//      completion-gates.json where the visual AC is `status: blocked` and
//      `detail: playwright_unavailable: Install Playwright MCP: claude mcp
//      add playwright -- npx @playwright/mcp@latest` -- this is the payload
//      the visual verifier (T020) writes when FORGE_DISABLE_PLAYWRIGHT=1
//      short-circuits browser acquisition. The fixture-based approach keeps
//      this test independent of T020's verifier implementation while still
//      covering the full T017 gating surface.
//   3. Invoke `node scripts/forge-tools.cjs completion-check` with
//      FORGE_DISABLE_PLAYWRIGHT=1 in env and assert:
//        - exit code 3 (gates-failed, distinct from code 2 = internal error)
//        - stdout JSON has { complete:false, gates.visual:false }
//        - reasons[0].gate === "visual"
//        - reasons[0].detail contains "playwright_unavailable"
//        - reasons[0].detail contains "claude mcp add playwright" (the
//          actionable guidance string mandated by R005 AC3)
//   4. Invoke `completion-emit` and assert the wire form starts with
//      `<promise>FORGE_BLOCKED</promise>` and does NOT contain
//      `<promise>FORGE_COMPLETE</promise>`.
//   5. Assert state.md's task_status frontmatter is untouched by the CLI
//      (the gates are a read-only check; a failed check must not mark the
//      task complete -- R005 AC2).
//   6. Inverse path: with the same mock clone but the visual AC flipped to
//      `status: pass`, completion-emit must return FORGE_COMPLETE and exit 0.
//   7. Cleanup runs in afterEach -- no temp dir survives the test run.
//
// Does NOT edit scripts/forge-tools.cjs or agents/* -- T019 and T020 own
// those. This test exercises the existing T017 CLI surface against a
// gates.json payload that simulates the post-T020 BLOCKED state.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SRC = path.join(REPO_ROOT, 'mock-projects', 'blurry-graph');
const FORGE_TOOLS_CLI = path.join(REPO_ROOT, 'scripts', 'forge-tools.cjs');

// Actionable guidance string mandated by R005 AC3. Embedded in the gates
// fixture detail so the completion-check pass-through surfaces it to
// callers. Matches the spec verbatim.
const PLAYWRIGHT_GUIDANCE =
  'Install Playwright MCP: claude mcp add playwright -- npx @playwright/mcp@latest';

// Track clones so afterEach / process-exit cleanup always runs even if a
// test throws before its individual cleanup.
const _clones = [];

function cloneMock() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t021-'));
  _clones.push(dest);
  copyDirSync(MOCK_SRC, dest);
  return dest;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip node_modules / build output if the shipped fixture ever grows them.
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function rmClone(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// Seed the cloned mock's .forge/ with the minimum files completion-check
// reads: a frontier, a task registry, a state.md, and the authoritative
// completion-gates.json.
function seedCloneForgeDir(cloneRoot, opts) {
  opts = opts || {};
  const forgeDir = path.join(cloneRoot, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });

  // config.json -- empty is fine; completion-check does not require keys.
  fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({}, null, 2));

  // state.md -- simulate an in-progress execute cycle with task_status
  // pending. The test will read this file back after CLI invocations to
  // confirm it was not rewritten to task_status: complete.
  const stateMd = [
    '---',
    'phase: executing',
    'spec: 001-readable-graph',
    'current_task: T001',
    'task_status: pending',
    'iteration: 1',
    'tokens_used: 0',
    'tokens_budget: 200000',
    'depth: standard',
    'autonomy: full',
    'handoff_requested: false',
    'review_iterations: 0',
    'debug_attempts: 0',
    'blocked_reason: null',
    'lock_holder: null',
    'checkpoint_id: null',
    '---',
    '',
    "## What's Done",
    '',
    "## What's In-Flight",
    '- T001: visual verification (blocked on playwright)',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(forgeDir, 'state.md'), stateMd);

  // Frontier -- one task so the tasks gate has something to evaluate.
  const plansDir = path.join(forgeDir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '001-readable-graph-frontier.md'),
    [
      '---',
      'spec: 001-readable-graph',
      '---',
      '',
      '## Tier 1',
      '- [T001] readable nodes | est: ~3k tokens',
      ''
    ].join('\n')
  );

  // Task registry -- mark T001 DONE so the tasks gate passes; failure in
  // this test must originate from the visual gate, not tasks.
  const registry = {
    tasks: {
      T001: { status: 'DONE', completed_at: new Date().toISOString(), commit: 'deadbeef' }
    },
    last_updated: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(forgeDir, 'task-status.json'),
    JSON.stringify(registry, null, 2)
  );

  // completion-gates.json -- authoritative AC source consumed by
  // checkCompletionGates (T017). The visualStatus and visualDetail knobs
  // let us flip between the negative and inverse paths from the same
  // helper.
  const visualStatus = opts.visualStatus || 'blocked';
  const visualDetail = opts.visualDetail || (
    `playwright_unavailable: ${PLAYWRIGHT_GUIDANCE}`
  );
  const gatesPayload = {
    visual: [
      {
        id: 'R001.AC1',
        task_id: 'T001',
        status: visualStatus,
        detail: visualStatus === 'pass' ? undefined : visualDetail
      }
    ],
    nonvisual: [
      { id: 'R001.AC2', task_id: 'T001', status: 'pass' }
    ]
  };
  fs.writeFileSync(
    path.join(forgeDir, 'completion-gates.json'),
    JSON.stringify(gatesPayload, null, 2)
  );

  return forgeDir;
}

// Invoke a forge-tools.cjs subcommand as a child process so we exercise
// the real CLI contract (exit codes, stdout/stderr separation) rather
// than the in-process function. Env is merged so FORGE_DISABLE_PLAYWRIGHT=1
// is live for the child even when the parent did not set it.
function runCli(cloneRoot, subcommand, extraEnv) {
  const forgeDir = path.join(cloneRoot, '.forge');
  let exit = 0;
  let stdout = '';
  let stderr = '';
  const env = Object.assign({}, process.env, extraEnv || {});
  try {
    stdout = execFileSync(
      process.execPath,
      [FORGE_TOOLS_CLI, subcommand, '--forge-dir', forgeDir],
      { cwd: cloneRoot, encoding: 'utf8', env }
    );
  } catch (e) {
    exit = e.status == null ? -1 : e.status;
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  let json = null;
  try { json = JSON.parse(stdout.trim()); } catch (_) { /* not every subcommand emits JSON */ }
  return { exit, stdout, stderr, json };
}

function readTaskStatusFromState(cloneRoot) {
  const text = fs.readFileSync(path.join(cloneRoot, '.forge', 'state.md'), 'utf8');
  const m = text.match(/^task_status:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

// Global belt-and-braces: if any test leaves a clone behind (e.g. uncaught
// throw), drop it on process exit.
process.on('exit', () => {
  for (const dir of _clones) rmClone(dir);
});

// ─── 1. Negative path: playwright unavailable → BLOCKED ───────────────────

suite('R005 -- Playwright unavailable yields BLOCKED, not COMPLETE', () => {
  let clone = null;

  // afterEach cleanup: each test owns its own clone, removed promptly so
  // a failure in one test never poisons the next.
  const cleanup = () => {
    if (clone) { rmClone(clone); clone = null; }
  };

  test('completion-check: exit 3, complete:false, gate=visual, detail=playwright_unavailable', () => {
    try {
      clone = cloneMock();
      seedCloneForgeDir(clone, { visualStatus: 'blocked' });

      const cli = runCli(clone, 'completion-check', { FORGE_DISABLE_PLAYWRIGHT: '1' });

      // Exit code 3 = gates failed (distinct from 2 = internal error).
      assert.strictEqual(cli.exit, 3,
        `expected exit 3 (gates failed), got ${cli.exit}. stderr:\n${cli.stderr}`);
      assert.ok(cli.json, 'stdout must be parseable JSON from completion-check');

      // Top-level shape.
      assert.strictEqual(cli.json.complete, false,
        'completion-check must report complete:false when visual AC is blocked');
      assert.ok(cli.stdout.includes('"complete":false'),
        'raw stdout must contain "complete":false');

      // Visual gate failed, others pass.
      assert.strictEqual(cli.json.gates.visual, false, 'visual gate must be false');
      assert.strictEqual(cli.json.gates.tasks, true, 'tasks gate must still be true');
      assert.strictEqual(cli.json.gates.nonvisual, true, 'nonvisual gate must still be true');
      assert.strictEqual(cli.json.gates.flags, true, 'flags gate must still be true');

      // First reason must be the visual gate with the playwright detail.
      assert.ok(Array.isArray(cli.json.reasons) && cli.json.reasons.length >= 1,
        'reasons[] must contain at least one entry');
      const first = cli.json.reasons[0];
      assert.strictEqual(first.gate, 'visual',
        `reasons[0].gate must be "visual", got "${first.gate}"`);
      assert.ok(
        first.detail && first.detail.includes('playwright_unavailable'),
        `reasons[0].detail must mention "playwright_unavailable"; got: ${first.detail}`
      );
      assert.ok(
        cli.stdout.includes('"gate":"visual"'),
        'raw stdout must contain "gate":"visual"'
      );
      assert.ok(
        cli.stdout.includes('"detail":') && cli.stdout.includes('playwright_unavailable'),
        'raw stdout must contain "detail":...playwright_unavailable...'
      );
    } finally {
      cleanup();
    }
  });

  test('completion-emit: stdout has FORGE_BLOCKED, not FORGE_COMPLETE', () => {
    try {
      clone = cloneMock();
      seedCloneForgeDir(clone, { visualStatus: 'blocked' });

      const cli = runCli(clone, 'completion-emit', { FORGE_DISABLE_PLAYWRIGHT: '1' });

      assert.strictEqual(cli.exit, 3,
        `completion-emit must exit 3 when gates fail; got ${cli.exit}. stderr:\n${cli.stderr}`);
      assert.ok(
        cli.stdout.includes('<promise>FORGE_BLOCKED</promise>'),
        `stdout must contain FORGE_BLOCKED; got:\n${cli.stdout}`
      );
      assert.ok(
        !cli.stdout.includes('<promise>FORGE_COMPLETE</promise>'),
        'stdout must NOT contain FORGE_COMPLETE when visual gate is blocked'
      );

      // The inline reasons JSON on the second line must also carry the
      // playwright_unavailable detail so downstream tooling (stop hook,
      // TUI) can render the specific reason.
      const jsonLine = cli.stdout.split('\n').find(l => l.startsWith('{'));
      assert.ok(jsonLine, 'emission must include an inline reasons JSON line');
      const parsed = JSON.parse(jsonLine);
      assert.ok(Array.isArray(parsed.reasons) && parsed.reasons.length >= 1,
        'parsed.reasons must be a non-empty array');
      assert.strictEqual(parsed.reasons[0].gate, 'visual');
      assert.ok(
        parsed.reasons[0].detail.includes('playwright_unavailable'),
        'inline reasons JSON must surface playwright_unavailable'
      );
    } finally {
      cleanup();
    }
  });

  test('R005 AC2: state.md task_status is NOT mutated to "complete" by a failed check', () => {
    try {
      clone = cloneMock();
      seedCloneForgeDir(clone, { visualStatus: 'blocked' });

      const before = readTaskStatusFromState(clone);
      assert.strictEqual(before, 'pending',
        'sanity: fixture must start with task_status: pending');

      // Both CLIs are side-effect-free wrt state.md. Invoke both in the
      // same test so a future regression that writes back from either
      // command is caught here.
      runCli(clone, 'completion-check', { FORGE_DISABLE_PLAYWRIGHT: '1' });
      runCli(clone, 'completion-emit', { FORGE_DISABLE_PLAYWRIGHT: '1' });

      const after = readTaskStatusFromState(clone);
      assert.strictEqual(after, 'pending',
        `state.md task_status must be unchanged after a BLOCKED check; got "${after}"`);
      assert.notStrictEqual(after, 'complete',
        'state.md task_status must NEVER be "complete" after a visual-gate failure');
    } finally {
      cleanup();
    }
  });

  test('R005 AC3: actionable guidance "claude mcp add playwright" is surfaced to callers', () => {
    try {
      clone = cloneMock();
      seedCloneForgeDir(clone, { visualStatus: 'blocked' });

      // The guidance string may reach the caller via stderr, stdout JSON
      // reasons, or the emit payload -- per spec R005 AC3 "stderr or a
      // guidance field". Accept any of the three channels so this test
      // is robust across T020's final implementation choice.
      const check = runCli(clone, 'completion-check', { FORGE_DISABLE_PLAYWRIGHT: '1' });
      const emit = runCli(clone, 'completion-emit', { FORGE_DISABLE_PLAYWRIGHT: '1' });

      const combined = [
        check.stdout, check.stderr,
        emit.stdout, emit.stderr
      ].join('\n');

      assert.ok(
        combined.includes('claude mcp add playwright'),
        `expected "claude mcp add playwright" guidance in CLI output; got:\n${combined}`
      );
    } finally {
      cleanup();
    }
  });
});

// ─── 2. Inverse path: playwright available + visual pass → COMPLETE ───────

suite('R005 inverse -- visual ACs pass, FORGE_COMPLETE is reached', () => {
  let clone = null;
  const cleanup = () => {
    if (clone) { rmClone(clone); clone = null; }
  };

  test('completion-emit: stdout has FORGE_COMPLETE, exit 0, when visual AC is pass', () => {
    try {
      clone = cloneMock();
      // Flip the visual AC to pass. We deliberately leave the env var
      // unset here (simulating Playwright available) -- checkCompletionGates
      // does not itself inspect FORGE_DISABLE_PLAYWRIGHT, so flipping
      // the fixture's AC status is what drives the branch.
      seedCloneForgeDir(clone, { visualStatus: 'pass' });

      const cli = runCli(clone, 'completion-emit', {});
      assert.strictEqual(cli.exit, 0,
        `completion-emit must exit 0 when all gates pass; got ${cli.exit}. stderr:\n${cli.stderr}`);
      assert.ok(
        cli.stdout.includes('<promise>FORGE_COMPLETE</promise>'),
        `stdout must contain FORGE_COMPLETE when all gates pass; got:\n${cli.stdout}`
      );
      assert.ok(
        !cli.stdout.includes('<promise>FORGE_BLOCKED</promise>'),
        'stdout must NOT contain FORGE_BLOCKED when all gates pass'
      );

      // And completion-check exits 0 with complete:true.
      const check = runCli(clone, 'completion-check', {});
      assert.strictEqual(check.exit, 0);
      assert.ok(check.json && check.json.complete === true);
      assert.strictEqual(check.json.gates.visual, true);
    } finally {
      cleanup();
    }
  });
});

runTests();
