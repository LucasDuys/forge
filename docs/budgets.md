# Token Budgets and Hard Ceilings

Every task gets a budget based on its depth. Session-wide budget is enforced as a hard ceiling, not a soft warning.

```json
{
  "per_task_budget": {
    "quick":    5000,
    "standard": 15000,
    "thorough": 40000
  },
  "session_budget_tokens": 500000
}
```

Per-task tracking is granular:

```bash
$ node scripts/forge-tools.cjs budget-status --forge-dir .forge

task        used / budget       remaining   pct
----        -------------       ---------   ---
T012         8200 /  15000         6800       55%
T014         3100 /  15000        11900       21%
T018         4500 /  15000        10500       30%
PER-TASK TOTAL:  15800 / 45000       29200       35%

Session budget:  156400 / 500000  (31%, 343600 remaining)
Iterations:      47 / 100
```

At 80% of a task budget, a warning is injected into Claude's next prompt. At 100%, state transitions to `budget_exhausted` and execution halts cleanly with a handoff doc at `.forge/resume.md`.

Session budget exhaustion triggers the same clean handoff. `/forge resume` detects the exhausted state, reads the handoff, and prompts you to adjust config before continuing.

See also: [budget-thresholds.md](../skills/caveman-internal/references/budget-thresholds.md), [configuration.md](configuration.md).
