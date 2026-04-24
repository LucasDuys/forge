// tests/transcripts.test.cjs -- T008 / R014
//
// Exercises appendTranscript + readTranscript + the `transcript-append` CLI
// bridge. The critical invariants (per R014 ACs):
//
//   1. Every agent invocation appends one JSONL line with the canonical shape
//      { phase, agent, task_id, tool_calls_count, duration_ms, status, summary }.
//   2. Timestamps (`at`) appear ONLY on phase-boundary lines, never on
//      per-entry lines.
//   3. A deterministic mock execute cycle (fixed `opts.now` for each boundary)
//      produces byte-identical transcripts across repeated runs.
//   4. The cycle directory is auto-created on first append.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');
const { appendTranscript, readTranscript } = tools;

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS_CJS = path.join(REPO_ROOT, 'scripts', 'forge-tools.cjs');

// ─── fixtures ────────────────────────────────────────────────────────────

function sampleEntry(overrides) {
  return Object.assign({
    phase: 'executing',
    agent: 'forge-executor',
    task_id: 'T001',
    tool_calls_count: 3,
    duration_ms: 1200,
    status: 'DONE',
    summary: 'did the thing'
  }, overrides || {});
}

// Run a deterministic mock cycle: planner plans, executor implements, reviewer
// reviews. Fixed `now` on every phase transition so the output is stable
// across repeated runs.
function runMockCycle(forgeDir, cycleId) {
  const T1 = '2026-04-20T00:00:00.000Z';
  const T2 = '2026-04-20T00:01:00.000Z';
  const T3 = '2026-04-20T00:02:00.000Z';

  appendTranscript(forgeDir, cycleId, sampleEntry({
    phase: 'planning', agent: 'forge-planner', task_id: 'T001',
    tool_calls_count: 2, duration_ms: 800, status: 'DONE',
    summary: 'planned T001'
  }), { now: T1 });

  appendTranscript(forgeDir, cycleId, sampleEntry({
    phase: 'planning', agent: 'forge-planner', task_id: 'T002',
    tool_calls_count: 2, duration_ms: 700, status: 'DONE',
    summary: 'planned T002'
  }));

  appendTranscript(forgeDir, cycleId, sampleEntry({
    phase: 'executing', agent: 'forge-executor', task_id: 'T001',
    tool_calls_count: 10, duration_ms: 5000, status: 'DONE',
    summary: 'impl T001'
  }), { now: T2 });

  appendTranscript(forgeDir, cycleId, sampleEntry({
    phase: 'executing', agent: 'forge-executor', task_id: 'T002',
    tool_calls_count: 8, duration_ms: 4500, status: 'DONE',
    summary: 'impl T002'
  }));

  appendTranscript(forgeDir, cycleId, sampleEntry({
    phase: 'reviewing', agent: 'forge-reviewer', task_id: 'T001',
    tool_calls_count: 4, duration_ms: 1800, status: 'DONE',
    summary: 'reviewed T001'
  }), { now: T3 });
}

// ─── tests ───────────────────────────────────────────────────────────────

suite('appendTranscript: shape + basics', () => {
  test('writes a single JSONL line with the canonical shape', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = appendTranscript(forgeDir, 'c1', sampleEntry(), { now: '2026-04-20T00:00:00Z' });
    assert.strictEqual(r.entryWritten, true);
    const file = path.join(forgeDir, 'history', 'cycles', 'c1', 'transcript.jsonl');
    assert.ok(fs.existsSync(file), 'transcript file was not created');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // First line is the boundary (first entry triggers one), second is the entry.
    assert.strictEqual(lines.length, 2);
    const boundary = JSON.parse(lines[0]);
    const entry = JSON.parse(lines[1]);
    assert.strictEqual(boundary.phase, 'boundary');
    assert.strictEqual(boundary.at, '2026-04-20T00:00:00Z');
    assert.strictEqual(entry.phase, 'executing');
    assert.strictEqual(entry.agent, 'forge-executor');
    assert.strictEqual(entry.task_id, 'T001');
    assert.strictEqual(entry.tool_calls_count, 3);
    assert.strictEqual(entry.duration_ms, 1200);
    assert.strictEqual(entry.status, 'DONE');
    assert.strictEqual(entry.summary, 'did the thing');
    // Critically: no timestamp on the entry line.
    assert.ok(!('at' in entry), 'per-entry lines must not carry a timestamp');
  });

  test('auto-creates the cycle directory on first append', () => {
    const { forgeDir } = makeTempForgeDir();
    const cycleDir = path.join(forgeDir, 'history', 'cycles', 'freshcycle');
    assert.ok(!fs.existsSync(cycleDir), 'precondition: cycle dir does not exist');
    appendTranscript(forgeDir, 'freshcycle', sampleEntry(), { now: '2026-04-20T00:00:00Z' });
    assert.ok(fs.existsSync(cycleDir), 'cycle dir should be auto-created');
    assert.ok(fs.existsSync(path.join(cycleDir, 'transcript.jsonl')));
  });

  test('rejects entries that include "at"', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(
      () => appendTranscript(forgeDir, 'c1', Object.assign(sampleEntry(), { at: '2026-04-20T00:00:00Z' })),
      /must not include "at"/
    );
  });

  test('rejects missing phase', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(
      () => appendTranscript(forgeDir, 'c1', { agent: 'x', task_id: 'T1' }),
      /phase is required/
    );
  });

  test('rejects invalid cycleId (path traversal guard)', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(() => appendTranscript(forgeDir, '../evil', sampleEntry()), /invalid cycleId/);
    assert.throws(() => appendTranscript(forgeDir, 'a/b', sampleEntry()), /invalid cycleId/);
    assert.throws(() => appendTranscript(forgeDir, '', sampleEntry()), /cycleId is required/);
  });
});

suite('appendTranscript: phase-boundary rules', () => {
  test('emits exactly one boundary line per phase transition', () => {
    const { forgeDir } = makeTempForgeDir();
    runMockCycle(forgeDir, 'c1');
    const text = fs.readFileSync(path.join(forgeDir, 'history', 'cycles', 'c1', 'transcript.jsonl'), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const boundaries = lines.filter((l) => JSON.parse(l).phase === 'boundary');
    const entries = lines.filter((l) => JSON.parse(l).phase !== 'boundary');
    // planning -> executing -> reviewing = 3 transitions (first entry also
    // triggers an initial boundary since the file was empty).
    assert.strictEqual(boundaries.length, 3, 'expected 3 boundary lines, got ' + boundaries.length);
    assert.strictEqual(entries.length, 5, 'expected 5 entry lines, got ' + entries.length);
  });

  test('no boundary line emitted when the phase does not change', () => {
    const { forgeDir } = makeTempForgeDir();
    appendTranscript(forgeDir, 'c1', sampleEntry({ phase: 'executing', task_id: 'T001' }), { now: '2026-04-20T00:00:00Z' });
    const r = appendTranscript(forgeDir, 'c1', sampleEntry({ phase: 'executing', task_id: 'T002' }));
    assert.strictEqual(r.boundaryWritten, false, 'no boundary on same-phase continuation');
    assert.strictEqual(r.entryWritten, true);
  });

  test('caller-supplied boundary line is written verbatim', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = appendTranscript(forgeDir, 'c1', { phase: 'boundary', at: '2026-04-20T12:34:56Z' });
    assert.strictEqual(r.boundaryWritten, true);
    assert.strictEqual(r.entryWritten, false);
    const lines = fs.readFileSync(path.join(forgeDir, 'history', 'cycles', 'c1', 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const b = JSON.parse(lines[0]);
    assert.strictEqual(b.phase, 'boundary');
    assert.strictEqual(b.at, '2026-04-20T12:34:56Z');
  });

  test('caller-supplied boundary without "at" is rejected', () => {
    const { forgeDir } = makeTempForgeDir();
    assert.throws(
      () => appendTranscript(forgeDir, 'c1', { phase: 'boundary' }),
      /boundary entry must include "at"/
    );
  });
});

suite('appendTranscript: deterministic diffs', () => {
  test('two runs of the same mock cycle produce byte-identical transcripts', () => {
    const a = makeTempForgeDir();
    const b = makeTempForgeDir();
    runMockCycle(a.forgeDir, 'stable-cycle');
    runMockCycle(b.forgeDir, 'stable-cycle');
    const textA = fs.readFileSync(path.join(a.forgeDir, 'history', 'cycles', 'stable-cycle', 'transcript.jsonl'), 'utf8');
    const textB = fs.readFileSync(path.join(b.forgeDir, 'history', 'cycles', 'stable-cycle', 'transcript.jsonl'), 'utf8');
    assert.strictEqual(textA, textB, 'byte-identical mock cycle transcripts expected');
  });

  test('diff is stable across three consecutive runs', () => {
    // Extra paranoia: three runs, all identical.
    const outs = [];
    for (let i = 0; i < 3; i++) {
      const { forgeDir } = makeTempForgeDir();
      runMockCycle(forgeDir, 'stable-cycle');
      outs.push(fs.readFileSync(path.join(forgeDir, 'history', 'cycles', 'stable-cycle', 'transcript.jsonl'), 'utf8'));
    }
    assert.strictEqual(outs[0], outs[1]);
    assert.strictEqual(outs[1], outs[2]);
  });

  test('extra keys supplied by callers appear in sorted order after canonical keys', () => {
    const { forgeDir } = makeTempForgeDir();
    const entry = Object.assign(sampleEntry(), { zeta: 'z', alpha: 'a', mu: 'm' });
    appendTranscript(forgeDir, 'c1', entry, { now: '2026-04-20T00:00:00Z' });
    const line = fs.readFileSync(path.join(forgeDir, 'history', 'cycles', 'c1', 'transcript.jsonl'), 'utf8')
      .split('\n').filter(Boolean)[1];
    // Check key order in the serialized string: canonical, then sorted extras.
    const keys = Object.keys(JSON.parse(line));
    const expected = ['phase', 'agent', 'task_id', 'tool_calls_count', 'duration_ms', 'status', 'summary', 'alpha', 'mu', 'zeta'];
    assert.deepStrictEqual(keys, expected);
  });
});

suite('readTranscript', () => {
  test('splits entries and boundaries', () => {
    const { forgeDir } = makeTempForgeDir();
    runMockCycle(forgeDir, 'c1');
    const r = readTranscript(forgeDir, 'c1');
    assert.strictEqual(r.entries.length, 5);
    assert.strictEqual(r.boundaries.length, 3);
    for (const b of r.boundaries) {
      assert.strictEqual(typeof b.at, 'string');
      assert.ok(b.at.length > 0);
    }
    for (const e of r.entries) {
      assert.ok(!('at' in e), 'entries must not carry timestamps');
    }
  });

  test('returns empty arrays for a missing cycle', () => {
    const { forgeDir } = makeTempForgeDir();
    const r = readTranscript(forgeDir, 'nope');
    assert.deepStrictEqual(r.entries, []);
    assert.deepStrictEqual(r.boundaries, []);
  });
});

suite('transcript-append CLI', () => {
  test('appends a single entry via node scripts/forge-tools.cjs transcript-append', () => {
    const { forgeDir } = makeTempForgeDir();
    const entry = sampleEntry({ task_id: 'T042', summary: 'cli path' });
    const res = spawnSync(process.execPath, [
      TOOLS_CJS, 'transcript-append',
      '--forge-dir', forgeDir,
      '--cycle', 'clicycle',
      '--entry', JSON.stringify(entry)
    ], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, 'stdout=' + res.stdout + ' stderr=' + res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assert.strictEqual(parsed.entryWritten, true);
    assert.strictEqual(parsed.boundaryWritten, true);
    const file = path.join(forgeDir, 'history', 'cycles', 'clicycle', 'transcript.jsonl');
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    const written = JSON.parse(lines[1]);
    assert.strictEqual(written.task_id, 'T042');
    assert.strictEqual(written.summary, 'cli path');
    assert.ok(!('at' in written));
  });

  test('succeeds without --cycle by auto-resolving one (forge-self-fixes R008)', () => {
    const { forgeDir } = makeTempForgeDir();
    const res = spawnSync(process.execPath, [
      TOOLS_CJS, 'transcript-append',
      '--forge-dir', forgeDir,
      '--event', '{"phase":"executing","event":"demo"}'
    ], { encoding: 'utf8' });
    // R008 flipped the contract: --cycle is optional; the CLI now looks
    // up the active cycle from state.md or synthesises a compact UTC
    // stamp so manual callers can leave an audit trail identical to
    // stop-hook-driven runs.
    assert.strictEqual(res.status, 0, 'exit 0 on auto-resolved cycle; stderr=' + res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.cycle, 'auto-resolved cycle id is in stdout');
    assert.ok(/Z$/.test(out.cycle) || out.cycle.length > 0);
  });

  test('errors with exit code 2 when --entry is not valid JSON', () => {
    const { forgeDir } = makeTempForgeDir();
    const res = spawnSync(process.execPath, [
      TOOLS_CJS, 'transcript-append',
      '--forge-dir', forgeDir,
      '--cycle', 'clicycle',
      '--entry', 'not-json'
    ], { encoding: 'utf8' });
    assert.strictEqual(res.status, 2);
    assert.ok(/not valid JSON/.test(res.stderr));
  });
});

runTests();
