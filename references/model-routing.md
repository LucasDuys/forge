# Model Routing Reference

## Task Classification (0-20 score)

| Signal | Low (0) | Medium (2-3) | High (4-5) |
|--------|---------|-------------|------------|
| Files touched | 1-2 files | 3-5 files | 6+ files |
| Task type | Scaffolding, CRUD | Business logic, integration | Architecture, security |
| Judgment required | None | Pattern matching | Design decisions |
| Cross-component | None | Same layer | Cross layer/repo |
| Novelty | Familiar pattern | New feature | New technology |

## Score to Model Mapping

| Score Range | Model Tier | Use Case |
|-------------|-----------|----------|
| 0-4 | haiku | Simple scaffolding, config, boilerplate |
| 5-10 | sonnet | Standard implementation, reviews |
| 11+ | opus | Complex architecture, security, debugging |

## Role Baselines

| Agent | Min | Preferred | Max |
|-------|-----|-----------|-----|
| forge-researcher | haiku | sonnet | sonnet |
| forge-complexity | haiku | haiku | haiku |
| forge-executor | haiku | sonnet | opus |
| forge-reviewer | sonnet | sonnet | opus |
| forge-verifier | sonnet | sonnet | opus |
| forge-speccer | sonnet | opus | opus |
| forge-planner | sonnet | sonnet | opus |

## Cost Weights

| Model | Weight | Rationale |
|-------|--------|-----------|
| haiku | 1x | Baseline cost unit |
| sonnet | 5x | ~5x haiku pricing |
| opus | 25x | ~25x haiku pricing |

## Budget Pressure Rules

| Budget Used | Action |
|-------------|--------|
| 0-70% | Use classified model |
| 70-90% | Downgrade one tier (respecting role minimum) |
| 90-100% | Use minimum viable model for role |

## Escalation/De-escalation

- **BLOCKED** -> try next tier up (haiku -> sonnet -> opus -> human)
- **3+ consecutive successes** -> suggest next tier down
- Review found CRITICAL issues -> escalate executor to next tier
