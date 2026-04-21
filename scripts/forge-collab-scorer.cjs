// scripts/forge-collab-scorer.cjs
//
// LLM-backed scorer for forge:collab participant routing.
// Implements spec-collab-fix R007 AC 2.
//
// This module exposes:
//   llmScorer(targetText, contributions, participant, opts?)
//     -> Promise<number in [0,1]>
//       The default scorer invoked by routeToParticipant when the user
//       points `collab.scorer` at this file. Formats a narrow classifier
//       prompt, dispatches a forge-researcher subagent, parses the score.
//
//   makeLlmScorer({ dispatch, model, trace })
//     Factory that returns a scoring function bound to a custom
//     dispatcher. Used by tests to inject a mock LLM without spawning a
//     real subagent.
//
//   formatScorerPrompt(targetText, contributions, participant)
//     Pure helper -- returns the prompt string. Exported for tests that
//     want to assert on prompt shape without any LLM in the loop.
//
//   parseScoreFromResponse(raw)
//     Pure helper -- returns a number in [0,1] or throws. Exported so
//     dispatchers can reuse the parsing contract.
//
// Design notes (R007):
//   - Returns a Promise so routeToParticipant can await LLM latency
//     without blocking the event loop.
//   - Errors propagate with clear messages instead of silently returning 0
//     (which is what the old Jaccard heuristic did for paraphrased input
//     and which spec-collab-fix R007 explicitly prohibits).
//   - The default dispatcher throws with a setup hint if no mechanism is
//     wired, so misconfiguration fails loudly rather than misrouting.
//
// Dispatch contract:
//   dispatch(prompt, dispatchOpts?) -> Promise<string>
//     The string is a single number between 0 and 1, optionally with
//     whitespace or a trailing newline. Anything else raises.
//
// In production the dispatcher is expected to spawn the Claude Code
// `forge-researcher` subagent (via the Agent tool pattern invoked by the
// calling agent's harness). Because CommonJS scripts cannot themselves
// invoke the Agent tool, the calling runtime is responsible for injecting
// a dispatcher. Until one is wired, the module throws a clear error.

'use strict';

/**
 * Format the narrow classifier prompt the forge-researcher subagent
 * receives. Short, schema-constrained, and asks for a single number so
 * parsing is trivial and hallucinated prose is rejected.
 */
function formatScorerPrompt(targetText, contributions, participant) {
  const handle = (participant && participant.handle) || 'unknown';
  const contribText = String(contributions == null ? '' : contributions).trim();
  const target = String(targetText == null ? '' : targetText).trim();
  return [
    'You are a routing classifier for a multi-participant collab session.',
    'Score how relevant this participant\'s prior contributions are to the target decision/question.',
    '',
    'Target text:',
    target,
    '',
    'Participant: ' + handle,
    'Prior contributions:',
    contribText,
    '',
    'Return EXACTLY one number between 0 and 1 (inclusive). No words, no explanation.',
    '0 = unrelated. 1 = direct expertise on this exact topic.'
  ].join('\n');
}

/**
 * Parse the LLM response into a number in [0,1]. Throws on malformed
 * output so the caller can surface a clear error rather than silently
 * treating garbage as 0.
 */
function parseScoreFromResponse(raw) {
  if (typeof raw !== 'string') {
    throw new Error('scorer response was not a string (got ' + typeof raw + ')');
  }
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('scorer response was empty');
  // Accept the whole string as a number, or the first numeric token --
  // keeps us robust to trailing newlines or occasional formatting drift.
  const match = trimmed.match(/-?\d*\.?\d+/);
  if (!match) throw new Error('scorer response contained no number: ' + trimmed);
  const n = Number(match[0]);
  if (!Number.isFinite(n)) {
    throw new Error('scorer response parsed to non-finite number: ' + trimmed);
  }
  // Clamp so the caller does not have to re-clamp. Matches _clampScore.
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Default dispatcher. Claude Code cannot invoke its Agent tool from a
 * CJS script, so unless the runtime wired an injector we fail loudly.
 * Silent fallback to 0 would reintroduce exactly the misrouting bug
 * R007 exists to fix.
 */
function _defaultDispatch() {
  return Promise.reject(new Error(
    'forge:collab LLM scorer has no dispatcher wired. ' +
    'Either inject opts.dispatch (e.g., for tests), set collab.scorer_dispatch ' +
    'in .forge/config.json, or set collab.fallback_jaccard=true to use the Jaccard heuristic.'
  ));
}

/**
 * Build a scorer function bound to a specific dispatcher. The returned
 * function matches the (targetText, contributions, participant) contract
 * that scoreParticipant invokes.
 *
 * opts.dispatch: required function(prompt, {model?}) -> Promise<string>
 * opts.model:    optional model hint passed through to the dispatcher
 * opts.trace:    optional sink for (prompt, raw, score) records
 */
function makeLlmScorer(opts) {
  opts = opts || {};
  const dispatch = typeof opts.dispatch === 'function' ? opts.dispatch : _defaultDispatch;
  const model = opts.model || 'sonnet';
  const trace = typeof opts.trace === 'function' ? opts.trace : null;

  return function llmScorerBound(targetText, contributions, participant) {
    const prompt = formatScorerPrompt(targetText, contributions, participant);
    return Promise.resolve(dispatch(prompt, { model })).then(raw => {
      let score;
      try {
        score = parseScoreFromResponse(raw);
      } catch (err) {
        // Wrap with context so scoreParticipant's error wrapper surfaces
        // the full chain to the user.
        throw new Error('llmScorer parse failed: ' + err.message);
      }
      if (trace) {
        try { trace({ prompt, raw, score, participant }); } catch (_) { /* best effort */ }
      }
      return score;
    });
  };
}

/**
 * Default bound scorer. Will throw on invocation unless the runtime has
 * monkey-patched module.exports.dispatch (used by integration harnesses)
 * or the caller wraps it with makeLlmScorer. We expose both shapes so
 * `collab.scorer = "node scripts/forge-collab-scorer.cjs"` loads a
 * callable immediately, and tests can swap the dispatcher cleanly.
 */
const llmScorer = makeLlmScorer({
  // Read from module.exports so tests/runtimes can swap the dispatch
  // function after this module is required.
  dispatch: function (prompt, dispatchOpts) {
    const fn = module.exports.dispatch;
    if (typeof fn === 'function') return fn(prompt, dispatchOpts);
    return _defaultDispatch();
  }
});

module.exports = llmScorer;
module.exports.llmScorer = llmScorer;
module.exports.makeLlmScorer = makeLlmScorer;
module.exports.formatScorerPrompt = formatScorerPrompt;
module.exports.parseScoreFromResponse = parseScoreFromResponse;
module.exports.dispatch = null; // runtime/test-injected dispatcher slot
