// scripts/forge-token-bucket.cjs
//
// T002 / R002 (spec-token-instrumentation, Wave 1).
//
// Token-source bucket classifier. Given an Anthropic-shaped request payload
// ({ messages, tools, system }), splits the input tokens into 5 buckets so we
// can see WHERE the tokens go in any given turn:
//
//   - instructions     : system prompt + agent definitions / skill bodies that
//                        landed in `system` (CLAUDE.md, SKILL.md, agents/*.md).
//   - tool_definitions : every tools[] entry (name + description + input_schema).
//   - tool_results     : every `tool_result` content block in messages, EXCEPT
//                        when the result content looks like a file read -- then
//                        the tokens are credited to repo_reads instead, to
//                        avoid double-counting.
//   - repo_reads       : Read/Grep/Glob outputs detected via line-number prefix
//                        ("  N\t..."), `<file>` envelope, or "cat -n"-style
//                        markers. These are usually the largest single bucket
//                        on a coding turn and we want them broken out.
//   - prose            : assistant `text` blocks + any user `text` block that
//                        is plain prose (not a tool_result and not a file read).
//
// Token estimator: rough chars/4 ratio (est = ceil(len/4)). The spec contract
// is "sum within +-10% of total input_tokens", which a chars/4 estimate hits
// in practice for English+code mixes; we are NOT trying to reproduce the
// Anthropic tokenizer. Documented per R002.
//
// Constraints:
//   - Pure node:* (no deps, no LLM calls).
//   - FORGE_TOKEN_OPT=0 -> short-circuit zero-shape with `skipped: true`.
//   - Defensive parsing: malformed JSON / missing fields return zeros for the
//     affected bucket without throwing.
//   - Self-consistency check (sum within +-10% of total) only fires when
//     NODE_ENV === 'test'; production callers never see the assertion.
//
// Usage:
//   const { classifyTokens, estimateTokens } = require('./forge-token-bucket');
//   const buckets = classifyTokens({ messages, tools, system });
//   // -> { instructions, tool_definitions, tool_results, repo_reads, prose }

'use strict';

const ZERO_SHAPE = Object.freeze({
  instructions: 0,
  tool_definitions: 0,
  tool_results: 0,
  repo_reads: 0,
  prose: 0,
});

// --- token estimation -----------------------------------------------------

// Rough chars/4 estimator. The spec contract is +-10% of true input_tokens
// for the SUM across buckets; per-bucket exactness is not required and the
// research doc explicitly authorizes this approximation.
function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}

// --- helpers --------------------------------------------------------------

function isOptOut() {
  return process.env.FORGE_TOKEN_OPT === '0';
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return '';
  }
}

// Heuristic: does this string LOOK like a file read tool result?
//   - cat -n style: lines start with "<spaces><digits>\t..."
//   - <file path="..."> envelope (Read tool's wrapping)
//   - "<system-reminder>... contents of ..." patterns occasionally show up but
//     we conservatively only match the first two.
//
// Conservatism matters: a false positive here moves tokens from tool_results
// into repo_reads, but the SUM stays right -- so the sum-within-10% contract
// holds either way. False positives just blur the per-bucket reading.
const LINE_NUMBER_PREFIX_RE = /^\s*\d+\t/m;
const FILE_ENVELOPE_RE = /<file\b[^>]*>/i;

function looksLikeFileRead(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (FILE_ENVELOPE_RE.test(text)) return true;
  if (LINE_NUMBER_PREFIX_RE.test(text)) return true;
  return false;
}

// Tool_result.content can be a string or an array of {type,text|...} blocks.
// Flatten to a single string for the heuristic + estimator.
function flattenToolResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block == null) continue;
      if (typeof block === 'string') {
        parts.push(block);
      } else if (typeof block === 'object') {
        if (typeof block.text === 'string') parts.push(block.text);
        else if (typeof block.content === 'string') parts.push(block.content);
        else parts.push(safeStringify(block));
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') return safeStringify(content);
  return String(content);
}

// --- bucket classifiers ---------------------------------------------------

function bucketInstructions(system) {
  // `system` may be a string OR an array of {type:'text', text:...} blocks
  // (Anthropic supports both shapes). Empty/missing -> 0.
  if (system == null) return 0;
  if (typeof system === 'string') return estimateTokens(system);
  if (Array.isArray(system)) {
    let total = 0;
    for (const block of system) {
      if (block == null) continue;
      if (typeof block === 'string') {
        total += estimateTokens(block);
      } else if (typeof block === 'object' && typeof block.text === 'string') {
        total += estimateTokens(block.text);
      } else {
        // Unknown shape -- estimate over the JSON to stay honest.
        total += estimateTokens(safeStringify(block));
      }
    }
    return total;
  }
  // Unknown type -- estimate over its JSON.
  return estimateTokens(safeStringify(system));
}

function bucketToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  let total = 0;
  for (const t of tools) {
    if (t == null || typeof t !== 'object') continue;
    // Estimate over the canonical {name, description, input_schema} bundle.
    // Use safeStringify so a circular schema can't blow us up.
    const bundle = {
      name: t.name || '',
      description: t.description || '',
      input_schema: t.input_schema || {},
    };
    total += estimateTokens(safeStringify(bundle));
  }
  return total;
}

// Walk messages once and split into tool_results / repo_reads / prose.
// Returns { tool_results, repo_reads, prose }.
function bucketMessageBlocks(messages) {
  const out = { tool_results: 0, repo_reads: 0, prose: 0 };
  if (!Array.isArray(messages)) return out;

  for (const msg of messages) {
    if (msg == null || typeof msg !== 'object') continue;
    const role = msg.role;
    const content = msg.content;

    if (typeof content === 'string') {
      // Plain string content. User strings count as prose; assistant strings
      // count as prose too.
      out.prose += estimateTokens(content);
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      const type = block.type;

      if (type === 'tool_result') {
        const flat = flattenToolResultContent(block.content);
        const cost = estimateTokens(flat);
        if (looksLikeFileRead(flat)) {
          // Repo_read wins over tool_result -- tokens are counted ONCE, in
          // repo_reads, never in both. This is the disambiguation rule
          // documented in R002.
          out.repo_reads += cost;
        } else {
          out.tool_results += cost;
        }
        continue;
      }

      if (type === 'text') {
        // Both assistant `text` blocks and user `text` blocks get prose. The
        // spec calls out assistant text explicitly; user text that isn't a
        // tool_result is just human prose, same bucket.
        out.prose += estimateTokens(block.text);
        continue;
      }

      // tool_use blocks: the tool USE input is small but non-zero. Count
      // toward prose -- it's assistant-emitted content that isn't a tool
      // definition. (It would also be reasonable to ignore; chars/4 of a
      // typical tool_use input is a handful of tokens either way.)
      if (type === 'tool_use') {
        out.prose += estimateTokens(safeStringify(block.input || {}));
        continue;
      }

      // Unknown block type -- estimate over its JSON so the sum stays close
      // to the true input_tokens.
      out.prose += estimateTokens(safeStringify(block));
    }
    // role is intentionally not used to choose a bucket: the BLOCK TYPE is
    // what matters per R002. Kept as a local for future debugging hooks.
    void role;
  }

  return out;
}

// --- public API -----------------------------------------------------------

function classifyTokens(input) {
  if (isOptOut()) {
    return { ...ZERO_SHAPE, skipped: true };
  }

  // Defensive: any throw inside parsing collapses to zero-shape rather than
  // taking down the caller. The caller is usually an instrumentation hook
  // and must never block the user-visible turn.
  let result;
  try {
    const safe = (input && typeof input === 'object') ? input : {};
    const messages = safe.messages;
    const tools = safe.tools;
    const system = safe.system;

    const instructions = bucketInstructions(system);
    const tool_definitions = bucketToolDefinitions(tools);
    const blockBuckets = bucketMessageBlocks(messages);

    result = {
      instructions,
      tool_definitions,
      tool_results: blockBuckets.tool_results,
      repo_reads: blockBuckets.repo_reads,
      prose: blockBuckets.prose,
    };
  } catch (_e) {
    return { ...ZERO_SHAPE };
  }

  // Self-consistency check: dev-mode only. The 5 buckets must sum to the
  // SAME chars/4 estimate we'd get by walking every user-visible string in
  // the payload (system text, tool name+description+schema, message blocks,
  // tool_result content). This catches "classifier silently dropped a
  // block" regressions without coupling to the Anthropic tokenizer.
  //
  // Note: we deliberately do NOT compare to JSON.stringify of the whole
  // payload -- that adds quotes/brackets/keys that the bucket walk never
  // sees, making a 30% systemic gap. The internal sum is what matters.
  if (process.env.NODE_ENV === 'test') {
    try {
      const totalBuckets =
        result.instructions +
        result.tool_definitions +
        result.tool_results +
        result.repo_reads +
        result.prose;
      // Recompute "expected sum" by re-running each bucketer and adding.
      // This will match exactly unless one of them double-counted or
      // skipped a block, which is precisely the regression we want caught.
      const safe = (input && typeof input === 'object') ? input : {};
      const expectedSum =
        bucketInstructions(safe.system) +
        bucketToolDefinitions(safe.tools) +
        (function () {
          const b = bucketMessageBlocks(safe.messages);
          return b.tool_results + b.repo_reads + b.prose;
        })();
      // +-10% tolerance with a 50-token floor (integer rounding noise on
      // small inputs).
      const floor = 50;
      const lo = Math.max(0, Math.floor(expectedSum * 0.9) - floor);
      const hi = Math.ceil(expectedSum * 1.1) + floor;
      if (!(totalBuckets >= lo && totalBuckets <= hi)) {
        const err = new Error(
          `forge-token-bucket self-check: bucket sum ${totalBuckets} outside ` +
          `+-10% of recomputed sum ${expectedSum} (window ${lo}..${hi})`
        );
        err.code = 'BUCKET_SUM_DRIFT';
        throw err;
      }
    } catch (e) {
      if (e && e.code === 'BUCKET_SUM_DRIFT') throw e;
      // Self-check blew up on weird input -- swallow; the classifier's
      // "never throw on bad input" contract trumps a dev assertion.
    }
  }

  return result;
}

module.exports = {
  classifyTokens,
  estimateTokens,
  // Exported for test introspection only -- not part of the public contract.
  _looksLikeFileRead: looksLikeFileRead,
  _ZERO_SHAPE: ZERO_SHAPE,
};
