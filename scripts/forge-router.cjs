const fs = require('fs');
const path = require('path');

// === Task Classification ===
// Scores tasks 0-20 on multiple dimensions, maps to model tiers.

const TIERS = {
  HAIKU:  { name: 'haiku',  cost_weight: 1,  threshold: 4 },
  SONNET: { name: 'sonnet', cost_weight: 5,  threshold: 10 },
  OPUS:   { name: 'opus',   cost_weight: 25, threshold: Infinity },
};

const DEFAULT_ROLE_BASELINES = {
  'forge-researcher':  { min: 'haiku',  preferred: 'sonnet', max: 'sonnet' },
  'forge-complexity':  { min: 'haiku',  preferred: 'haiku',  max: 'haiku'  },
  'forge-executor':    { min: 'haiku',  preferred: 'sonnet', max: 'opus'   },
  'forge-reviewer':    { min: 'sonnet', preferred: 'sonnet', max: 'opus'   },
  'forge-verifier':    { min: 'sonnet', preferred: 'sonnet', max: 'opus'   },
  'forge-speccer':     { min: 'sonnet', preferred: 'opus',   max: 'opus'   },
  'forge-planner':     { min: 'sonnet', preferred: 'sonnet', max: 'opus'   },
};

const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };
const TIER_BY_RANK = ['haiku', 'sonnet', 'opus'];

// === R002: Per-Phase Effort and max_tokens Policy ===
//
// Each role has a default effort + max_tokens hint. forge-executor branches
// on the classified task score (the same score classifyTask() emits):
//   score <= 4   -> medium / 6000
//   score 5..10  -> medium / 10000
//   score > 10   -> high / 14000
//
// All other roles use a flat default. Overridable via
// .forge/config.json::model_routing.effort_policy.{role}, missing/malformed
// falls back to the bake-in.
//
// FORGE_TOKEN_OPT=0 disables this layer end-to-end: selectModel reverts to
// the legacy 3-field shape `{ model, reasoning, cost_weight }`, no effort
// fields surface, and downstream consumers see exactly the pre-spec shape.
const EFFORT_POLICY = {
  'forge-speccer':    { effort: 'high',   max_tokens: 16000 },
  'forge-planner':    { effort: 'high',   max_tokens: 12000 },
  'forge-reviewer':   { effort: 'high',   max_tokens: 12000 },
  'forge-verifier':   { effort: 'high',   max_tokens: 12000 },
  'forge-researcher': { effort: 'low',    max_tokens: 4000  },
  'forge-complexity': { effort: 'low',    max_tokens: 2000  },
  // forge-executor is computed from score via getEffortPolicy().
};

const EXECUTOR_EFFORT_BY_SCORE = [
  { maxScore: 4,        effort: 'medium', max_tokens: 6000  },
  { maxScore: 10,       effort: 'medium', max_tokens: 10000 },
  { maxScore: Infinity, effort: 'high',   max_tokens: 14000 },
];

// Memoized per-forgeDir override map. The router is required once per process,
// then called many times; loading the config file each call would dwarf the
// router's own cost. The cache is keyed by forgeDir so multi-repo flows still
// see the right overrides.
const _effortPolicyConfigCache = new Map();

function loadEffortPolicyConfig(forgeDir) {
  if (!forgeDir) return {};
  if (_effortPolicyConfigCache.has(forgeDir)) {
    return _effortPolicyConfigCache.get(forgeDir);
  }
  let merged = {};
  try {
    const cfgPath = path.join(forgeDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const cfg = JSON.parse(raw);
      const policy = cfg && cfg.model_routing && cfg.model_routing.effort_policy;
      if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
        merged = policy;
      }
    }
  } catch (_) {
    merged = {};
  }
  _effortPolicyConfigCache.set(forgeDir, merged);
  return merged;
}

// Test hook: reset memoized override map. Used by unit tests that mutate a
// temp .forge/config.json across cases.
function _resetEffortPolicyCache() {
  _effortPolicyConfigCache.clear();
}

function getEffortPolicy(role, score, configOverrides) {
  let baseline;
  if (role === 'forge-executor') {
    const numericScore = (typeof score === 'number' && !Number.isNaN(score)) ? score : 0;
    const bucket = EXECUTOR_EFFORT_BY_SCORE.find((b) => numericScore <= b.maxScore);
    baseline = { effort: bucket.effort, max_tokens: bucket.max_tokens };
  } else if (EFFORT_POLICY[role]) {
    baseline = { effort: EFFORT_POLICY[role].effort, max_tokens: EFFORT_POLICY[role].max_tokens };
  } else {
    // Unknown role -> conservative middle ground. Same intent as
    // "no policy specified", picked to match forge-executor's middle bucket.
    baseline = { effort: 'medium', max_tokens: 10000 };
  }

  // Config override on top. Only effort/max_tokens fields are honored;
  // unknown keys ignored.
  if (configOverrides && typeof configOverrides === 'object') {
    const override = configOverrides[role];
    if (override && typeof override === 'object') {
      if (typeof override.effort === 'string') baseline.effort = override.effort;
      if (typeof override.max_tokens === 'number') baseline.max_tokens = override.max_tokens;
    }
  }
  return baseline;
}

// Task type keywords for classification
const TYPE_KEYWORDS = {
  scaffolding:    /scaffold|boilerplate|template|stub|init|setup/i,
  crud:           /crud|create.*endpoint|add.*route|basic.*api/i,
  business_logic: /logic|calculate|validate|transform|process/i,
  integration:    /integrat|connect|wire|hook|bridge|middleware/i,
  architecture:   /architect|design|refactor|restructure|migration/i,
  security:       /security|auth|encrypt|permission|token|jwt|csrf|xss/i,
};

function inferTaskType(name, description) {
  const text = `${name} ${description || ''}`;
  for (const [type, pattern] of Object.entries(TYPE_KEYWORDS)) {
    if (pattern.test(text)) return type;
  }
  return 'business_logic';
}

const TYPE_SCORES = {
  scaffolding: 0, crud: 1, business_logic: 2,
  integration: 3, architecture: 5, security: 5,
};

function inferJudgmentLevel(task) {
  const name = (task.name || '').toLowerCase();
  if (/design|architect|choose|decide|strategy/.test(name)) return 'design_decision';
  if (/update|add|extend|implement|create/.test(name)) return 'pattern_matching';
  return 'none';
}

const JUDGMENT_SCORES = { none: 0, pattern_matching: 2, design_decision: 4 };

function inferCrossComponent(task) {
  const deps = task.depends || [];
  const consumes = task.consumes || [];
  if (deps.length === 0 && consumes.length === 0) return 'none';
  if (deps.length <= 1) return 'same_layer';
  if (deps.length <= 3) return 'cross_layer';
  return 'cross_repo';
}

const CROSS_SCORES = { none: 0, same_layer: 1, cross_layer: 3, cross_repo: 5 };

function inferNovelty(task) {
  const name = (task.name || '').toLowerCase();
  if (/new.*system|new.*module|from.*scratch/.test(name)) return 'new_technology';
  if (/new|add|create|implement/.test(name)) return 'new_feature';
  return 'familiar_pattern';
}

const NOVELTY_SCORES = { familiar_pattern: 0, new_feature: 2, new_technology: 4 };

function estimateFilesFromTask(task) {
  const name = (task.name || '').toLowerCase();
  if (/single.*file|one.*file|hook|script/.test(name)) return 1;
  if (/module|component|endpoint/.test(name)) return 3;
  if (/system|integration|migration/.test(name)) return 6;
  return 3;
}

function classifyTask(task) {
  let score = 0;
  const signals = {};

  // File scope
  const fileCount = estimateFilesFromTask(task);
  if (fileCount <= 2) { score += 0; signals.files = '1-2'; }
  else if (fileCount <= 5) { score += 2; signals.files = '3-5'; }
  else { score += 4; signals.files = '6+'; }

  // Task type
  const taskType = inferTaskType(task.name, task.description);
  score += TYPE_SCORES[taskType] || 2;
  signals.type = taskType;

  // Judgment required
  const judgment = inferJudgmentLevel(task);
  score += JUDGMENT_SCORES[judgment] || 0;
  signals.judgment = judgment;

  // Cross-component
  const cross = inferCrossComponent(task);
  score += CROSS_SCORES[cross] || 0;
  signals.cross = cross;

  // Novelty
  const novelty = inferNovelty(task);
  score += NOVELTY_SCORES[novelty] || 0;
  signals.novelty = novelty;

  // Map score to tier
  let tier;
  if (score <= TIERS.HAIKU.threshold) tier = TIERS.HAIKU;
  else if (score <= TIERS.SONNET.threshold) tier = TIERS.SONNET;
  else tier = TIERS.OPUS;

  return {
    tier,
    score,
    signals,
    reasoning: `Score ${score}: files=${signals.files} type=${signals.type} judgment=${signals.judgment} cross=${signals.cross} novelty=${signals.novelty} -> ${tier.name}`,
  };
}

// selectModel(role, taskClassification, budgetState, config)
//
// Returns an object describing the model choice and the per-phase effort
// hint. Callers that previously read the string return value should switch
// to result.model (only buildModelAdvisory in this repo today; updated
// alongside this change).
//
// Shape:
//   { model, effort, max_tokens, reasoning, cost_weight }
//
// FORGE_TOKEN_OPT=0 reverts to the legacy 3-field shape:
//   { model, reasoning, cost_weight }
// (no effort, no max_tokens).
function selectModel(role, taskClassification, budgetState, config) {
  const routingConfig = (config && config.model_routing) || {};
  // Routing fully disabled -> match historical behavior (string 'sonnet')
  // but wrap in an object so the new contract holds. The old caller reads
  // result.model.
  if (routingConfig.enabled === false) {
    return _buildLegacyResult('sonnet', 'routing disabled by config');
  }

  const baselines = routingConfig.role_baselines || DEFAULT_ROLE_BASELINES;
  const baseline = baselines[role] || { min: 'haiku', preferred: 'sonnet', max: 'opus' };
  const taskTier = taskClassification.tier.name;

  let selectedRank = TIER_RANK[taskTier] !== undefined ? TIER_RANK[taskTier] : 1;

  // Enforce role minimum
  const minRank = TIER_RANK[baseline.min] || 0;
  if (selectedRank < minRank) selectedRank = minRank;

  // Enforce role maximum
  const maxRank = TIER_RANK[baseline.max] || 2;
  if (selectedRank > maxRank) selectedRank = maxRank;

  // Budget pressure
  const pctUsed = budgetState ? budgetState.percentUsed : 0;
  if (pctUsed > 90) {
    selectedRank = minRank;
  } else if (pctUsed > 70) {
    selectedRank = Math.max(minRank, selectedRank - 1);
  }

  const modelName = TIER_BY_RANK[selectedRank] || 'sonnet';
  const reasoning = taskClassification.reasoning || '';
  const tierObj = Object.values(TIERS).find((t) => t.name === modelName);
  const costWeight = tierObj ? tierObj.cost_weight : 5;

  // FORGE_TOKEN_OPT=0 short-circuits to the legacy 3-field shape.
  if (process.env.FORGE_TOKEN_OPT === '0') {
    return { model: modelName, reasoning, cost_weight: costWeight };
  }

  // Resolve effort policy: defaults + optional config override.
  // Config overrides come from .forge/config.json; we accept them either
  // pre-resolved on routingConfig.effort_policy (cheap path used by tests)
  // or by reading from disk via routingConfig._forgeDir hint.
  let overrides = routingConfig.effort_policy;
  if (!overrides && routingConfig._forgeDir) {
    overrides = loadEffortPolicyConfig(routingConfig._forgeDir);
  }
  const { effort, max_tokens } = getEffortPolicy(role, taskClassification.score, overrides);

  return {
    model: modelName,
    effort,
    max_tokens,
    reasoning,
    cost_weight: costWeight,
  };
}

function _buildLegacyResult(modelName, reasoning) {
  const tierObj = Object.values(TIERS).find((t) => t.name === modelName);
  const costWeight = tierObj ? tierObj.cost_weight : 5;
  if (process.env.FORGE_TOKEN_OPT === '0') {
    return { model: modelName, reasoning, cost_weight: costWeight };
  }
  // Routing disabled but token-opt on: still surface effort/max_tokens
  // so downstream plumbing has a stable shape. Use conservative defaults
  // (medium/10000) — same as the unknown-role fallback in getEffortPolicy.
  return {
    model: modelName,
    effort: 'medium',
    max_tokens: 10000,
    reasoning,
    cost_weight: costWeight,
  };
}

// Escalation: when a task fails, try a higher-tier model
function escalateModel(currentModel) {
  const rank = TIER_RANK[currentModel] || 1;
  if (rank < 2) return TIER_BY_RANK[rank + 1];
  return null; // opus failed -> needs human
}

// De-escalation: after consecutive successes, suggest cheaper model
function deescalateModel(currentModel, consecutiveSuccesses) {
  if (consecutiveSuccesses < 3) return currentModel;
  const rank = TIER_RANK[currentModel] || 1;
  if (rank > 0) return TIER_BY_RANK[rank - 1];
  return currentModel;
}

// Build a model advisory string for inclusion in task prompts
function buildModelAdvisory(task, role, config, budgetState) {
  const classification = classifyTask(task);
  const result = selectModel(role, classification, budgetState, config);
  const modelName = (result && typeof result === 'object') ? result.model : result;
  return {
    model: modelName,
    classification,
    advisory: `Model: ${modelName} (${classification.reasoning})`,
  };
}

// === R003: Handoff JSON Writer for Router Hints ===
//
// writeHandoff(forgeDir, taskId, role, complexity)
//
// Resolves the model/effort/max_tokens hint via the same policy used by
// selectModel and writes a single JSON file at:
//   {forgeDir}/handoff.{taskId}.json
// containing:
//   { model, effort, max_tokens, role, task_id }
//
// The orchestrator invokes this BEFORE every Agent dispatch. The handoff
// file is the authoritative record of what hint was sent to the agent;
// when the Agent tool eventually accepts an `effort` parameter, the
// orchestrator can pick the value back up from the handoff file (or pass
// the writeHandoff return value directly).
//
// Arguments:
//   forgeDir   abs or rel path to the .forge/ directory. Created if missing.
//   taskId     short task id (e.g. "T004"); used as the filename suffix.
//   role       one of the EFFORT_POLICY keys, e.g. "forge-executor".
//   complexity either a classification object (with .tier/.score/.reasoning,
//              as returned by classifyTask) OR a raw task object (with
//              .name/.description) which will be classified internally.
//              May also be null/undefined; falls back to a minimal stub
//              that lands in the executor low-score bucket.
//
// Behavior:
//   - Idempotent. Writing the same handoff twice overwrites cleanly.
//   - FORGE_TOKEN_OPT=0 -> handoff JSON is still written, but the effort
//     and max_tokens fields are omitted (legacy 3-field-equivalent shape:
//     { model, role, task_id }). This keeps the file present for audit
//     while honoring the kill switch's contract that no effort/max_tokens
//     leaks downstream.
//   - Returns the parsed handoff object that was written, so the caller
//     can pass `result.model` to the Agent tool's `model` parameter.
//   - Tolerates a missing forgeDir by mkdir -p; tolerates a malformed
//     classification by falling back to classifyTask on a stub task.
function writeHandoff(forgeDir, taskId, role, complexity) {
  if (!forgeDir || typeof forgeDir !== 'string') {
    throw new TypeError('writeHandoff: forgeDir must be a non-empty string');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new TypeError('writeHandoff: taskId must be a non-empty string');
  }
  if (!role || typeof role !== 'string') {
    throw new TypeError('writeHandoff: role must be a non-empty string');
  }

  // Resolve a classification. Accept three shapes:
  //   1. classification-like object (has .tier and .score)
  //   2. task-like object (has .name)
  //   3. null/undefined
  let classification;
  if (complexity && typeof complexity === 'object' && complexity.tier && typeof complexity.score === 'number') {
    classification = complexity;
  } else if (complexity && typeof complexity === 'object' && typeof complexity.name === 'string') {
    classification = classifyTask(complexity);
  } else {
    // Fallback: minimal stub that lands in low/sonnet bucket. Same defaults
    // as classifyTask on an unknown task.
    classification = classifyTask({ name: taskId, description: '' });
  }

  // Synthesize a config that points selectModel at the on-disk override
  // file (if any). This preserves the cache + override semantics added in
  // T002 without requiring the caller to pass config explicitly.
  const cfg = { model_routing: { enabled: true, _forgeDir: forgeDir } };
  const result = selectModel(role, classification, null, cfg);

  // Build handoff payload. Under FORGE_TOKEN_OPT=0, selectModel returns
  // the legacy 3-field shape (no effort/max_tokens). Mirror that here:
  // we write the file regardless (auditability), but omit the missing
  // hint fields so downstream consumers can't accidentally read stale
  // values.
  const handoff = { model: result.model, role, task_id: taskId };
  if ('effort' in result) handoff.effort = result.effort;
  if ('max_tokens' in result) handoff.max_tokens = result.max_tokens;

  // Ensure forgeDir exists. mkdir -p semantics.
  if (!fs.existsSync(forgeDir)) {
    fs.mkdirSync(forgeDir, { recursive: true });
  }
  const outPath = path.join(forgeDir, `handoff.${taskId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(handoff, null, 2));
  return handoff;
}

module.exports = {
  classifyTask,
  selectModel,
  escalateModel,
  deescalateModel,
  buildModelAdvisory,
  writeHandoff,
  getEffortPolicy,
  loadEffortPolicyConfig,
  _resetEffortPolicyCache,
  DEFAULT_ROLE_BASELINES,
  EFFORT_POLICY,
  EXECUTOR_EFFORT_BY_SCORE,
  TIERS,
  TIER_RANK,
  TIER_BY_RANK,
};
