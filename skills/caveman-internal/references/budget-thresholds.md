# Caveman Budget Thresholds

Single source of truth for the budget percentages that drive caveman intensity selection. Tuned via the T024 benchmark.

## Thresholds

| Remaining budget | Mode | Approx token reduction |
|------------------|------|------------------------|
| > 50% | lite | ~20% |
| 20% to 50% | full | ~40% |
| < 20% | ultra | ~65% |

`remaining` here means `100 - percentage_used` from `checkTaskBudget(taskId, forgeDir)`.

## Clamps

- `depth = thorough` always clamps to `lite`. Thorough work is never compressed beyond lite.
- Out-of-scope content (code, commits, specs, security, user-facing errors) is never compressed regardless of mode. See SKILL.md "Out of scope".
- If budget lookup fails or no task context exists, default to `full`.

## Tuning rule

If the T024 benchmark shows the quality fallback rate exceeds 5% of compressed artifacts, raise the thresholds (push everything one tier toward less compression):

- > 35% -> lite (was > 50%)
- 15% to 35% -> full (was 20% to 50%)
- < 15% -> ultra (was < 20%)

If fallback rate stays under 1% for two consecutive benchmarks, the thresholds may be lowered to extract more savings.

## References

- `../SKILL.md` -- Intensity Selection Logic, Quality Fallback
- `scripts/forge-tools.cjs` -- `checkTaskBudget` implementation (T006)
