# Token Profiles

## Depth: Quick
- Target tasks per spec: 3-5
- Estimated tokens per task: ~3,000
- Review after task: No
- TDD enforcement: No
- Phase verification: Skip
- Context per task target: ~10% of window
- Best for: Simple features, bug fixes, familiar codebases

## Depth: Standard (default)
- Target tasks per spec: 6-12
- Estimated tokens per task: ~6,000
- Review after task: 1 pass
- TDD enforcement: If TDD skill available
- Phase verification: Quick check
- Context per task target: ~15% of window
- Best for: Most features, moderate complexity

## Depth: Thorough
- Target tasks per spec: 12-20
- Estimated tokens per task: ~12,000
- Review after task: Until clean (max 3 iterations)
- TDD enforcement: Always
- Phase verification: Full goal-backward
- Context per task target: ~25% of window
- Best for: Critical features, unfamiliar codebases, production systems

## Budget Thresholds
| Usage | Action |
|-------|--------|
| 0-70% | Run at configured depth |
| 70-90% | Auto-downgrade to quick |
| 90-100% | Save state, graceful exit |
