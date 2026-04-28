// tests/forge-usage-capture.test.cjs -- T001 / R001 (token-instrumentation Wave 1)
//
// Covers:
//   - parseTranscript: aggregates usage from a JSONL fixture
//   - captureUsage: transcript path -> source: 'transcript' shape
//   - captureUsage: FORGE_TOKEN_OPT=0 -> source: 'estimate', skipped, no read
//   - captureUsage: missing transcript_path -> estimate fallback
//   - Idempotency: second call on same transcript yields zero new tokens
//   - Malformed JSON line is skipped, not thrown
//   - Perf: parseTranscript on 100-turn synthetic transcript < 50ms
//   - Token-monitor compat: hooks/token-monitor.sh sha256 unchanged

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'transcript-sample.jsonl');
const TOKEN_MONITOR_HOOK = path.join(REPO_ROOT, 'hooks', 'token-monitor.sh');

// Capture token-monitor hash BEFORE loading the module under test, so any
// accidental import-time write would be caught.
const tokenMonitorHashBefore = crypto
  .createHash('sha256')
  .update(fs.readFileSync(TOKEN_MONITOR_HOOK))
  .digest('hex');

// Defensive: clear FORGE_TOKEN_OPT so we test the default path. Individual
// tests that need the opt-out will set it inline.
delete process.env.FORGE_TOKEN_OPT;

const capture = require('../scripts/forge-usage-capture.cjs');
const { captureUsage, parseTranscript, CURSOR_FILENAME } = capture;

function copyFixtureTo(dir, name) {
  const dst = path.join(dir, name || 'transcript.jsonl');
  fs.copyFileSync(FIXTURE_PATH, dst);
  return dst;
}

suite('parseTranscript', () => {
  test('aggregates usage across assistant turns in fixture', () => {
    const result = parseTranscript(FIXTURE_PATH);
    // Fixture has 2 assistant turns: 1200+340+8500+0 and 900+210+9100+150.
    assert.strictEqual(result.totals.input, 2100);
    assert.strictEqual(result.totals.output, 550);
    assert.strictEqual(result.totals.cache_read, 17600);
    assert.strictEqual(result.totals.cache_write, 150);
    assert.strictEqual(result.turns.length, 2);
  });

  test('returns zero totals for nonexistent path', () => {
    const result = parseTranscript('/no/such/transcript.jsonl');
    assert.strictEqual(result.totals.input, 0);
    assert.strictEqual(result.totals.output, 0);
    assert.strictEqual(result.turns.length, 0);
    assert.strictEqual(result.bytes_read, 0);
  });

  test('keys turns by (session_id, role, task_id, turn_index)', () => {
    const result = parseTranscript(FIXTURE_PATH);
    for (const turn of result.turns) {
      assert.strictEqual(turn.session_id, 'sess-abc123');
      assert.ok('role' in turn);
      assert.ok('task_id' in turn);
      assert.ok(typeof turn.turn_index === 'number');
    }
    // Turn indices must be unique within a session.
    const indices = result.turns.map(t => t.turn_index);
    assert.strictEqual(new Set(indices).size, indices.length);
  });

  test('skips malformed JSON lines without throwing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-'));
    try {
      const p = path.join(tmp, 'mixed.jsonl');
      const goodLine = '{"type":"assistant","session_id":"s1","message":{"role":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';
      const content = goodLine + '\nthis is not json\n{also-broken\n' + goodLine + '\n';
      fs.writeFileSync(p, content);
      const result = parseTranscript(p);
      assert.strictEqual(result.totals.input, 20);
      assert.strictEqual(result.totals.output, 10);
      assert.strictEqual(result.malformed_lines, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handles empty file as zero-shape', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-'));
    try {
      const p = path.join(tmp, 'empty.jsonl');
      fs.writeFileSync(p, '');
      const result = parseTranscript(p);
      assert.strictEqual(result.totals.input, 0);
      assert.strictEqual(result.turns.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects startOffset to skip already-processed bytes', () => {
    const stat = fs.statSync(FIXTURE_PATH);
    const result = parseTranscript(FIXTURE_PATH, { startOffset: stat.size });
    assert.strictEqual(result.totals.input, 0);
    assert.strictEqual(result.turns.length, 0);
    assert.strictEqual(result.end_offset, stat.size);
  });

  test('perf: 100-turn synthetic transcript parses in under 50ms', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-'));
    try {
      const p = path.join(tmp, 'big.jsonl');
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'assistant',
          session_id: 'perf-sess',
          uuid: 'u' + i,
          message: {
            id: 'msg_' + i,
            role: 'assistant',
            content: [{ type: 'text', text: 'turn ' + i }],
            usage: {
              input_tokens: 1000 + i,
              output_tokens: 100 + i,
              cache_read_input_tokens: 5000,
              cache_creation_input_tokens: 0,
            },
          },
        }));
      }
      fs.writeFileSync(p, lines.join('\n') + '\n');
      const start = process.hrtime.bigint();
      const result = parseTranscript(p);
      const ns = Number(process.hrtime.bigint() - start);
      const ms = ns / 1e6;
      assert.strictEqual(result.turns.length, 100);
      assert.ok(ms < 50, 'parseTranscript took ' + ms.toFixed(2) + 'ms (>50ms)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('captureUsage transcript path', () => {
  test('valid stdin payload returns source: "transcript" shape', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    const result = captureUsage({
      transcript_path: transcriptPath,
      session_id: 'sess-abc123',
      task_id: 'T001',
    }, { forgeDir });
    assert.strictEqual(result.source, 'transcript');
    assert.strictEqual(result.input, 2100);
    assert.strictEqual(result.output, 550);
    assert.strictEqual(result.cache_read, 17600);
    assert.strictEqual(result.cache_write, 150);
    assert.strictEqual(result.session_id, 'sess-abc123');
    assert.strictEqual(result.task_id, 'T001');
    assert.strictEqual(result.turns.length, 2);
  });

  test('accepts string payload (parses JSON)', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    const payloadStr = JSON.stringify({ transcript_path: transcriptPath });
    const result = captureUsage(payloadStr, { forgeDir });
    assert.strictEqual(result.source, 'transcript');
    assert.strictEqual(result.input, 2100);
  });

  test('writes cursor sidecar after successful read', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    const cursorPath = path.join(forgeDir, CURSOR_FILENAME);
    assert.ok(fs.existsSync(cursorPath));
    const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    assert.ok(cursor[transcriptPath]);
    assert.ok(typeof cursor[transcriptPath].byte_offset === 'number');
    assert.ok(cursor[transcriptPath].byte_offset > 0);
  });
});

suite('captureUsage idempotency', () => {
  test('second call on same transcript yields zero new tokens', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    const first = captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    assert.strictEqual(first.source, 'transcript');
    assert.strictEqual(first.input, 2100);

    const second = captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    assert.strictEqual(second.source, 'transcript');
    assert.strictEqual(second.input, 0);
    assert.strictEqual(second.output, 0);
    assert.strictEqual(second.cache_read, 0);
    assert.ok(second.already_processed === true || (second.turns && second.turns.length === 0));
  });

  test('appended lines are picked up but earlier lines are not double-counted', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    const first = captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    assert.strictEqual(first.input, 2100);

    // Append one more assistant turn.
    const extraTurn = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      uuid: 'a3',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 700,
          output_tokens: 100,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    fs.appendFileSync(transcriptPath, extraTurn + '\n');

    const second = captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    assert.strictEqual(second.source, 'transcript');
    assert.strictEqual(second.input, 700);
    assert.strictEqual(second.output, 100);
    assert.strictEqual(second.cache_read, 9000);
  });

  test('persist:false leaves cursor untouched', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    captureUsage({ transcript_path: transcriptPath }, { forgeDir, persist: false });
    const cursorPath = path.join(forgeDir, CURSOR_FILENAME);
    assert.strictEqual(fs.existsSync(cursorPath), false);
  });
});

suite('captureUsage fallback / opt-out', () => {
  test('FORGE_TOKEN_OPT=0 returns estimate shape and does NOT read transcript', () => {
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    const prev = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const result = captureUsage({ transcript_path: transcriptPath }, { forgeDir });
      assert.strictEqual(result.source, 'estimate');
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.input, 0);
      assert.strictEqual(result.output, 0);
      assert.strictEqual(result.cache_read, 0);
      assert.strictEqual(result.cache_write, 0);
      // Cursor must NOT be written when opted out.
      const cursorPath = path.join(forgeDir, CURSOR_FILENAME);
      assert.strictEqual(fs.existsSync(cursorPath), false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = prev;
    }
  });

  test('missing transcript_path falls back to estimate shape', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = captureUsage({ session_id: 'sess-x' }, { forgeDir });
    assert.strictEqual(result.source, 'estimate');
    assert.strictEqual(result.input, 0);
    assert.strictEqual(result.output, 0);
    assert.ok(result.reason);
  });

  test('non-existent transcript path returns estimate fallback', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = captureUsage(
      { transcript_path: path.join(forgeDir, 'nope.jsonl') },
      { forgeDir }
    );
    assert.strictEqual(result.source, 'estimate');
    assert.strictEqual(result.reason, 'transcript_unreadable');
  });

  test('null payload returns estimate fallback', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = captureUsage(null, { forgeDir });
    assert.strictEqual(result.source, 'estimate');
    assert.strictEqual(result.reason, 'payload_missing');
  });

  test('unparseable string payload returns estimate fallback', () => {
    const { forgeDir } = makeTempForgeDir();
    const result = captureUsage('not-json-at-all', { forgeDir });
    assert.strictEqual(result.source, 'estimate');
    assert.strictEqual(result.reason, 'payload_missing');
  });
});

suite('token-monitor hook compat', () => {
  test('hooks/token-monitor.sh is unchanged on disk after module load + use', () => {
    // Exercise the module thoroughly so any accidental side-effect would surface.
    const { forgeDir } = makeTempForgeDir();
    const transcriptPath = copyFixtureTo(forgeDir);
    captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    captureUsage({ transcript_path: transcriptPath }, { forgeDir });
    parseTranscript(FIXTURE_PATH);

    const after = crypto
      .createHash('sha256')
      .update(fs.readFileSync(TOKEN_MONITOR_HOOK))
      .digest('hex');
    assert.strictEqual(after, tokenMonitorHashBefore,
      'hooks/token-monitor.sh was modified by usage-capture module');
  });
});

runTests();
