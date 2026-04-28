const fs = require('fs');
const path = require('path');

// === Cost-Weighted Token Budget Tracker ===
// Tracks token usage with model-aware cost weighting.
// 1 opus token costs ~25x what 1 haiku token costs.

const DEFAULT_COST_WEIGHTS = { haiku: 1, sonnet: 5, opus: 25 };

// === Token Ledger v2 (T003 / R003, spec-token-instrumentation) ===
//
// The .forge/token-ledger.json file gains a `schema_version: 2` field and a
// new top-level `usage_actual` block:
//
//   usage_actual.tasks.{T###} -> { input, output, cache_read, cache_write,
//                                  buckets: { instructions, tool_definitions,
//                                             tool_results, repo_reads, prose },
//                                  source: "transcript" | "estimate" }
//   usage_actual.session       -> same shape (totals across all tasks)
//
// All v1 fields (per_spec, total, iterations, last_transcript_tokens, tasks)
// are preserved verbatim. This module only ADDS data; it never removes,
// renames, or recomputes existing v1 numbers. The 80%/100% per-task budget
// gate continues to read `tasks.<id>.tokens` exactly as before -- nothing
// here changes the gate computation.
//
// FORGE_TOKEN_OPT=0 short-circuits both the migration AND the actual-usage
// write so users who opt out pay zero token-instrumentation cost.

const LEDGER_FILENAME = 'token-ledger.json';
const BUCKET_KEYS = Object.freeze([
  'instructions',
  'tool_definitions',
  'tool_results',
  'repo_reads',
  'prose',
]);

function _isOptOut() {
  return process.env.FORGE_TOKEN_OPT === '0';
}

function _emptyBuckets() {
  return {
    instructions: 0,
    tool_definitions: 0,
    tool_results: 0,
    repo_reads: 0,
    prose: 0,
  };
}

function _emptyUsageActual() {
  return {
    tasks: {},
    session: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      buckets: _emptyBuckets(),
      source: null,
    },
  };
}

// loadLedger(forgeDir)
//   Reads .forge/token-ledger.json defensively. Never throws.
//   Returns { ledger, was_v1, was_corrupted }:
//     - was_v1: file existed but had no `schema_version` field
//     - was_corrupted: file existed but JSON.parse threw
//     - ledger: always carries `schema_version: 2` synthesized IN MEMORY
//       (we don't write here -- callers decide whether to persist).
//
// V1 fields are passed through untouched. Missing v1 fields get safe defaults
// so downstream code can rely on shape stability.
function loadLedger(forgeDir) {
  const ledgerPath = path.join(forgeDir, LEDGER_FILENAME);
  let raw = null;
  let parsed = null;
  let was_corrupted = false;
  let existed = false;

  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
    existed = true;
  } catch (_e) {
    // ENOENT or permission -- treat as "no ledger yet", not corruption.
  }

  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parsed = null;
        was_corrupted = true;
      }
    } catch (_e) {
      parsed = null;
      was_corrupted = true;
      try {
        process.stderr.write(
          `forge-budget: token-ledger.json is corrupt at ${ledgerPath}; using fresh v2 stub\n`
        );
      } catch (_ee) { /* stderr unavailable -- swallow */ }
    }
  }

  const was_v1 = !!(parsed && typeof parsed.schema_version === 'undefined');

  // Build the in-memory ledger with stable shape. Preserve every v1 field.
  const ledger = parsed && !was_corrupted ? Object.assign({}, parsed) : {};
  if (typeof ledger.total !== 'number') ledger.total = 0;
  if (typeof ledger.iterations !== 'number') ledger.iterations = 0;
  if (!ledger.per_spec || typeof ledger.per_spec !== 'object') ledger.per_spec = {};
  if (typeof ledger.last_transcript_tokens !== 'number') ledger.last_transcript_tokens = 0;
  if (!ledger.tasks || typeof ledger.tasks !== 'object') ledger.tasks = {};

  // Always synthesize schema_version=2 in memory. Persistence is a separate
  // decision (upgradeLedger or any normal write).
  ledger.schema_version = 2;

  // Ensure usage_actual block is shape-stable in memory. If v1, supply empty.
  if (!ledger.usage_actual || typeof ledger.usage_actual !== 'object') {
    ledger.usage_actual = _emptyUsageActual();
  } else {
    if (!ledger.usage_actual.tasks || typeof ledger.usage_actual.tasks !== 'object') {
      ledger.usage_actual.tasks = {};
    }
    if (!ledger.usage_actual.session || typeof ledger.usage_actual.session !== 'object') {
      ledger.usage_actual.session = _emptyUsageActual().session;
    } else {
      const s = ledger.usage_actual.session;
      if (typeof s.input !== 'number') s.input = 0;
      if (typeof s.output !== 'number') s.output = 0;
      if (typeof s.cache_read !== 'number') s.cache_read = 0;
      if (typeof s.cache_write !== 'number') s.cache_write = 0;
      if (!s.buckets || typeof s.buckets !== 'object') s.buckets = _emptyBuckets();
      else {
        for (const k of BUCKET_KEYS) {
          if (typeof s.buckets[k] !== 'number') s.buckets[k] = 0;
        }
      }
      if (typeof s.source === 'undefined') s.source = null;
    }
  }

  return {
    ledger,
    was_v1: existed && !was_corrupted && was_v1,
    was_corrupted,
  };
}

// _writeLedger(forgeDir, ledger)
//   Sibling temp-file + rename for atomicity. Mirrors writeLedgerAtomic in
//   forge-tools.cjs (we keep this private copy to avoid a circular require).
//
//   Failure semantics: if the rename fails for ANY reason, we leave the
//   existing destination alone (do NOT pre-delete) and re-throw. This is
//   important for the dual-write contract: the actual-write path must be
//   able to fail without nuking the existing v1 ledger that the estimate
//   write produced moments earlier. The caller (recordActualUsage / etc.)
//   wraps in try/catch so the rethrow is swallowed at the public boundary.
function _writeLedger(forgeDir, ledger) {
  const ledgerPath = path.join(forgeDir, LEDGER_FILENAME);
  const tmpPath = ledgerPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
  try {
    fs.renameSync(tmpPath, ledgerPath);
  } catch (e) {
    // Windows can fail with EPERM/EEXIST when the destination is locked or
    // already exists. Retry-with-unlink is only safe in that narrow case;
    // for any other error (including simulated/disk-full) we want the outer
    // try/catch in recordActualUsage to see the failure WITHOUT having
    // destroyed the existing file.
    const code = e && e.code;
    const safeRetryCodes = new Set(['EEXIST', 'EPERM', 'EACCES']);
    if (safeRetryCodes.has(code) && fs.existsSync(ledgerPath) && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(ledgerPath); } catch (_) {}
      try {
        fs.renameSync(tmpPath, ledgerPath);
        return;
      } catch (_e2) {
        // Both attempts failed -- clean up the temp and rethrow original.
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw e;
      }
    }
    // Non-retriable: clean up the temp file we just wrote so we don't leak,
    // then rethrow so the caller's try/catch can log + report failure.
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

// upgradeLedger(forgeDir)
//   Explicit migration entry point. Idempotent.
//   Returns { status, was_v1, was_corrupted, path }:
//     - "upgraded": v1 file detected, schema_version+usage_actual added,
//                   all v1 fields preserved
//     - "no-op":    file already v2, nothing written
//     - "created":  file did not exist, fresh v2 stub written
//     - "recovered": file was corrupt, replaced with fresh v2 stub
//     - "skipped":   FORGE_TOKEN_OPT=0 -- migration deliberately not run
function upgradeLedger(forgeDir) {
  if (_isOptOut()) {
    return { status: 'skipped', was_v1: false, was_corrupted: false };
  }

  const ledgerPath = path.join(forgeDir, LEDGER_FILENAME);
  let existed = false;
  try {
    fs.accessSync(ledgerPath);
    existed = true;
  } catch (_e) { /* not present */ }

  const { ledger, was_v1, was_corrupted } = loadLedger(forgeDir);

  if (!existed) {
    _writeLedger(forgeDir, ledger);
    return { status: 'created', was_v1: false, was_corrupted: false, path: ledgerPath };
  }

  if (was_corrupted) {
    _writeLedger(forgeDir, ledger);
    return { status: 'recovered', was_v1: false, was_corrupted: true, path: ledgerPath };
  }

  if (was_v1) {
    _writeLedger(forgeDir, ledger);
    return { status: 'upgraded', was_v1: true, was_corrupted: false, path: ledgerPath };
  }

  // Already v2 -- no-op.
  return { status: 'no-op', was_v1: false, was_corrupted: false, path: ledgerPath };
}

// recordActualUsage(forgeDir, taskId, usageData)
//   Write captured token usage into usage_actual.tasks[taskId] AND accumulate
//   into usage_actual.session. FAILURE-ISOLATED: any error is swallowed with
//   a one-line stderr warning. The estimate write path (the existing v1
//   tasks.<id>.tokens accounting) is NOT touched here -- this is purely
//   additive reporting.
//
//   usageData shape (matches T001 captureUsage + T002 classifyTokens output):
//     {
//       input, output, cache_read, cache_write,    // from captureUsage
//       buckets: {instructions, tool_definitions,   // from classifyTokens
//                 tool_results, repo_reads, prose},
//       source: "transcript" | "estimate"
//     }
//
//   Returns { ok: bool, status: "written"|"skipped"|"failed", reason? }.
function recordActualUsage(forgeDir, taskId, usageData) {
  if (_isOptOut()) {
    return { ok: true, status: 'skipped', reason: 'opt_out' };
  }
  if (!taskId) {
    return { ok: false, status: 'failed', reason: 'missing_task_id' };
  }

  try {
    const { ledger } = loadLedger(forgeDir);

    const u = (usageData && typeof usageData === 'object') ? usageData : {};
    const buckets = (u.buckets && typeof u.buckets === 'object') ? u.buckets : {};

    const taskRow = {
      input: Number(u.input) || 0,
      output: Number(u.output) || 0,
      cache_read: Number(u.cache_read) || 0,
      cache_write: Number(u.cache_write) || 0,
      buckets: {
        instructions: Number(buckets.instructions) || 0,
        tool_definitions: Number(buckets.tool_definitions) || 0,
        tool_results: Number(buckets.tool_results) || 0,
        repo_reads: Number(buckets.repo_reads) || 0,
        prose: Number(buckets.prose) || 0,
      },
      source: (u.source === 'transcript' || u.source === 'estimate') ? u.source : 'estimate',
    };

    const prev = ledger.usage_actual.tasks[taskId];
    if (prev && typeof prev === 'object') {
      // Accumulate: keep "transcript" if either side saw a transcript.
      taskRow.input += Number(prev.input) || 0;
      taskRow.output += Number(prev.output) || 0;
      taskRow.cache_read += Number(prev.cache_read) || 0;
      taskRow.cache_write += Number(prev.cache_write) || 0;
      const pb = (prev.buckets && typeof prev.buckets === 'object') ? prev.buckets : {};
      for (const k of BUCKET_KEYS) {
        taskRow.buckets[k] += Number(pb[k]) || 0;
      }
      if (prev.source === 'transcript') taskRow.source = 'transcript';
    }
    ledger.usage_actual.tasks[taskId] = taskRow;

    // Recompute session totals from the per-task rows so the session block
    // never drifts from its parts.
    const session = {
      input: 0, output: 0, cache_read: 0, cache_write: 0,
      buckets: _emptyBuckets(),
      source: null,
    };
    let anyTranscript = false;
    let anyEstimate = false;
    for (const id of Object.keys(ledger.usage_actual.tasks)) {
      const r = ledger.usage_actual.tasks[id];
      if (!r || typeof r !== 'object') continue;
      session.input += Number(r.input) || 0;
      session.output += Number(r.output) || 0;
      session.cache_read += Number(r.cache_read) || 0;
      session.cache_write += Number(r.cache_write) || 0;
      const rb = (r.buckets && typeof r.buckets === 'object') ? r.buckets : {};
      for (const k of BUCKET_KEYS) {
        session.buckets[k] += Number(rb[k]) || 0;
      }
      if (r.source === 'transcript') anyTranscript = true;
      else if (r.source === 'estimate') anyEstimate = true;
    }
    session.source = anyTranscript ? 'transcript' : (anyEstimate ? 'estimate' : null);
    ledger.usage_actual.session = session;

    _writeLedger(forgeDir, ledger);
    return { ok: true, status: 'written' };
  } catch (e) {
    try {
      process.stderr.write(
        `forge-budget: usage_actual write failed for ${taskId}: ${e && e.message || e}\n`
      );
    } catch (_e) { /* swallow */ }
    return { ok: false, status: 'failed', reason: e && e.message || 'unknown' };
  }
}

function loadBudget(forgeDir) {
  const budgetPath = path.join(forgeDir, 'budget-ledger.json');
  try {
    return JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  } catch (e) {
    return {
      total_budget: 500000,
      raw_tokens: 0,
      weighted_cost: 0,
      per_agent: {},
      per_model: {
        haiku: { calls: 0, tokens: 0, weighted: 0 },
        sonnet: { calls: 0, tokens: 0, weighted: 0 },
        opus: { calls: 0, tokens: 0, weighted: 0 },
      },
      per_task: {},
      consecutive_successes: {},
      last_updated: null,
    };
  }
}

function saveBudget(forgeDir, budget) {
  budget.last_updated = new Date().toISOString();
  const budgetPath = path.join(forgeDir, 'budget-ledger.json');
  fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2));
}

function recordUsage(forgeDir, agentId, model, tokensUsed, taskId, config) {
  const budget = loadBudget(forgeDir);
  const costWeights = (config.model_routing || {}).cost_weights || DEFAULT_COST_WEIGHTS;
  const weight = costWeights[model] || 5;
  const weighted = tokensUsed * weight;

  budget.raw_tokens += tokensUsed;
  budget.weighted_cost += weighted;

  budget.per_agent[agentId] = { model, raw: tokensUsed, weighted, task: taskId };

  if (!budget.per_model[model]) {
    budget.per_model[model] = { calls: 0, tokens: 0, weighted: 0 };
  }
  budget.per_model[model].calls += 1;
  budget.per_model[model].tokens += tokensUsed;
  budget.per_model[model].weighted += weighted;

  if (!budget.per_task[taskId]) {
    budget.per_task[taskId] = { agents: [], total_raw: 0, total_weighted: 0 };
  }
  budget.per_task[taskId].agents.push(agentId);
  budget.per_task[taskId].total_raw += tokensUsed;
  budget.per_task[taskId].total_weighted += weighted;

  saveBudget(forgeDir, budget);
  return budget;
}

function getBudgetState(forgeDir, config) {
  const budget = loadBudget(forgeDir);
  const totalBudget = budget.total_budget || (config || {}).token_budget || 500000;
  const percentUsed = (budget.weighted_cost / totalBudget) * 100;
  const remaining = totalBudget - budget.weighted_cost;

  let recommendation = 'normal';
  if (percentUsed >= 90) recommendation = 'minimum';
  else if (percentUsed >= 70) recommendation = 'economize';

  return {
    percentUsed,
    remaining,
    raw_tokens: budget.raw_tokens,
    weighted_cost: budget.weighted_cost,
    breakdown: budget.per_model,
    recommendation,
  };
}

function canAfford(forgeDir, estimatedTokens, model, config) {
  const budget = loadBudget(forgeDir);
  const costWeights = (config.model_routing || {}).cost_weights || DEFAULT_COST_WEIGHTS;
  const cost = estimatedTokens * (costWeights[model] || 5);
  const totalBudget = budget.total_budget || (config || {}).token_budget || 500000;
  return (budget.weighted_cost + cost) <= totalBudget;
}

function recordSuccess(forgeDir, model) {
  const budget = loadBudget(forgeDir);
  if (!budget.consecutive_successes[model]) budget.consecutive_successes[model] = 0;
  budget.consecutive_successes[model]++;
  saveBudget(forgeDir, budget);
  return budget.consecutive_successes[model];
}

function resetSuccessStreak(forgeDir, model) {
  const budget = loadBudget(forgeDir);
  budget.consecutive_successes[model] = 0;
  saveBudget(forgeDir, budget);
}

function getConsecutiveSuccesses(forgeDir, model) {
  const budget = loadBudget(forgeDir);
  return budget.consecutive_successes[model] || 0;
}

module.exports = {
  loadBudget,
  saveBudget,
  recordUsage,
  getBudgetState,
  canAfford,
  recordSuccess,
  resetSuccessStreak,
  getConsecutiveSuccesses,
  DEFAULT_COST_WEIGHTS,
  // T003 / R003 -- token-ledger v2 helpers
  loadLedger,
  upgradeLedger,
  recordActualUsage,
  LEDGER_FILENAME,
  BUCKET_KEYS,
};
