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

### forge-researcher
**When to use:** Before complex/unfamiliar tasks during `/forge execute` — research before implementation.
**Files it owns:** None (produces ephemeral research reports)
**Key behavior:** Multi-source research: official docs (Context7), codebase conventions, security best practices, knowledge graph queries. Returns structured research reports with source citations.

### forge-complexity
**When to use:** On startup of any `/forge` command — auto-detecting task complexity.
**Files it owns:** `references/complexity-heuristics.md`, `scripts/forge-tools.cjs` (complexity scoring)
**Key behavior:** Analyzes the task/spec and recommends depth level (quick/standard/thorough). Can be overridden by user flags.

## Skills (Cross-Cutting)

### karpathy-guardrails
**Files:** `skills/karpathy-guardrails/SKILL.md`
**Referenced by:** forge-executor, forge-reviewer, forge-planner
**Purpose:** Four behavioral principles that prevent over-engineering, silent assumptions, scope creep, and unfocused execution. Based on Andrej Karpathy's observations about LLM coding mistakes.

### graphify-integration
**Files:** `skills/graphify-integration/SKILL.md`
**Referenced by:** forge-planner, forge-researcher, forge-reviewer, forge-executor
**Purpose:** Graph-aware planning and research using codebase knowledge graphs. Enables architecture-aware task decomposition, dependency discovery, and context reduction. Optional -- degrades gracefully when no graph is available.

### design-system
**Files:** `skills/design-system/SKILL.md`
**Referenced by:** brainstorming skill, forge-planner, forge-executor, forge-reviewer
**Purpose:** DESIGN.md integration for visual consistency across UI tasks. Supports design-tagged tasks, design compliance review, and design system generation from the awesome-design-md catalog.

## Routing Rules

| Trigger | Agent | Depth |
|---------|-------|-------|
| User runs `/forge brainstorm` | forge-speccer | Always interactive |
| User runs `/forge plan` | forge-planner | Scales with --depth |
| User runs `/forge execute` (per task) | forge-executor | Scales with --depth |
| After task implementation (depth >= standard) | forge-reviewer | standard: 1 pass, thorough: until clean |
| After all tasks complete | forge-verifier | standard: quick check, thorough: full verification |
| Before complex tasks (thorough depth, unfamiliar tech) | forge-researcher | Scales with task complexity |
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
- `graphify-out/graph.json` — codebase knowledge graph (if available)
- `DESIGN.md` — design system specifications (if available)

Each new session reads these files FIRST, then continues from the exact task where the previous session left off. No re-reading completed work.
