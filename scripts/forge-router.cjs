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

function selectModel(role, taskClassification, budgetState, config) {
  const routingConfig = config.model_routing || {};
  if (routingConfig.enabled === false) return 'sonnet';

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

  return TIER_BY_RANK[selectedRank] || 'sonnet';
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
  const model = selectModel(role, classification, budgetState, config);
  return {
    model,
    classification,
    advisory: `Model: ${model} (${classification.reasoning})`,
  };
}

module.exports = {
  classifyTask,
  selectModel,
  escalateModel,
  deescalateModel,
  buildModelAdvisory,
  DEFAULT_ROLE_BASELINES,
  TIERS,
  TIER_RANK,
  TIER_BY_RANK,
};
