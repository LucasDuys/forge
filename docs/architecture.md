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

## Cross-Cutting Skills (v0.2.0)

Three skills that run automatically across all agents. No explicit invocation needed.

**Karpathy Guardrails** (`skills/karpathy-guardrails/SKILL.md`):
- Inlined into executor, reviewer, and planner agent definitions
- Executor: checks for ambiguity before coding, builds only what AC requires, traces every changed line
- Reviewer: flags over-engineering, scope creep, silent assumptions, goal misalignment as IMPORTANT
- Planner: rejects gold-plated tasks, enforces one concern per task

**Graphify Integration** (`skills/graphify-integration/SKILL.md`):
- Auto-detected by brainstorm, plan, and execute commands (checks for `graphify-out/graph.json`)
- Stored in `state.md` frontmatter as `knowledge_graph:` path
- Planner: aligns task boundaries with community clusters, orders by node connectivity
- Researcher: queries graph for architecture context before external docs
- Reviewer: graph-based blast radius analysis
- Executor: focused context from relevant subgraph instead of full codebase scan
- Degrades gracefully: no graph = standard behavior unchanged

**DESIGN.md Support** (`skills/design-system/SKILL.md`):
- Auto-detected by brainstorm, plan, and execute commands (checks for DESIGN.md in project root)
- Stored in `state.md` frontmatter as `design_system:` path
- Brainstorm: asks about design requirements, can generate DESIGN.md from brand catalogs
- Planner: tags UI tasks with `design:`, adds design verification task
- Executor: loads design tokens as implementation constraints
- Reviewer: design compliance pass checking palette, typography, spacing
- Degrades gracefully: no DESIGN.md = standard behavior unchanged

## Workflow Enforcement (v0.2.0)

The pipeline is strictly sequential: brainstorm -> plan -> execute. Enforced at multiple levels:
- **Spec approval gate**: Only brainstorming writes `status: approved` after explicit user approval
- **Frontier requirement**: `/forge execute` validates each spec has a frontier
- **Programmatic validation**: `validateWorkflowPrerequisites()` runs in `setup-state` before execution starts
- **State machine phases**: `brainstorming` and `planning` are formal phases

See also: [state-machine.md](../references/state-machine.md) for full phase transition diagram.
