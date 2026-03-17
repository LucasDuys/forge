# Forge — Agent Routing

This file tells Claude Code how to route work to the correct specialized agent
when working on the Forge project.

## Agent Definitions

### forge-speccer
**When to use:** During `/forge brainstorm` — writing specs from user input, existing code, or docs.
**Files it owns:** `skills/brainstorming/SKILL.md`, `templates/spec.md`
**Key behavior:** Asks clarifying questions one at a time, proposes approaches, writes R-numbered specs with testable acceptance criteria.

### forge-planner
**When to use:** During `/forge plan` — decomposing specs into task frontiers.
**Files it owns:** `skills/planning/SKILL.md`, `templates/plan.md`
**Key behavior:** Reads specs, builds dependency DAGs, groups tasks into parallelizable tiers, estimates tokens per task, tags tasks with repo ownership.

### forge-executor
**When to use:** During `/forge execute` — implementing individual tasks.
**Files it owns:** `skills/executing/SKILL.md`
**Key behavior:** Reads task from frontier, implements with TDD if available, runs tests, commits atomically. Follows inner loop: implement → test → fix → review → fix → commit.

### forge-reviewer
**When to use:** After task implementation (standard/thorough depth) — code review against spec.
**Files it owns:** `skills/reviewing/SKILL.md`, `references/review-protocol.md`
**Key behavior:** Reviews actual code (not the report), checks against spec requirements, flags missing pieces and over-engineering. Returns PASS or ISSUES with file:line references.

### forge-verifier
**When to use:** After all tasks in a phase/spec complete — goal-backward verification.
**Files it owns:** `references/backprop-patterns.md`
**Key behavior:** Checks observable truths (not task checkboxes), detects stubs/placeholders, verifies cross-component wiring. Returns PASSED or GAPS_FOUND.

### forge-complexity
**When to use:** On startup of any `/forge` command — auto-detecting task complexity.
**Files it owns:** `references/complexity-heuristics.md`, `scripts/forge-tools.cjs` (complexity scoring)
**Key behavior:** Analyzes the task/spec and recommends depth level (quick/standard/thorough). Can be overridden by user flags.

## Routing Rules

| Trigger | Agent | Depth |
|---------|-------|-------|
| User runs `/forge brainstorm` | forge-speccer | Always interactive |
| User runs `/forge plan` | forge-planner | Scales with --depth |
| User runs `/forge execute` (per task) | forge-executor | Scales with --depth |
| After task implementation (depth >= standard) | forge-reviewer | standard: 1 pass, thorough: until clean |
| After all tasks complete | forge-verifier | standard: quick check, thorough: full verification |
| On any `/forge` command startup | forge-complexity | Always runs (lightweight) |
| `/forge backprop` | forge-verifier + forge-speccer | Always thorough |

## Multi-Agent Coordination

During `/forge execute`, the orchestrator (stop hook + forge-tools.cjs) coordinates:

1. **Sequential by default** — one executor at a time (context-efficient)
2. **Parallel within tiers** — if configured, tasks in the same tier can dispatch parallel subagents
3. **Review after execute** — reviewer is always a separate agent (fresh context, no bias)
4. **Verifier is independent** — never sees execution details, only checks outcomes

## Context Handoff Between Agents

When context resets at 60%, the handoff includes:
- `.forge/state.md` — current position + decisions
- `.forge/plans/{spec}-frontier.md` — remaining tasks
- `.forge/token-ledger.json` — budget remaining
- `.forge/capabilities.json` — available tools

Each new session reads these files FIRST, then continues from the exact task where the previous session left off. No re-reading completed work.
