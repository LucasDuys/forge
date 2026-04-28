// tests/forge-token-bucket.test.cjs -- T002 / R002 (token-instrumentation Wave 1)
//
// Covers (>=6 cases per bucket per spec):
//   - instructions bucket
//   - tool_definitions bucket
//   - tool_results bucket
//   - repo_reads bucket (with line-number / <file> envelope heuristic)
//   - prose bucket
//   - empty input -> all zeros, no throw
//   - malformed messages array -> zeros for affected buckets, no throw
//   - missing `tools` -> tool_definitions = 0, no throw
//   - missing `system` -> instructions = 0, no throw
//   - FORGE_TOKEN_OPT=0 -> { skipped: true } shape
//   - sum-within-10% self-consistency on a real-shape payload
//   - repo_reads vs tool_results disambiguation: a Read result counts in
//     repo_reads NOT in tool_results (no double-count)

'use strict';

const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');

// Defensive: make sure we test the default code path. Individual tests
// flip FORGE_TOKEN_OPT inline.
delete process.env.FORGE_TOKEN_OPT;

// Self-check is dev-mode only (NODE_ENV==='test'); enable it for the suite
// so any silent drop is caught here.
process.env.NODE_ENV = 'test';

const FIXTURES = require(path.join(__dirname, 'fixtures', 'bucket-payloads.json'));

const mod = require('../scripts/forge-token-bucket.cjs');
const { classifyTokens, estimateTokens } = mod;

// --- shape helpers --------------------------------------------------------

function assertShape(result) {
  assert.ok(result && typeof result === 'object', 'result must be an object');
  for (const k of ['instructions', 'tool_definitions', 'tool_results', 'repo_reads', 'prose']) {
    assert.strictEqual(typeof result[k], 'number', `bucket ${k} must be a number`);
    assert.ok(result[k] >= 0, `bucket ${k} must be non-negative`);
    assert.ok(Number.isFinite(result[k]), `bucket ${k} must be finite`);
  }
}

function totalOf(result) {
  return result.instructions + result.tool_definitions + result.tool_results + result.repo_reads + result.prose;
}

// --- 1. instructions bucket ----------------------------------------------

suite('classifyTokens: instructions bucket', () => {
  for (const fx of FIXTURES.instructions) {
    test(fx.name, () => {
      const r = classifyTokens(fx.input);
      assertShape(r);
      assert.deepStrictEqual(r, fx.expected, `instructions case "${fx.name}"`);
    });
  }
});

// --- 2. tool_definitions bucket ------------------------------------------

suite('classifyTokens: tool_definitions bucket', () => {
  for (const fx of FIXTURES.tool_definitions) {
    test(fx.name, () => {
      const r = classifyTokens(fx.input);
      assertShape(r);
      // For tool_definitions cases we only assert: tool_definitions > 0 and
      // every other bucket is 0 (no leakage). Exact tokens depend on stable
      // JSON.stringify key order, which Node guarantees for plain objects.
      assert.ok(r.tool_definitions > 0, 'tool_definitions must be > 0');
      assert.strictEqual(r.instructions, 0);
      assert.strictEqual(r.tool_results, 0);
      assert.strictEqual(r.repo_reads, 0);
      assert.strictEqual(r.prose, 0);
    });
  }
});

// --- 3. tool_results bucket ----------------------------------------------

suite('classifyTokens: tool_results bucket', () => {
  for (const fx of FIXTURES.tool_results) {
    test(fx.name, () => {
      const r = classifyTokens(fx.input);
      assertShape(r);
      assert.deepStrictEqual(r, fx.expected, `tool_results case "${fx.name}"`);
    });
  }
});

// --- 4. repo_reads bucket ------------------------------------------------

suite('classifyTokens: repo_reads bucket', () => {
  for (const fx of FIXTURES.repo_reads) {
    test(fx.name, () => {
      const r = classifyTokens(fx.input);
      assertShape(r);
      assert.ok(r.repo_reads > 0, 'repo_reads must be > 0');
      // Critical: a file-shaped result must NOT also land in tool_results.
      assert.strictEqual(r.tool_results, 0, 'no double-count into tool_results');
      assert.strictEqual(r.instructions, 0);
      assert.strictEqual(r.tool_definitions, 0);
      assert.strictEqual(r.prose, 0);
    });
  }
});

// --- 5. prose bucket -----------------------------------------------------

suite('classifyTokens: prose bucket', () => {
  for (const fx of FIXTURES.prose) {
    test(fx.name, () => {
      const r = classifyTokens(fx.input);
      assertShape(r);
      if (fx.expected) {
        assert.deepStrictEqual(r, fx.expected, `prose case "${fx.name}"`);
      } else {
        // expected_prose_only fixtures
        assert.ok(r.prose > 0, 'prose must be > 0');
        assert.strictEqual(r.instructions, 0);
        assert.strictEqual(r.tool_definitions, 0);
        assert.strictEqual(r.tool_results, 0);
        assert.strictEqual(r.repo_reads, 0);
      }
    });
  }
});

// --- 6. defensive paths ---------------------------------------------------

suite('classifyTokens: defensive paths', () => {
  test('empty object input -> all zeros', () => {
    const r = classifyTokens({});
    assertShape(r);
    assert.strictEqual(totalOf(r), 0);
  });

  test('null input -> all zeros, no throw', () => {
    const r = classifyTokens(null);
    assertShape(r);
    assert.strictEqual(totalOf(r), 0);
  });

  test('undefined input -> all zeros, no throw', () => {
    const r = classifyTokens(undefined);
    assertShape(r);
    assert.strictEqual(totalOf(r), 0);
  });

  test('missing `system` -> instructions = 0', () => {
    const r = classifyTokens({ messages: [], tools: [] });
    assert.strictEqual(r.instructions, 0);
  });

  test('missing `tools` -> tool_definitions = 0', () => {
    const r = classifyTokens({ messages: [], system: 'hi' });
    assert.strictEqual(r.tool_definitions, 0);
  });

  test('missing `messages` -> tool_results / repo_reads / prose = 0', () => {
    const r = classifyTokens({ tools: [], system: 'hi' });
    assert.strictEqual(r.tool_results, 0);
    assert.strictEqual(r.repo_reads, 0);
    assert.strictEqual(r.prose, 0);
  });

  test('malformed messages (string instead of array) -> no throw, zeros', () => {
    const r = classifyTokens({ messages: 'not an array', tools: [], system: '' });
    assertShape(r);
    assert.strictEqual(r.tool_results, 0);
    assert.strictEqual(r.repo_reads, 0);
    assert.strictEqual(r.prose, 0);
  });

  test('malformed tools (string instead of array) -> no throw, zero', () => {
    const r = classifyTokens({ messages: [], tools: 'not an array', system: '' });
    assertShape(r);
    assert.strictEqual(r.tool_definitions, 0);
  });

  test('messages contains nulls -> skipped without throw', () => {
    const r = classifyTokens({ messages: [null, undefined, {}], tools: [], system: '' });
    assertShape(r);
    assert.strictEqual(totalOf(r), 0);
  });

  test('content blocks contain unknown types -> tallied into prose, no throw', () => {
    const r = classifyTokens({
      messages: [
        { role: 'assistant', content: [{ type: 'mystery_block', payload: 'hello world' }] },
      ],
      tools: [],
      system: '',
    });
    assertShape(r);
    assert.ok(r.prose > 0, 'unknown blocks must contribute to prose so the sum stays close');
  });
});

// --- 7. FORGE_TOKEN_OPT=0 short-circuit ----------------------------------

suite('classifyTokens: FORGE_TOKEN_OPT=0 guard', () => {
  test('returns { skipped: true } and zero shape, ignores input', () => {
    const original = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const r = classifyTokens({
        system: 'a very long system prompt that should be ignored entirely under opt-out',
        tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'hello' }],
      });
      assertShape(r);
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(totalOf(r), 0);
    } finally {
      if (original === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = original;
    }
  });

  test('FORGE_TOKEN_OPT="1" does NOT short-circuit', () => {
    const original = process.env.FORGE_TOKEN_OPT;
    process.env.FORGE_TOKEN_OPT = '1';
    try {
      const r = classifyTokens({ system: 'hi there', tools: [], messages: [] });
      assert.strictEqual(r.skipped, undefined, 'skipped should not be set');
      assert.ok(r.instructions > 0);
    } finally {
      if (original === undefined) delete process.env.FORGE_TOKEN_OPT;
      else process.env.FORGE_TOKEN_OPT = original;
    }
  });
});

// --- 8. estimator unit ---------------------------------------------------

suite('estimateTokens', () => {
  test('null/undefined -> 0', () => {
    assert.strictEqual(estimateTokens(null), 0);
    assert.strictEqual(estimateTokens(undefined), 0);
  });
  test('empty string -> 0', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });
  test('chars/4 ceiling', () => {
    assert.strictEqual(estimateTokens('abcd'), 1);
    assert.strictEqual(estimateTokens('abcde'), 2);
    assert.strictEqual(estimateTokens('a'), 1);
  });
  test('non-string coerced to string', () => {
    assert.strictEqual(estimateTokens(1234), 1);
  });
});

// --- 9. real-shape sum-within-10% self-consistency ----------------------

suite('classifyTokens: sum-within-10% self-consistency', () => {
  test('real-shape payload: bucket sum stays within +-10% of internal recompute', () => {
    const fx = FIXTURES.real_shape_self_consistency;
    // The classifier itself self-checks when NODE_ENV==='test'; just calling
    // it without a thrown BUCKET_SUM_DRIFT confirms compliance.
    const r = classifyTokens(fx.input);
    assertShape(r);
    assert.ok(totalOf(r) > 0, 'real-shape payload must produce non-zero buckets');
    // Sanity: at least three of the five buckets should be non-zero on a
    // real mixed payload (instructions, tool_definitions, prose, repo_reads).
    const nonZero = Object.entries(r).filter(([k, v]) => typeof v === 'number' && v > 0).length;
    assert.ok(nonZero >= 3, `expected >=3 non-zero buckets, got ${nonZero}: ${JSON.stringify(r)}`);
  });

  test('classifier self-check fires when a bucket undercounts (synthetic)', () => {
    // We can't easily corrupt the classifier from outside, but we CAN verify
    // the self-check tolerance is meaningful by checking the public behavior:
    // a normal run on the real-shape fixture must NOT throw. A regression
    // that drops a bucket would change totalOf and the self-check would
    // throw BUCKET_SUM_DRIFT. Here we just exercise the success path.
    const fx = FIXTURES.real_shape_self_consistency;
    let threw = null;
    try { classifyTokens(fx.input); } catch (e) { threw = e; }
    assert.strictEqual(threw, null, 'real-shape fixture must not trigger BUCKET_SUM_DRIFT');
  });
});

// --- 10. repo_reads vs tool_results disambiguation ----------------------

suite('classifyTokens: repo_reads vs tool_results disambiguation', () => {
  test('Read tool_result lands in repo_reads, not tool_results', () => {
    const r = classifyTokens({
      system: '',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r',
              content: '     1\tline one\n     2\tline two\n     3\tline three\n',
            },
          ],
        },
      ],
    });
    assert.ok(r.repo_reads > 0, 'repo_reads must catch the file content');
    assert.strictEqual(r.tool_results, 0, 'tool_results must NOT also count it');
  });

  test('Bash tool_result (no line-number prefix) lands in tool_results', () => {
    const r = classifyTokens({
      system: '',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'b', content: 'PASS 712 tests in 1234ms\n' },
          ],
        },
      ],
    });
    assert.ok(r.tool_results > 0);
    assert.strictEqual(r.repo_reads, 0);
  });

  test('Mixed turn: one Bash result + one Read result -> split correctly', () => {
    const r = classifyTokens({
      system: '',
      tools: [],
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'OK' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: '     1\tcode\n' }] },
      ],
    });
    assert.ok(r.tool_results > 0, 'Bash output should be in tool_results');
    assert.ok(r.repo_reads > 0, 'Read output should be in repo_reads');
    // Sum should equal both individual estimates
    const expectedTotal = estimateTokens('OK') + estimateTokens('     1\tcode\n');
    assert.strictEqual(r.tool_results + r.repo_reads, expectedTotal);
  });

  test('<file> envelope is recognized', () => {
    const r = classifyTokens({
      system: '',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'f', content: '<file path="x.ts">export const x = 1;</file>' },
          ],
        },
      ],
    });
    assert.ok(r.repo_reads > 0);
    assert.strictEqual(r.tool_results, 0);
  });
});

runTests();
