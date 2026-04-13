# Token Profiles

## Depth: Quick
- Target tasks per spec: 3-5
- Estimated tokens per task: ~4,000
- Per-task budget ceiling: 8,000
- Review after task: No
- TDD enforcement: No
- Phase verification: Skip
- Guardrail enforcement: Inline only (no separate review pass)
- Design/graph context: Loaded if detected, no extra overhead
- Context per task target: ~10% of window
- Best for: Simple features, bug fixes, config changes, familiar codebases

## Depth: Standard (default)
- Target tasks per spec: 6-12
- Estimated tokens per task: ~8,000
- Per-task budget ceiling: 20,000
- Review after task: 1 pass (includes guardrail + design compliance checks)
- TDD enforcement: If TDD skill available
- Phase verification: Quick check
- Guardrail enforcement: Executor self-checks + reviewer enforcement
- Design/graph context: Loaded if detected, included in review
- Context per task target: ~15% of window
- Best for: Most features, moderate complexity

## Depth: Thorough
- Target tasks per spec: 12-20
- Estimated tokens per task: ~14,000
- Per-task budget ceiling: 45,000
- Review after task: Until clean (max 3 iterations, includes guardrail + design + blast radius)
- TDD enforcement: Always
- Phase verification: Full goal-backward
- Guardrail enforcement: Full enforcement across all agents
- Design/graph context: Loaded if detected, full compliance review
- Context per task target: ~25% of window
- Best for: Critical features, unfamiliar codebases, production systems

## Budget Thresholds
| Usage | Action |
|-------|--------|
| 0-70% | Run at configured depth |
| 70-90% | Auto-downgrade to quick |
| 90-100% | Save state, graceful exit |
