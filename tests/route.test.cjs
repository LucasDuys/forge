// tests/route.test.cjs -- routeDecision + budget gating (T010, R003)

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const {
  checkSessionBudget,
  writeBudgetExhaustedHandoff,
  routeDecision,
  loadConfig,
  writeState,
  writeLedgerAtomic
} = tools;

suite('checkSessionBudget', () => {
  test('returns null when ledger total < session_budget_tokens', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: { session_budget_tokens: 10000, max_iterations: 100 }
    });
    writeLedgerAtomic(forgeDir, { total: 100, iterations: 1, per_spec: {}, last_transcript_tokens: 0, tasks: {} });
    const cfg = loadConfig(projectDir);
    assert.strictEqual(checkSessionBudget(forgeDir, cfg, 5), null);
  });

  test('returns session_budget_exhausted when total >= ceiling', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: { session_budget_tokens: 1000, max_iterations: 100 }
    });
    writeLedgerAtomic(forgeDir, { total: 1500, iterations: 5, per_spec: {}, last_transcript_tokens: 0, tasks: {} });
    const cfg = loadConfig(projectDir);
    const r = checkSessionBudget(forgeDir, cfg, 5);
    assert.ok(r);
    assert.strictEqual(r.exhausted, true);
    assert.strictEqual(r.type, 'session_budget_exhausted');
    assert.strictEqual(r.ceiling, 1000);
  });

  test('returns iteration_budget_exhausted when iteration >= max', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: { session_budget_tokens: 1000000, max_iterations: 10 }
    });
    const cfg = loadConfig(projectDir);
    const r = checkSessionBudget(forgeDir, cfg, 10);
    assert.ok(r);
    assert.strictEqual(r.type, 'iteration_budget_exhausted');
    assert.strictEqual(r.ceiling, 10);
  });

  test('legacy token_budget fallback honored when no session_budget_tokens', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: { token_budget: 500, max_iterations: 100 }
    });
    writeLedgerAtomic(forgeDir, { total: 600, iterations: 1, per_spec: {}, last_transcript_tokens: 0, tasks: {} });
    const cfg = loadConfig(projectDir);
    const r = checkSessionBudget(forgeDir, cfg, 1);
    assert.ok(r);
    assert.strictEqual(r.type, 'session_budget_exhausted');
    assert.strictEqual(r.ceiling, 500);
  });
});

suite('writeBudgetExhaustedHandoff', () => {
  test('writes resume.md with caveman fragments and no em dashes', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = writeBudgetExhaustedHandoff(
      forgeDir,
      { type: 'session_budget_exhausted', ceiling: 500000, total: 510000 },
      { phase: 'executing', spec: 'auth', current_task: 'T005', last_completed_task: 'T004', next_pending_task: 'T006' }
    );
    assert.strictEqual(r.written, true);
    const text = fs.readFileSync(path.join(forgeDir, 'resume.md'), 'utf8');
    assert.match(text, /budget exhausted/);
    assert.match(text, /reason -> session_budget_exhausted/);
    assert.match(text, /current task -> T005/);
    assert.match(text, /no spec gap/);
    // No em dashes (R013 caveman form requires plain ASCII)
    assert.ok(!text.includes('\u2014'), 'resume.md must not contain em dashes');
  });

  test('iteration variant suggests raising max_iterations', () => {
    const { forgeDir } = makeTempForgeDir();
    writeBudgetExhaustedHandoff(
      forgeDir,
      { type: 'iteration_budget_exhausted', ceiling: 100, total: 100 },
      { phase: 'executing' }
    );
    const text = fs.readFileSync(path.join(forgeDir, 'resume.md'), 'utf8');
    assert.match(text, /raise max_iterations/);
  });
});

suite('routeDecision short-circuits', () => {
  test('exits when phase already = budget_exhausted', () => {
    const { forgeDir } = makeTempForgeDir();
    writeState(forgeDir, {
      phase: 'budget_exhausted',
      budget_exhausted_reason: 'session_budget_exhausted',
      iteration: 1
    });
    const r = routeDecision(forgeDir, 1, null);
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.reason, 'session_budget_exhausted');
  });

  test('enters budget_exhausted when ledger over ceiling on first call', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: { session_budget_tokens: 100, max_iterations: 100 }
    });
    writeLedgerAtomic(forgeDir, { total: 200, iterations: 1, per_spec: {}, last_transcript_tokens: 0, tasks: {} });
    writeState(forgeDir, { phase: 'executing', iteration: 1 });
    const r = routeDecision(forgeDir, 1, null);
    assert.strictEqual(r.action, 'exit');
    assert.match(r.reason, /budget_exhausted/);
    // resume.md should have been written
    assert.ok(fs.existsSync(path.join(forgeDir, 'resume.md')));
  });
});

suite('context-reset self-resume', () => {
  // Builds a transcript file of a target byte size so the estimator
  // (size / 4 / window * 100) hits the desired percent. Keep windows small
  // so we don't need to write huge files.

  function writeFakeTranscript(projectDir, bytes) {
    const p = path.join(projectDir, 'transcript.jsonl');
    fs.writeFileSync(p, 'x'.repeat(bytes));
    return p;
  }

  test('configurable window: 1M context does not trigger reset at 480KB', () => {
    // 480KB transcript → /4 → 120k tokens → /1M → 12% → below 60% threshold
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: {
        context_window_tokens: 1000000,
        session_budget_tokens: 10000000,
        token_budget: 10000000,
        max_iterations: 100
      }
    });
    writeState(forgeDir, { phase: 'executing', iteration: 1, handoff_requested: false });
    const tp = writeFakeTranscript(projectDir, 480000);
    const r = routeDecision(forgeDir, 1, tp);
    // We expect to NOT hit the context-reset branch (which would return the
    // save-handoff prompt). Any non-reset return is fine.
    assert.ok(typeof r !== 'string' || !/Context approaching limit/.test(r),
      'must not trigger reset on 1M window with 480KB transcript');
  });

  test('200k window does trigger reset at 480KB (baseline)', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: {
        context_window_tokens: 200000,
        session_budget_tokens: 10000000,
        token_budget: 10000000,
        max_iterations: 100
      }
    });
    writeState(forgeDir, { phase: 'executing', iteration: 1, handoff_requested: false });
    const tp = writeFakeTranscript(projectDir, 480000);
    const r = routeDecision(forgeDir, 1, tp);
    assert.strictEqual(typeof r, 'string');
    assert.match(r, /Context approaching limit/);
  });

  test('FORGE_CONTEXT_WINDOW env var overrides config', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: {
        context_window_tokens: 200000,
        session_budget_tokens: 10000000,
        token_budget: 10000000,
        max_iterations: 100
      }
    });
    writeState(forgeDir, { phase: 'executing', iteration: 1, handoff_requested: false });
    const tp = writeFakeTranscript(projectDir, 480000);
    const prev = process.env.FORGE_CONTEXT_WINDOW;
    process.env.FORGE_CONTEXT_WINDOW = '1000000';
    try {
      const r = routeDecision(forgeDir, 1, tp);
      assert.ok(typeof r !== 'string' || !/Context approaching limit/.test(r),
        'env var must override config to prevent reset');
    } finally {
      if (prev === undefined) delete process.env.FORGE_CONTEXT_WINDOW;
      else process.env.FORGE_CONTEXT_WINDOW = prev;
    }
  });

  test('second reset trigger returns resume prompt, clears flag, writes file', () => {
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: {
        context_window_tokens: 200000,
        session_budget_tokens: 10000000,
        token_budget: 10000000,
        max_iterations: 100
      }
    });
    // Pre-state: handoff already requested (i.e. we're on the 2nd pass)
    writeState(forgeDir, {
      phase: 'executing',
      iteration: 2,
      handoff_requested: true,
      spec: 'ctx',
      current_task: 'T001'
    });
    const tp = writeFakeTranscript(projectDir, 480000);
    const r = routeDecision(forgeDir, 2, tp);

    // Returns a non-empty string containing the resume-prompt signature
    assert.strictEqual(typeof r, 'string');
    assert.ok(r.length > 0, 'return must be non-empty');
    assert.match(r, /resuming a Forge execution session/);

    // .forge-resume.md written with same content
    const resumePath = path.join(forgeDir, '.forge-resume.md');
    assert.ok(fs.existsSync(resumePath));
    const fileContent = fs.readFileSync(resumePath, 'utf8');
    assert.match(fileContent, /resuming a Forge execution session/);

    // handoff_requested flag cleared so the loop doesn't re-fire
    const state2 = tools.readState(forgeDir);
    assert.strictEqual(state2.data.handoff_requested, false);
  });

  test('handoff_requested branch outside threshold also self-resumes', () => {
    // Small transcript, below threshold, but handoff_requested already true
    // → the standalone "Handoff was requested and completed" branch fires.
    const { forgeDir, projectDir } = makeTempForgeDir({
      config: {
        context_window_tokens: 1000000,
        session_budget_tokens: 10000000,
        token_budget: 10000000,
        max_iterations: 100
      }
    });
    writeState(forgeDir, {
      phase: 'executing',
      iteration: 3,
      handoff_requested: true,
      spec: 'ctx',
      current_task: 'T002'
    });
    const tp = writeFakeTranscript(projectDir, 1000); // tiny, under any threshold
    const r = routeDecision(forgeDir, 3, tp);
    assert.strictEqual(typeof r, 'string');
    assert.match(r, /resuming a Forge execution session/);
    const state2 = tools.readState(forgeDir);
    assert.strictEqual(state2.data.handoff_requested, false);
  });
});

runTests();
