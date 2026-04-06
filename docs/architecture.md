# Architecture

Forge runs three nested loops. Each has its own circuit breakers and progression logic.

## The Three-Tiered Loop

**Outer loop: Phase progression.** Controls which spec is active and which phase runs next. Phases: `idle` > `executing` > `reviewing_branch` > `verifying` > `idle`. New in v2.1: `budget_exhausted`, `conflict_resolution`, `recovering`, `lock_conflict`. Driven by the stop-hook state machine.

**Middle loop: Task progression.** Within a spec, tasks advance through the dependency DAG. Streaming topological dispatch: tasks start the instant their specific dependencies complete, not when the entire tier finishes. 20-40% faster than tier-gated waves.

**Inner loop: Quality iteration.** Each task cycles through `implement > test > fix (max 3) > debug > Codex rescue > redecompose > blocked`. Circuit breakers at every transition prevent infinite loops.

## The Self-Prompting Engine

The stop hook (`hooks/stop-hook.sh`) intercepts every Claude exit. It reads state from `.forge/.forge-loop.json`, calls `routeDecision()` in `forge-tools.cjs` (a 200+ line state machine), and either blocks exit with the next prompt or allows it. Claude never needs a human to tell it what to do next.

```
Claude acts > attempts exit > stop hook fires > routeDecision() > block with next prompt > repeat
```

New in v2.1: the stop hook also updates a lock-file heartbeat on every invocation (5-minute stale threshold), detects session ownership, and honors the `budget_exhausted` phase for clean exit without a blocking prompt.

Completion signal: Claude outputs `<promise>FORGE_COMPLETE</promise>` only when all tasks are complete and verified. The hook detects it, generates a summary, releases the lock, deletes the loop file, and allows exit.

## Execution Flow

```
/forge execute
      |
  ACQUIRE lock, register session
      |
  LOAD plan DAG + artifact contracts
      |
  STREAMING SCHEDULER -----> picks tasks whose deps are satisfied
      |                       scores complexity (0-20)
      |                       routes to haiku / sonnet / opus
      |                       creates task worktree
      |                       assembles context bundle
      |
      +---> RESEARCHER: deep research (official docs, papers, codebase conventions)
      |         |
      +---> EXECUTOR: implement + test (TDD at thorough depth)
      |         |  writes checkpoints at each step
      |         |  works inside task worktree
      |         |
      |     REVIEWER: spec compliance + blast radius + conventions
      |         |
      |     (optional) CODEX REVIEW: adversarial cross-model check
      |         |
      |     ARTIFACT WRITE: caveman-form structured output
      |         |
      |         +---> Pass: squash-merge worktree, atomic commit, unlock dependents
      |         +---> Fail: debug > Codex rescue > re-decompose > block
      |         +---> Conflict: transition to conflict_resolution phase
      |
      +---> BUDGET MONITOR: per-task gate at 80% warn, 100% escalate
      |
      +---> CONTEXT MONITOR: save handoff at 60%, resume in new session
      |
      v
  VERIFIER: goal-backward verification (existence > substantive > wired > runtime)
      |
  DONE: all tasks committed, branch ready, lock released
```

See also: [state-machine.md](../references/state-machine.md) for full phase transition diagram.
