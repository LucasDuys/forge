---
name: planning
description: Decompose approved specs into ordered task frontiers with dependency DAGs, token estimates, and repo tags
---

# Planning Skill

This skill guides the decomposition of approved specifications into executable task frontiers. Each frontier is a dependency-ordered list of tasks grouped into parallelizable tiers.

## Inputs

You will receive:
- **Spec files**: One or more approved spec files from `.forge/specs/`
- **Depth**: `quick`, `standard`, or `thorough`
- **Repo config**: From `.forge/config.json` (may include multiple repos with ordering)
- **Capabilities**: From `.forge/capabilities.json` (optional, informs task design)
- **Knowledge graph**: `graphify-out/graph.json` (optional, enables architecture-aware decomposition)
- **Design system**: DESIGN.md (optional, enables design-tagged UI tasks)

## Procedure

### Step 1: Read and Validate Specs

For each spec file in `.forge/specs/` (or the filtered subset):
1. Read the file and parse its YAML frontmatter
2. Verify `status: approved` — skip any spec that is not approved
3. Extract all R-numbered requirements and their acceptance criteria
4. Note the `linked_repos` field — this determines which repos tasks will target
5. Note the `complexity` field — this informs task sizing

### Step 2: Determine Depth Parameters

Reference `references/token-profiles.md` for depth-specific settings:

| Parameter | Quick | Standard | Thorough |
|-----------|-------|----------|----------|
| Tasks per spec | 3-5 | 6-12 | 12-20 |
| Tokens per task | ~3k | ~6k | ~12k |
| Review steps | None | After critical tasks | After every task |
| TDD enforcement | No | If skill available | Always |
| Phase verification | Skip | Quick check | Full goal-backward |

### Step 2.5: Load Architecture Context (optional)

**Knowledge Graph**: If `graphify-out/graph.json` exists, load it and extract:
- God nodes (highest-connectivity concepts) for task prioritization
- Community structure for aligning task boundaries with module boundaries
- Cross-module dependencies for implicit dependency edges in the DAG

See `skills/graphify-integration/SKILL.md` for details.

**Design System**: If the spec has a `design:` field or DESIGN.md exists in the project root, load it. UI tasks will be tagged with `design: DESIGN.md` in the frontier, and a design verification task will be added for depth >= standard.

See `skills/design-system/SKILL.md` for details.

### Step 3: Dispatch Planner Agent Per Spec

For each approved spec, dispatch a **forge-planner** agent (via the `Agent` tool) with:
- The full spec content (requirements + acceptance criteria)
- The resolved depth level
- The repo configuration (which repos are available, their roles and ordering)
- The capabilities map (which MCP servers and skills are available)
- The knowledge graph summary (if available: god nodes, communities, key dependencies)
- The design system reference (if available: DESIGN.md path)

The agent returns a frontier file in the template format. See `templates/plan.md`.

### Step 4: Validate and Refine Frontiers

After receiving each frontier from the planner agent:

1. **Requirement coverage**: Verify every R-number from the spec maps to at least one task. If any requirement is missing, add tasks to cover it.
2. **Dependency validity**: Verify all `depends:` references point to real task IDs. No circular dependencies.
3. **Tier correctness**: Tier 1 tasks must have zero dependencies. Tier N tasks must depend only on tasks in Tiers 1 through N-1.
4. **Repo ordering**: If `cross_repo_rules.api_first` is true, API tasks in the same tier must be listed before frontend tasks.
5. **Task count**: Verify the task count falls within the depth range (e.g., 6-12 for standard). Adjust if needed.
6. **Token estimates**: Verify per-task estimates are reasonable for the depth level. Total should be sum of all tasks.

### Step 5: Write Frontier Files

For each spec, write the frontier to `.forge/plans/{spec-domain}-frontier.md`.

The frontier file format (matching `templates/plan.md`):

```markdown
---
spec: {domain}
total_tasks: {N}
estimated_tokens: {total}
depth: {quick|standard|thorough}
---

# {Domain} Frontier

## Tier 1 (parallel -- no dependencies)
- [T001] Task name | est: ~Nk tokens | repo: REPO
- [T002] Task name | est: ~Nk tokens | repo: REPO

## Tier 2 (depends on Tier 1)
- [T003] Task name | est: ~Nk tokens | repo: REPO | depends: T001, T002

## Tier 3 (depends on Tier 2)
- [T004] Task name | est: ~Nk tokens | repo: REPO | depends: T003
```

### Step 6: Write Token Ledger

Write initial estimates to `.forge/token-ledger.json`:

```json
{
  "total": 0,
  "iterations": 0,
  "per_spec": {
    "auth": { "estimated": 45000, "actual": 0 },
    "ui": { "estimated": 32000, "actual": 0 }
  },
  "estimated_total": 77000,
  "last_transcript_tokens": 0
}
```

The `estimated_total` is the sum of all frontier estimated tokens. The `total` (actual usage) starts at 0 and is updated during execution by the stop hook.

### Step 7: Initialize State

Write `.forge/state.md` with the first spec queued:

```markdown
---
phase: idle
spec: {first-spec-domain}
current_task: null
task_status: null
iteration: 0
tokens_used: 0
tokens_budget: {from config, default 500000}
depth: {resolved depth}
autonomy: {from config, default gated}
handoff_requested: false
---

## What's Done

## In-Flight Work

## What's Next
{List all specs and their task counts}

## Key Decisions
- Depth: {depth} ({reason -- auto-detected or user-specified})
- Planning generated {N} total tasks across {M} specs
```

### Step 8: Present Summary

After all frontiers are written, present a summary showing:
- Number of specs planned
- Total tasks across all frontiers
- Estimated total tokens
- Depth level used
- List of frontier files with task counts

Then instruct the user to run `/forge execute` to begin implementation.

## Task Design Principles

When designing tasks (enforced by the forge-planner agent):

1. **Atomic**: Each task has one clear deliverable. "Implement user model + migration" is one task, not "implement entire auth system."
2. **Testable**: Each task's completion can be verified by running tests or checking observable output.
3. **Dependency-minimal**: Prefer fewer dependencies. Tasks should be as parallelizable as possible.
4. **API-first**: For multi-repo projects, API/backend tasks come before frontend tasks that depend on them.
5. **Scaffolding first**: Structural tasks (models, controllers, routes) in early tiers, logic tasks (business logic, validation) in later tiers.
6. **Cross-repo boundary**: Tasks that cross repo boundaries should be split into separate tasks per repo.
7. **Requirement-traced**: Every task should trace back to one or more R-numbers from the spec. Every R-number must be covered by at least one task.
