// tests/forge-collab-scorer.test.cjs -- T027 / spec-collab-fix R007
//
// Covers:
//   1. routeToParticipant throws when no scorer is wired AND
//      fallback_jaccard is not explicitly enabled.
//   2. fallback_jaccard: true preserves Jaccard routing (opts path + config path).
//   3. llmScorer returns Promise<number> in [0,1] (mocked dispatch).
//   4. scorer errors propagate with clear messages -- no silent 0.
//   5. Regression: contradicting contributor content routes correctly via
//      the LLM scorer where Jaccard would misroute. Proof of R007's value.
//   6. Config path: collab.scorer resolves to a module at runtime.
//   7. formatScorerPrompt / parseScoreFromResponse pure helpers behave.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');
const scorerMod = require('../scripts/forge-collab-scorer.cjs');

const {
  scoreParticipant,
  routeToParticipant,
  _internal: { _heuristicScorer }
} = collab;

const {
  llmScorer,
  makeLlmScorer,
  formatScorerPrompt,
  parseScoreFromResponse
} = scorerMod;

// ---------------------------------------------------------------------------
// 1. routeToParticipant throws when no scorer wired and no Jaccard opt-in.
// ---------------------------------------------------------------------------

suite('R007 AC1 -- routeToParticipant throws without a scorer', () => {
  test('no opts.scorer, no forgeDir, no fallback_jaccard -> throws', () => {
    const participants = [
      { handle: 'alice', contributions: 'x', active_tasks: 0 },
      { handle: 'bob',   contributions: 'x', active_tasks: 0 }
    ];
    assert.throws(
      () => routeToParticipant('anything', participants),
      /forge:collab routing requires a scorer; set collab\.scorer in \.forge\/config\.json or pass opts\.scorer/
    );
  });

  test('fallback_jaccard:false explicitly -> still throws', () => {
    const participants = [
      { handle: 'alice', contributions: 'x' },
      { handle: 'bob',   contributions: 'x' }
    ];
    assert.throws(
      () => routeToParticipant('anything', participants, { fallback_jaccard: false }),
      /forge:collab routing requires a scorer/
    );
  });

  test('forgeDir with empty config -> throws (no silent fallback)', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    const participants = [
      { handle: 'alice', contributions: 'x' },
      { handle: 'bob',   contributions: 'x' }
    ];
    assert.throws(
      () => routeToParticipant('anything', participants, { forgeDir }),
      /forge:collab routing requires a scorer/
    );
  });

  test('empty participants list still returns broadcast without throwing', () => {
    // Short-circuit path: nothing to score, no scorer needed.
    assert.strictEqual(routeToParticipant('anything', []), 'broadcast');
  });

  test('scoreParticipant also throws when no scorer wired and no fallback', () => {
    assert.throws(
      () => scoreParticipant('x', { handle: 'a', contributions: 'x' }),
      /forge:collab routing requires a scorer/
    );
  });
});

// ---------------------------------------------------------------------------
// 2. fallback_jaccard: true preserves legacy Jaccard behavior.
// ---------------------------------------------------------------------------

suite('R007 AC4 -- fallback_jaccard:true preserves Jaccard', () => {
  test('opts.fallback_jaccard:true picks the token-overlap winner', () => {
    const participants = [
      { handle: 'alice', contributions: 'redis cache invalidation ttl pub sub', active_tasks: 0 },
      { handle: 'bob',   contributions: 'react frontend css tailwind design',   active_tasks: 0 },
      { handle: 'carol', contributions: 'payments stripe webhook retries',      active_tasks: 0 }
    ];
    const winner = routeToParticipant(
      'cache invalidation strategy for redis',
      participants,
      { fallback_jaccard: true }
    );
    assert.strictEqual(winner, 'alice');
  });

  test('config.collab.fallback_jaccard:true also enables Jaccard', () => {
    const { forgeDir } = makeTempForgeDir({
      config: { collab: { fallback_jaccard: true } }
    });
    const participants = [
      { handle: 'alice', contributions: 'redis cache invalidation ttl', active_tasks: 0 },
      { handle: 'bob',   contributions: 'react frontend css',           active_tasks: 0 }
    ];
    const winner = routeToParticipant('redis cache ttl', participants, { forgeDir });
    assert.strictEqual(winner, 'alice');
  });

  test('scoreParticipant with fallback_jaccard:true returns Jaccard-overlap number', () => {
    const s = scoreParticipant(
      'hello world',
      { handle: 'a', contributions: 'hello there world' },
      { fallback_jaccard: true }
    );
    assert.ok(typeof s === 'number');
    assert.ok(s > 0 && s <= 1, 'expected Jaccard overlap > 0, got ' + s);
    // Sanity: matches the heuristic directly.
    const direct = _heuristicScorer('hello world', 'hello there world');
    assert.strictEqual(s, direct);
  });

  test('opts.scorer beats opts.fallback_jaccard:true (explicit injection wins)', () => {
    const participants = [
      { handle: 'a', contributions: 'no overlap at all', active_tasks: 0 },
      { handle: 'b', contributions: 'match',             active_tasks: 0 }
    ];
    // Jaccard would pick 'b' on 'match'. Constant scorer with custom
    // bias proves opts.scorer took precedence.
    const constant = (t, c, p) => p.handle === 'a' ? 0.9 : 0.1;
    const winner = routeToParticipant('match', participants, {
      scorer: constant,
      fallback_jaccard: true
    });
    assert.strictEqual(winner, 'a');
  });
});

// ---------------------------------------------------------------------------
// 3. llmScorer returns Promise<number> in [0,1] (mocked dispatch).
// ---------------------------------------------------------------------------

suite('R007 AC2 -- llmScorer returns Promise<number in [0,1]>', () => {
  test('mocked dispatch returning "0.75" resolves to 0.75', async () => {
    const scorer = makeLlmScorer({
      dispatch: async () => '0.75'
    });
    const result = scorer('target', 'contrib', { handle: 'a' });
    assert.ok(result && typeof result.then === 'function', 'expected a Promise');
    const n = await result;
    assert.strictEqual(n, 0.75);
  });

  test('response > 1 clamps to 1', async () => {
    const scorer = makeLlmScorer({ dispatch: async () => '1.4' });
    assert.strictEqual(await scorer('t', 'c', { handle: 'a' }), 1);
  });

  test('response < 0 clamps to 0', async () => {
    const scorer = makeLlmScorer({ dispatch: async () => '-0.3' });
    assert.strictEqual(await scorer('t', 'c', { handle: 'a' }), 0);
  });

  test('response with trailing newline and whitespace still parses', async () => {
    const scorer = makeLlmScorer({ dispatch: async () => '  0.42\n' });
    assert.strictEqual(await scorer('t', 'c', { handle: 'a' }), 0.42);
  });

  test('integer response (e.g., "1") resolves to 1', async () => {
    const scorer = makeLlmScorer({ dispatch: async () => '1' });
    assert.strictEqual(await scorer('t', 'c', { handle: 'a' }), 1);
  });

  test('default module export is a callable scorer shape', () => {
    // Sanity: llmScorer is a function with the scoreParticipant signature.
    assert.strictEqual(typeof llmScorer, 'function');
    // It returns a promise because the default dispatcher rejects.
    const p = llmScorer('t', 'c', { handle: 'a' });
    assert.ok(p && typeof p.then === 'function');
    // Swallow the rejection to avoid unhandled-rejection warnings.
    p.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 4. Scorer errors propagate with clear messages -- NEVER a silent 0.
// ---------------------------------------------------------------------------

suite('R007 -- scorer errors propagate with clear messages', () => {
  test('dispatcher rejection surfaces as a wrapped error, not score 0', async () => {
    const scorer = makeLlmScorer({
      dispatch: async () => { throw new Error('network unreachable'); }
    });
    let caught = null;
    try {
      await scorer('t', 'c', { handle: 'a' });
    } catch (err) { caught = err; }
    assert.ok(caught, 'expected the error to propagate');
    assert.match(caught.message, /network unreachable/);
  });

  test('malformed response raises a parse error (not silent 0)', async () => {
    const scorer = makeLlmScorer({
      dispatch: async () => 'uhh I do not know'
    });
    let caught = null;
    try {
      await scorer('t', 'c', { handle: 'a' });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /llmScorer parse failed/);
  });

  test('default dispatcher (no wire) rejects with an actionable message', async () => {
    const scorer = makeLlmScorer({});
    let caught = null;
    try {
      await scorer('t', 'c', { handle: 'a' });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /no dispatcher wired/);
    assert.match(caught.message, /collab\.fallback_jaccard/);
  });

  test('sync scorer that throws propagates through scoreParticipant', () => {
    const badScorer = () => { throw new Error('bad scorer'); };
    assert.throws(
      () => scoreParticipant('x', { handle: 'a', contributions: 'x' }, { scorer: badScorer }),
      /forge:collab scorer threw: bad scorer/
    );
  });

  test('async scorer that rejects propagates through scoreParticipant', async () => {
    const badScorer = async () => { throw new Error('async bad'); };
    const res = scoreParticipant('x', { handle: 'a', contributions: 'x' }, { scorer: badScorer });
    assert.ok(res && typeof res.then === 'function', 'expected Promise for async scorer');
    let caught = null;
    try { await res; } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /forge:collab scorer rejected: async bad/);
  });
});

// ---------------------------------------------------------------------------
// 5. Regression: contradicting contributor content ("redis" vs "nats").
//    Proof-of-value: Jaccard misroutes on paraphrase; LLM gets it right.
// ---------------------------------------------------------------------------

suite('R007 AC5 -- contradicting content regression', () => {
  // Two participants took opposing positions on the same topic using
  // non-overlapping vocabulary. Target text paraphrases one side.
  const participants = [
    {
      handle: 'alice',
      contributions: 'I strongly prefer redis pubsub; the ttl semantics and existing stack buy-in make it a clear winner for our cache layer.',
      active_tasks: 0
    },
    {
      handle: 'bob',
      contributions: 'I argue for nats jetstream; its durable streams give us at-least-once delivery without an extra broker to babysit.',
      active_tasks: 0
    }
  ];
  // Paraphrase: no literal "redis" or "nats" token. Jaccard tokenization
  // will not match either contributor strongly.
  const paraphrase = 'Which in-memory broker with time-to-live keys should we adopt for the shared cache?';

  test('Jaccard misroutes or ties on paraphrased input (motivates R007)', () => {
    // We document the failure mode: with fallback_jaccard, this
    // paraphrased input either broadcasts or picks neither specifically.
    // Either way, the router does NOT correctly surface alice, which is
    // precisely the misrouting R007 prohibits.
    const r = routeToParticipant(paraphrase, participants, { fallback_jaccard: true });
    // Prove Jaccard did not pick alice. Accept 'broadcast' OR 'bob' --
    // both are wrong answers that the LLM scorer must fix.
    assert.notStrictEqual(r, 'alice', 'Jaccard should NOT pick alice on this paraphrase (if it did, the test no longer demonstrates the motivation for R007)');
  });

  test('llmScorer with a semantic mock routes paraphrase to alice', async () => {
    // Mocked LLM: understands that "in-memory broker with TTL" is a
    // paraphrase of alice's redis position and scores her higher.
    const semanticDispatch = async prompt => {
      if (/alice/.test(prompt) && /redis/.test(prompt)) return '0.9';
      if (/bob/.test(prompt)   && /nats/.test(prompt))  return '0.15';
      return '0';
    };
    const scorer = makeLlmScorer({ dispatch: semanticDispatch });
    const r = await routeToParticipant(paraphrase, participants, { scorer });
    assert.strictEqual(r, 'alice', 'LLM scorer should route paraphrased cache question to alice');
  });
});

// ---------------------------------------------------------------------------
// 6. Config path: collab.scorer resolves to a module at runtime.
// ---------------------------------------------------------------------------

suite('R007 AC3 -- collab.scorer config resolves module', () => {
  test('config.collab.scorer pointing at a local module is invoked', () => {
    // Drop a one-liner scorer module inside a temp project root, point
    // the config at it, then verify routing uses it.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t027-'));
    try {
      const forgeDir = path.join(projectDir, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      const scorerPath = path.join(projectDir, 'my-scorer.cjs');
      fs.writeFileSync(scorerPath,
        'module.exports = function(target, contrib, p) { return p.handle === "alice" ? 0.9 : 0.1; };\n'
      );
      fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({
        collab: { scorer: 'node my-scorer.cjs' }
      }));
      const participants = [
        { handle: 'alice', contributions: 'x' },
        { handle: 'bob',   contributions: 'x' }
      ];
      const winner = routeToParticipant('anything', participants, { forgeDir });
      assert.strictEqual(winner, 'alice');
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('config.collab.scorer pointing at a bare path (no "node" prefix) works', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t027-'));
    try {
      const forgeDir = path.join(projectDir, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      const scorerPath = path.join(projectDir, 'scorer2.cjs');
      fs.writeFileSync(scorerPath,
        'module.exports.llmScorer = function(t,c,p) { return p.handle === "winner" ? 1 : 0; };\n'
      );
      fs.writeFileSync(path.join(forgeDir, 'config.json'), JSON.stringify({
        collab: { scorer: 'scorer2.cjs' }
      }));
      const participants = [
        { handle: 'winner', contributions: 'x' },
        { handle: 'loser',  contributions: 'x' }
      ];
      const r = routeToParticipant('anything', participants, { forgeDir });
      assert.strictEqual(r, 'winner');
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('unloadable collab.scorer with no fallback -> throws (no silent Jaccard)', () => {
    const { forgeDir } = makeTempForgeDir({
      config: { collab: { scorer: 'node ./does-not-exist.cjs' } }
    });
    const participants = [
      { handle: 'a', contributions: 'x' },
      { handle: 'b', contributions: 'x' }
    ];
    assert.throws(
      () => routeToParticipant('anything', participants, { forgeDir }),
      /forge:collab routing requires a scorer/
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Pure-helper tests (formatScorerPrompt / parseScoreFromResponse).
// ---------------------------------------------------------------------------

suite('forge-collab-scorer -- pure helpers', () => {
  test('formatScorerPrompt mentions target, participant handle, and 0..1 contract', () => {
    const p = formatScorerPrompt('pick redis', 'I built redis stacks', { handle: 'alice' });
    assert.match(p, /pick redis/);
    assert.match(p, /alice/);
    assert.match(p, /I built redis stacks/);
    assert.match(p, /between 0 and 1/);
  });

  test('formatScorerPrompt tolerates null/undefined fields', () => {
    const p = formatScorerPrompt(null, undefined, {});
    assert.ok(typeof p === 'string' && p.length > 0);
    assert.match(p, /unknown/); // default handle
  });

  test('parseScoreFromResponse accepts plain numbers', () => {
    assert.strictEqual(parseScoreFromResponse('0'),   0);
    assert.strictEqual(parseScoreFromResponse('0.5'), 0.5);
    assert.strictEqual(parseScoreFromResponse('1'),   1);
  });

  test('parseScoreFromResponse clamps out-of-range to [0,1]', () => {
    assert.strictEqual(parseScoreFromResponse('1.7'),  1);
    assert.strictEqual(parseScoreFromResponse('-0.5'), 0);
  });

  test('parseScoreFromResponse extracts first number from noisy output', () => {
    assert.strictEqual(parseScoreFromResponse('score: 0.42 (high)'), 0.42);
  });

  test('parseScoreFromResponse throws on empty / non-string / no-number', () => {
    assert.throws(() => parseScoreFromResponse(''), /empty/);
    assert.throws(() => parseScoreFromResponse(null), /not a string/);
    assert.throws(() => parseScoreFromResponse('no digits here'), /no number/);
  });
});

runTests();
