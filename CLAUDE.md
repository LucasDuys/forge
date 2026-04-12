# Forge — Autonomous Agent Coding System

## What This Is
Forge is a Claude Code CLI plugin that provides an autonomous, spec-driven development loop.
Three commands: `/forge brainstorm`, `/forge plan`, `/forge execute` — they chain together
to take an idea from concept to working code with minimal human intervention.

## Project Structure
```
forge/
├── .claude-plugin/plugin.json     — Plugin manifest
├── commands/                      — Slash commands (/forge brainstorm, plan, execute, etc.)
├── skills/                        — Procedural workflows + cross-cutting skills (guardrails, graphify, design-system)
├── agents/                        — Specialized subagents (speccer, planner, executor, reviewer, verifier, researcher)
├── hooks/                         — Stop hook (loop engine), token monitor (PostToolUse)
├── scripts/                       — JS utility (forge-tools.cjs) + bash helpers
├── templates/                     — Output file templates (spec, plan, state, summary)
├── references/                    — Reference docs (token profiles, backprop patterns, multi-repo, etc.)
└── docs/superpowers/specs/        — Design specs for this project
```

## Workflow Enforcement (CRITICAL)

The Forge workflow is strictly sequential: **brainstorm -> plan -> execute**. This is enforced at multiple levels:

1. **Spec approval gate**: Only the brainstorming skill writes `status: approved` specs, and only after explicit user approval of an approach. The execute command validates this.
2. **Frontier requirement**: `/forge execute` validates that every approved spec has a corresponding frontier file from `/forge plan`.
3. **Programmatic validation**: `forge-tools.cjs setup-state` runs `validateWorkflowPrerequisites()` which checks spec approval status and frontier existence before allowing execution.
4. **State machine phases**: `brainstorming` and `planning` are formal phases in the state machine (see `references/state-machine.md`).

**Never skip brainstorming.** Even if the user's request seems clear, the interactive Q&A surfaces hidden assumptions, the approach proposals prevent over-engineering, and the approved spec provides verifiable acceptance criteria for the reviewer and verifier.

## Architecture
- **Lean plugin** — installable via `claude plugin install forge`, no npm dependency for users
- **Smart loop** — Stop hook reads state and routes to the correct next action (not dumb re-feed)
- **Three-layer loop** — Outer (phase progression) → Middle (task progression) → Inner (quality iteration)
- **Adaptive depth** — Auto-detects complexity, scales ceremony (quick/standard/thorough), user can override
- **Context resets** — At 60% context usage, saves handoff snapshot and starts fresh session
- **Token budget** — PostToolUse hook tracks usage, auto-downgrades depth when budget runs low
- **Capability discovery** — Scans for user's MCP servers and skills, routes work to leverage them
- **Multi-repo** — Natively coordinates work across multiple repos (API-first ordering)
- **Backpropagation** — Traces runtime bugs back to specs, generates regression tests
- **Live TUI dashboard** — Opt-in visualization layer (`/forge watch` or `FORGE_TUI=1`) parses `claude --output-format stream-json` and renders a zero-dependency ANSI dashboard via `scripts/forge-tui.cjs`. Augments the bash runner; falls back to plain mode automatically on sentinel exit code 87

## Key Conventions
- All state lives in `.forge/` per-project (gitignored)
- Specs: `.forge/specs/spec-{domain}.md` with R-numbered requirements
- Plans: `.forge/plans/{spec}-frontier.md` with tiered task DAGs
- State: `.forge/state.md` tracks current position, decisions, progress
- Token ledger: `.forge/token-ledger.json` tracks cumulative usage
- Atomic commits per task with descriptive messages
- Circuit breakers prevent infinite loops (3x fail → debug mode, 3x debug → human)

## Platform
- **Target**: Windows (Claude Code runs in WSL, but plugin should be cross-platform compatible)
- **Shell scripts**: Use `#!/usr/bin/env bash` for portability
- **JS utility**: Node.js (forge-tools.cjs) — CommonJS for broad compatibility
- **Path handling**: Always use forward slashes in JS, handle Windows paths in bash scripts
- **No native dependencies** — pure JS + bash, no compilation step

## Tech Stack
- Plugin format: Claude Code plugin spec (plugin.json, commands/, skills/, agents/, hooks/)
- Scripting: Node.js (CommonJS) for forge-tools.cjs, Bash for hooks
- State: Markdown files + JSON (no database)
- No build step, no bundler, no framework

## Development Workflow
- Design specs in `docs/superpowers/specs/`
- Test locally: `claude --plugin-dir /home/lucasduys/forge`
- Reload without restart: `/reload-plugins`
- Keep scripts POSIX-compatible where possible for cross-platform

## Code Style
- JS: CommonJS (`require`/`module.exports`), no TypeScript (keep it simple for contributors)
- Markdown: YAML frontmatter for metadata, consistent heading hierarchy
- Agent prompts: Clear role, explicit constraints, output format specified
- Bash: `set -euo pipefail`, quote all variables, use `${CLAUDE_PLUGIN_ROOT}` for paths

## What NOT To Do
- Don't add npm dependencies — this must be zero-install for users
- Don't use TypeScript — CJS is simpler and doesn't need compilation
- Don't hardcode repo paths or project-specific assumptions
- Don't make MCP servers required — Forge works standalone, MCPs enhance it
- Don't over-engineer the first version — get the loop working, iterate

---

## New in v2.1 (GSD-2 + Caveman Integration)

### Token Budgets with Hard Ceilings
- Per-task budgets: quick=5k, standard=15k, thorough=40k (configurable via `per_task_budget`)
- Session budget: `session_budget_tokens` (default 500000)
- Enforced at every state machine transition via `checkSessionBudget()`
- At 80% per-task: warning injected into next prompt
- At 100% per-task: state transitions to `budget_exhausted`, handoff written to `.forge/resume.md`

### Git Worktree Isolation
- Each task runs in `.forge/worktrees/{task-id}/`
- Success: squash-merge with atomic commit `forge({domain}): {task_name} [T{num}]`
- Failure: worktree discarded, parent branch untouched
- Conflicts: transition to `conflict_resolution` phase, worktree preserved
- Skipped for quick+single-file tasks or when `use_worktrees: false`

### Lock-File Crash Recovery
- `.forge/.forge-loop.lock` with PID, start time, current task, heartbeat
- 5-minute stale threshold, takeover supported
- `/forge resume` runs `performForensicRecovery()` first: reconstructs state from lock + checkpoints + git log
- Orphan worktrees detected but never auto-deleted

### Task Checkpoints
- `.forge/progress/{task-id}.json` written at each step
- 10-value enum: spec_loaded, research_done, planning_done, implementation_started, tests_written, tests_passing, review_pending, review_passed, verification_pending, complete
- On resume, executor picks up from last checkpoint step
- Cleaned up on successful task completion

### Headless Mode
- `node scripts/forge-tools.cjs headless execute --spec <domain>` for CI/cron
- `node scripts/forge-tools.cjs headless query [--json] [--watch]` for monitoring
- Exit codes: 0=complete, 1=failed, 2=budget_exhausted, 3=blocked, 4=lock_conflict
- Query completes in <5ms with zero LLM calls
- 17 fields in the JSON schema, versioned at 1.0

### Caveman Skill for Internal Output
- `skills/caveman-internal/SKILL.md` (adapted from JuliusBrussee/caveman, MIT)
- Three intensity modes (lite/full/ultra) auto-selected by task budget remaining
- Auto-applied to internal state files, checkpoint context bundles, handoff notes, routine review/verification reports
- Exclusions: source code, commits, specs, security warnings, user-facing errors
- `formatCavemanValue()` exported from forge-tools.cjs
- `skipCavemanFormat: true` option on writeState/writeCheckpoint for verbose override
- Shipped behind `terse_internal: false` default until benchmark tuning (see `docs/benchmarks/caveman-integration.md`)

### Test Suite
- 100 tests across 9 suites, ~2.4s runtime
- `node scripts/run-tests.cjs` runs all tests
- `node tests/budget.test.cjs` runs single file
- Zero dependencies, uses only `node:assert`
- Covers: budget math, locks, state read/write, checkpoints, worktrees, headless query, route decisions, frontier parsing
- See `docs/testing.md` for full guide

## New Config Fields
```json
{
  "session_budget_tokens": 500000,
  "per_task_budget": { "quick": 5000, "standard": 15000, "thorough": 40000 },
  "terse_internal": false,
  "use_worktrees": true,
  "headless_notify_url": null
}
```

Full schema: `references/config-schema.md`

## New in v0.2.0 (Karpathy + Graphify + Design System)

### Karpathy Behavioral Guardrails
- `skills/karpathy-guardrails/SKILL.md` — four principles enforced across all agents
- Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution
- Executor: checks before coding, builds only what AC requires, traces every changed line
- Reviewer: flags over-engineering, scope creep, silent assumptions, goal misalignment
- Planner: rejects gold-plated tasks, enforces one concern per task

### Graphify Knowledge Graph Integration
- `skills/graphify-integration/SKILL.md` — optional codebase knowledge graph support
- Planner: aligns task boundaries with community clusters, orders by node connectivity
- Researcher: queries graph for architecture context before external docs
- Reviewer: graph-based blast radius analysis
- Executor: focused context from relevant subgraph
- Graceful degradation: no graph = standard behavior unchanged

### DESIGN.md Design System Support
- `skills/design-system/SKILL.md` — design specification integration for UI tasks
- Brainstorming: asks about design requirements, can generate DESIGN.md from brand catalogs
- Planning: tags UI tasks with `design:`, adds design verification tasks
- Execution: loads design tokens as implementation constraints
- Review: design compliance pass checking palette, typography, spacing
- Graceful degradation: no DESIGN.md = standard behavior unchanged

## New Reference Docs
- `references/config-schema.md` — all config fields with defaults
- `references/state-machine.md` — phase transitions + ASCII diagram
- `references/forge-directories.md` — complete .forge/ directory contract
- `references/checkpoint-schema.md` — 13-field JSON schema with enum transitions
- `references/headless-status-schema.md` — headless query JSON schema
- `skills/caveman-internal/references/budget-thresholds.md` — intensity selection thresholds
- `docs/benchmarks/caveman-integration.md` — caveman token savings measurements
- `docs/benchmarks/worktree-overhead.md` — worktree create/remove timing
- `docs/testing.md` — test runner usage

## New forge-tools.cjs Functions (exported)
- Budget: `registerTask`, `recordTaskTokens`, `checkTaskBudget`, `resolveTaskBudget`, `budgetStatusReport`
- Locks: `acquireLock`, `releaseLock`, `heartbeat`, `detectStaleLock`, `readLock`
- State: `writeState` (legacy 3-arg + partial 2-arg + `skipCavemanFormat` opt)
- Checkpoints: `writeCheckpoint`, `readCheckpoint`, `updateCheckpoint`, `listCheckpoints`, `deleteCheckpoint`
- Worktrees: `createTaskWorktree`, `removeTaskWorktree`, `listTaskWorktrees`, `completeTaskInWorktree`, `abortTaskInWorktree`
- Conflicts: `detectFileConflicts`, `serializeConflictingTasks`, `planTierExecution`
- Route: `checkSessionBudget`, `writeBudgetExhaustedHandoff`
- Recovery: `performForensicRecovery`
- Headless: `runHeadless`, `queryHeadlessState`, `HEADLESS_EXIT`, `HEADLESS_STATUS_SCHEMA_VERSION`
- Caveman: `formatCavemanValue`

## Parallel Edit Safety
When multiple agents modify `forge-tools.cjs` concurrently:
- Use `acquireLock(forgeDir, taskId)` before editing
- Re-read file after edit failures (staleness)
- Edit tool auto-detects staleness and rejects stale edits
- Write integration tests alongside functions to catch regressions from parallel merges
