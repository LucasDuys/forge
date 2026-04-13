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

## Cross-Cutting Skills (v0.2.0)

Three skills are inlined into agent definitions and run automatically. No manual invocation required.

| Skill | Used By | Behavior |
|-------|---------|----------|
| karpathy-guardrails | executor, reviewer, planner | Four behavioral principles: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. Executor self-checks; reviewer flags violations as IMPORTANT. |
| graphify-integration | planner, researcher, reviewer, executor | Auto-detected via `graphify-out/graph.json`. Planner aligns tasks with community clusters. Researcher queries graph before external docs. Executor gets focused context. |
| design-system | brainstorming, planner, executor, reviewer | Auto-detected via DESIGN.md. Planner tags UI tasks. Executor loads design tokens. Reviewer runs design compliance pass. |

All three degrade gracefully. If no graph or DESIGN.md exists, agents behave exactly as before v0.2.0.
