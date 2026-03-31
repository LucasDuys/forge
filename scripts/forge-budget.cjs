const fs = require('fs');
const path = require('path');

// === Cost-Weighted Token Budget Tracker ===
// Tracks token usage with model-aware cost weighting.
// 1 opus token costs ~25x what 1 haiku token costs.

const DEFAULT_COST_WEIGHTS = { haiku: 1, sonnet: 5, opus: 25 };

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
};
