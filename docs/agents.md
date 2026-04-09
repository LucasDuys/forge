# Seven Specialized Agents

| Agent | Role | Min Model | Key Constraint |
|-------|------|-----------|----------------|
| forge-speccer | Writes R-numbered specs with testable criteria | sonnet | One question at a time, capability-aware criteria |
| forge-planner | Decomposes specs into streaming DAGs | sonnet | Coverage verification, no gold-plating |
| forge-executor | Implements tasks with TDD + convention inference | haiku | Worktree + checkpoints, follow existing patterns |
| forge-researcher | Multi-source research before implementation | haiku | Produces reports only, never writes code |
| forge-reviewer | Two-pass review: spec compliance + blast radius | sonnet | Caveman for minor, verbose for security |
| forge-verifier | Four-level goal-backward verification | sonnet | Caveman for pass, verbose for gaps |
| forge-complexity | Scores task difficulty across 5 dimensions | haiku | Lightweight, runs on every command startup |

The separation between agents is deliberate. The reviewer has fresh context and no implementation bias. The verifier never sees execution details, only checks outcomes against the spec.
