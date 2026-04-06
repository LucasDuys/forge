<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg">
    <img alt="Forge" src="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg" width="600">
  </picture>
</p>

<h3 align="center">One idea in. Tested, reviewed, committed code out.</h3>

<p align="center">
  <a href="https://github.com/LucasDuys/forge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://github.com/LucasDuys/forge/stargazers"><img src="https://img.shields.io/github/stars/LucasDuys/forge?style=flat" alt="Stars"></a>
  <a href="https://github.com/LucasDuys/forge/releases"><img src="https://img.shields.io/badge/version-2.1-green" alt="Version"></a>
  <a href="https://github.com/LucasDuys/forge#test-suite"><img src="https://img.shields.io/badge/tests-100%20passing-brightgreen" alt="Tests"></a>
  <a href="https://lucasduys.github.io/forge/"><img src="https://img.shields.io/badge/docs-architecture_video-orange" alt="Docs"></a>
</p>

<p align="center">
  <a href="https://lucasduys.github.io/forge/">Watch the architecture video</a>
</p>

---

## Table of Contents

- [The Problem](#the-problem)
- [Quickstart](#quickstart)
- [What's New in v2.1](#whats-new-in-v21)
- [Forge vs The Alternatives](#forge-vs-the-alternatives)
- [Architecture](#architecture)
- [Token Budgets and Hard Ceilings](#token-budgets-and-hard-ceilings)
- [Worktree Isolation](#worktree-isolation)
- [Crash Recovery and Forensic Resume](#crash-recovery-and-forensic-resume)
- [Headless Mode](#headless-mode)
- [Caveman Token Optimization](#caveman-token-optimization)
- [Seven Specialized Agents](#seven-specialized-agents)
- [Circuit Breakers](#circuit-breakers)
- [Goal-Backward Verification](#goal-backward-verification)
- [Backpropagation](#backpropagation)
- [Test Suite](#test-suite)
- [Commands](#commands)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Platform Support](#platform-support)
- [Credits](#credits)
- [License](#license)

---

## The Problem

Claude Code is powerful, but for non-trivial features you become the glue: prompting, reviewing, re-prompting, losing context, starting over. A 12-task feature takes dozens of manual exchanges and multiple sessions.

You are the project manager. You are the state machine. You are the thing keeping everything from falling apart.

**Forge replaces you as the glue.**

```
/forge brainstorm "your feature idea"
/forge plan
/forge execute --autonomy full
```

You describe what you want. Forge writes the spec, plans the tasks, runs them with TDD, reviews the code, verifies against acceptance criteria, and commits atomically. You read the diffs.

---

## Quickstart

Requires Claude Code v1.0.33+. No npm install, no build step, no dependencies.

```bash
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

Three commands to ship a feature:

```bash
/forge brainstorm "add rate limiting to the /api/search endpoint with per-user quotas"
/forge plan
/forge execute --autonomy full
```

Three commands to monitor and recover:

```bash
/forge status                                    # dashboard: phase, budget, locks, checkpoints
/forge resume                                    # pick up after crashes or context resets
node scripts/forge-tools.cjs headless query      # machine-readable state snapshot
```

---

## What's New in v2.1

v2.1 closes the production-readiness gap by adding the features that separate a clever prototype from a tool you can actually trust with an autonomous loop:

- **Token budgets with hard ceilings** per task and per session. No more silent overruns at 3am.
- **Git worktree isolation** per task. Failed tasks get discarded without polluting your main branch. Successful tasks squash-merge with atomic commit messages.
- **Lock-file crash recovery** via forensic resume. If a session crashes mid-task, `/forge resume` reconstructs state from lock file, checkpoints, and git log. Orphan worktrees are detected but never auto-deleted.
- **Headless mode** for CI and cron. `forge headless query` returns a JSON state snapshot in under 5ms with zero LLM calls. `forge headless execute` runs unattended with proper exit codes.
- **Caveman skill integration** (native). Internal agent artifacts (state files, handoff notes, checkpoints, review notes) use terse caveman-form output. Measured 26.8% token reduction on prose-only content. User-facing output stays verbose. Attribution: [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT).
- **Test suite**. 100 tests across 9 suites covering budget math, lock primitives, state read/write, checkpoints, worktrees, headless query, route decisions, and frontier parsing. Runs in ~2.4 seconds with zero dependencies.
- **Benchmarks documented** for worktree overhead, caveman savings, and headless query timing.

---

## Forge vs The Alternatives

Honest positioning. All three tools solve overlapping problems; the right choice depends on what you value.

| Dimension | Forge | Ralph Loop | GSD-2 |
|---|---|---|---|
| **Core metaphor** | Native Claude Code plugin with streaming DAG + state machine | Re-feed same prompt in a while loop | Standalone TypeScript agent harness on Pi SDK |
| **State model** | Task DAG, lock file, per-task checkpoints, token ledger | One integer (`iteration`) + active flag | Full state machine in external TypeScript |
| **Task decomposition** | Milestone > Spec > R-number > Task DAG, adaptive depth | None. Claude figures it out from files | Milestone > Slice > Task hierarchy |
| **Context isolation** | Handoff + resume in new Claude Code session at 60% | Same session, context accumulates | Fresh 200k window per task via Pi SDK |
| **Stop condition** | DAG complete + verifier pass, or budget ceiling | `--max-iterations` OR exact `<promise>` match. Default infinite. | Budget ceiling + verification + Escape key |
| **Cost controls** | Per-task + session token budgets, hard ceilings | None built-in | Per-unit token ledger with budget ceilings |
| **Git isolation** | Per-task worktrees with squash-merge | None | Worktree isolation per slice |
| **Crash recovery** | Lock file + forensic resume from checkpoints + git log | None | Lock files + session forensics |
| **Verification** | Goal-backward verifier (existence > substantive > wired > runtime) | Whatever you put in the prompt | Auto-fix retries on test/lint failures |
| **Setup** | `claude plugin install` | Built into Claude Code | `npm install -g gsd-pi` |
| **Lives in** | Your existing Claude Code session | Your existing Claude Code session | Separate TUI harness |
| **Author** | Lucas Duys | Anthropic (technique by Geoffrey Huntley) | TÂCHES |

**When Forge wins:** you already love Claude Code and want autonomous execution without leaving it. Native plugin architecture, zero install friction, adaptive depth scoring, multi-repo coordination, backpropagation, readable source (markdown + bash + CJS).

**When GSD-2 wins:** you want a battle-tested harness with more engineering hours behind it, hard per-task budget ceilings from day one, and you're willing to switch to a separate TUI.

**When Ralph Loop wins:** you have a tightly-scoped greenfield task with binary verification (tests pass or fail), you don't care about cost, and you want the absolute minimum infrastructure.

---

## Architecture

### The Three-Tiered Loop

Forge runs three nested loops. Each has its own circuit breakers and progression logic.

**Outer loop: Phase progression.** Controls which spec is active and which phase runs next. Phases: `idle` > `executing` > `reviewing_branch` > `verifying` > `idle`. New in v2.1: `budget_exhausted`, `conflict_resolution`, `recovering`, `lock_conflict`. Driven by the stop-hook state machine.

**Middle loop: Task progression.** Within a spec, tasks advance through the dependency DAG. Streaming topological dispatch: tasks start the instant their specific dependencies complete, not when the entire tier finishes. 20-40% faster than tier-gated waves.

**Inner loop: Quality iteration.** Each task cycles through `implement > test > fix (max 3) > debug > Codex rescue > redecompose > blocked`. Circuit breakers at every transition prevent infinite loops.

### The Self-Prompting Engine

The stop hook (`hooks/stop-hook.sh`) intercepts every Claude exit. It reads state from `.forge/.forge-loop.json`, calls `routeDecision()` in `forge-tools.cjs` (a 200+ line state machine), and either blocks exit with the next prompt or allows it. Claude never needs a human to tell it what to do next.

```
Claude acts > attempts exit > stop hook fires > routeDecision() > block with next prompt > repeat
```

New in v2.1: the stop hook also updates a lock-file heartbeat on every invocation (5-minute stale threshold), detects session ownership, and honors the `budget_exhausted` phase for clean exit without a blocking prompt.

Completion signal: Claude outputs `<promise>FORGE_COMPLETE</promise>` only when all tasks are complete and verified. The hook detects it, generates a summary, releases the lock, deletes the loop file, and allows exit.

### Execution Flow

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

---

## Token Budgets and Hard Ceilings

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

---

## Worktree Isolation

Each task runs in its own git worktree at `.forge/worktrees/{task-id}/`. On success, the worktree's commits are squash-merged into the parent branch with an atomic commit message:

```
forge(auth): implement JWT refresh rotation [T007]
```

On failure, the worktree is removed without touching the parent branch. Your main branch only ever sees green, reviewed, verified code.

Worktree creation is skipped for tasks that don't need it:
- `depth: quick` with a single file change
- Pure research or spec tasks with zero files touched
- Configured opt-out via `use_worktrees: false`

Merge conflicts trigger a transition to `conflict_resolution` phase. The worktree is preserved for human inspection. The scheduler falls back to sequential execution for the remaining tier.

Parallel tasks with overlapping file targets are automatically serialized. Disjoint tasks run truly parallel in separate worktrees.

---

## Crash Recovery and Forensic Resume

Sessions can crash. Machines can reboot. Context windows can run out mid-task. Forge handles all of these without losing work.

**Lock file heartbeat** -- every stop-hook invocation updates `.forge/.forge-loop.lock` with a fresh timestamp. After 5 minutes with no heartbeat, the lock is considered stale and can be taken over.

**Task checkpoints** -- the executor writes `.forge/progress/{task-id}.json` after each major step: spec loaded, research done, planning done, implementation started, tests written, tests passing, review pending. On resume, execution picks up from the last checkpoint step.

**Forensic recovery** -- `/forge resume` runs a recovery scan before continuing:

```
$ /forge resume

Recovery report:
  committed tasks:    T001 T002 T003 T004 T005 T006 T007
  resume point:       T008 (implementation_started)
  active checkpoints: 1 (T008)
  stale lock:         taken over from pid 14231
  orphan worktrees:   none
  session budget:     156400 / 500000 used
  warnings:           none
  needs_human:        false

Continuing execution from T008...
```

Recovery never auto-deletes user work. Orphan worktrees are flagged with warnings but require explicit action to remove.

Budget exhaustion has a dedicated recovery path: the handoff doc at `.forge/resume.md` explains why execution halted and what config change unblocks continuation.

---

## Headless Mode

For CI, cron jobs, and automated pipelines. Zero interactive prompts.

```bash
$ node scripts/forge-tools.cjs headless execute --forge-dir .forge --spec auth-v2

[14:30:01Z] lock acquired
[14:30:02Z] spec loaded -> 29 tasks
[14:30:03Z] executing T001
...
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | All tasks complete and verified |
| 1 | Failed with unrecoverable error |
| 2 | Budget exhausted (recoverable) |
| 3 | Blocked, needs human decision |
| 4 | Lock conflict with another session |

Machine-readable state queries in under 5ms:

```bash
$ node scripts/forge-tools.cjs headless query --forge-dir .forge --json

{
  "schema_version": "1.0",
  "queried_at": "2026-04-06T14:30:15Z",
  "phase": "executing",
  "current_task": "T008",
  "spec_domain": "auth-v2",
  "tier": 3,
  "completed_tasks": 7,
  "remaining_tasks": 22,
  "token_budget_used": 156400,
  "token_budget_remaining": 343600,
  "last_heartbeat": "2026-04-06T14:30:12Z",
  "lock_status": "held",
  "active_checkpoints": 1,
  "autonomy": "full",
  "depth": "standard",
  "tool_count": 247,
  "last_error": null
}
```

Watch mode for monitoring during long runs:

```bash
node scripts/forge-tools.cjs headless query --watch
```

Schema is versioned. Fields are additive across versions. See `references/headless-status-schema.md` for the full field reference and a sample Prometheus exporter.

---

## Caveman Token Optimization

Internal agent artifacts are written in caveman form to reduce token cost on every read of the loop.

Three intensity modes, selected automatically based on remaining task budget:

| Budget remaining | Mode | Typical reduction |
|---|---|---|
| Above 50% | lite | ~10-15% |
| 20-50% | full | ~25-30% |
| Below 20% | ultra | ~60-65% |

What gets compressed:
- State.md notes and transition logs
- Progress checkpoint context bundles and error logs
- Resume handoff docs
- Review notes for minor issues
- Verifier pass reports
- Agent-to-agent handoff messages

What stays verbose (always):
- Source code, diffs, commit messages
- PR descriptions
- User-facing specs and plans
- Security warnings
- Errors requiring human action
- Acceptance criteria for backpropagation

Measured savings on internal state writes: **26.8% prose reduction** on free-text content, **46% reduction** on the state.md phase documentation section. Full benchmark at `docs/benchmarks/caveman-integration.md`.

Attribution: adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT License). The skill file at `skills/caveman-internal/SKILL.md` credits the original and is not exposed as a user-facing `/caveman` command.

---

## Seven Specialized Agents

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

---

## Circuit Breakers

Seven levels of circuit breakers prevent infinite loops and runaway spending. Each escalates to the next when exhausted.

| Level | Trigger | Threshold | Action |
|-------|---------|-----------|--------|
| 1 | Test failures | 3 consecutive | Enter DEBUG mode |
| 2 | Debug attempts | 2 failures | Codex rescue (different model, fresh perspective) |
| 3 | Debug exhaustion | 3 total | Re-decompose task into sub-tasks (T005.1, T005.2) |
| 4 | Review iterations | 3 passes | Accept with warnings, move on |
| 5 | No progress | 2 identical snapshots | Block for human |
| 6 | Max iterations | 100 (configurable) | Save state, force exit |
| 7 | Token budget | 100% of session or per-task | Graceful handoff to `.forge/resume.md` |

---

## Goal-Backward Verification

The verifier works backwards from the spec, not forwards from the tasks. Four levels:

| Level | Checks |
|-------|--------|
| **Existence** | Do expected files, functions, routes, migrations exist? |
| **Substantive** | Real code, not stubs? Detects TODO, hardcoded returns, empty catch, skipped tests, placeholder components. |
| **Wired** | Module imported where used? Route registered? Middleware applied? Dead code = not satisfied. |
| **Runtime** | If Playwright: E2E tests. If Stripe: webhook handlers. If Vercel: deploy preview. If gh: CI status. |

---

## Backpropagation

When a bug is found post-execution, `/forge backprop` traces it back to the spec gap that allowed it.

1. **TRACE** -- Which spec and R-number does this bug map to?
2. **ANALYZE** -- Gap type: missing criterion, incomplete criterion, or missing requirement
3. **PROPOSE** -- Spec update for human approval
4. **GENERATE** -- Regression test that would have caught it
5. **VERIFY** -- Run test (should fail, confirming the gap). Optionally re-execute affected tasks.
6. **LOG** -- Record in backprop history. After 3+ gaps of the same category, suggest systemic changes to future brainstorming questions.

---

## Test Suite

100 tests across 9 suites, zero dependencies, runs in ~2.4 seconds:

```bash
$ node scripts/run-tests.cjs

budget.test.cjs      20 passed
locks.test.cjs       13 passed
state.test.cjs       22 passed
checkpoints.test.cjs 19 passed
worktrees.test.cjs    6 passed
headless.test.cjs     6 passed
route.test.cjs        8 passed
frontier.test.cjs     5 passed
forge-tools.test.cjs  1 passed (legacy)

Total: 100 passed, 0 failed, 2.4s
```

Run a single suite:

```bash
node tests/budget.test.cjs
```

Filter suites by name:

```bash
node scripts/run-tests.cjs --filter locks
```

All tests use isolated temp directories via `fs.mkdtempSync` and clean up on exit. Tests skip gracefully if git is not available. See `docs/testing.md` for the full guide.

---

## Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge brainstorm [topic]` | Interactive spec generation | `--from-code`, `--from-docs path/` |
| `/forge plan` | Decompose specs into streaming DAG | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge resume` | Continue after context reset or crash | Runs forensic recovery first |
| `/forge backprop [desc]` | Trace bug to spec gap | `--from-test path/` |
| `/forge status` | Unified dashboard: phase, budget, locks, checkpoints | `--json` |
| `/forge review-branch` | Review unmerged branch | `--base main`, `--fix`, `--comment` |
| `/forge setup-tools` | Detect and install CLI tools | |

### Autonomy Levels

| Level | Behavior | Best For |
|---|---|---|
| `full` | Runs unattended, handles context resets and budget exhaustion | Long-running features, overnight |
| `gated` | Pauses between phases for approval | Recommended default |
| `supervised` | Pauses between individual tasks | Maximum oversight |

### Headless Subcommands

```bash
node scripts/forge-tools.cjs headless execute --spec <domain>   # CI/cron execution
node scripts/forge-tools.cjs headless query                     # JSON state snapshot
node scripts/forge-tools.cjs headless status                    # alias for query
node scripts/forge-tools.cjs headless query --watch             # live monitoring
```

---

## Configuration

`.forge/config.json` (auto-created on first brainstorm):

```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "session_budget_tokens": 500000,
  "per_task_budget": {
    "quick":    5000,
    "standard": 15000,
    "thorough": 40000
  },
  "terse_internal": false,
  "use_worktrees": true,
  "headless_notify_url": null
}
```

See `references/config-schema.md` for the full field reference including model routing, token hooks, adaptive replanning, Codex hybrid, and circuit breaker thresholds.

---

## Project Structure

```
forge/
  commands/           Slash commands (brainstorm, plan, execute, resume, backprop, status)
  skills/             Procedural workflows (brainstorming, planning, executing, reviewing)
    caveman-internal/   Token optimization skill (adapted from JuliusBrussee/caveman)
  agents/             Specialized subagents with model routing + artifact contracts
  hooks/              Self-prompting engine (stop hook state machine + token hooks)
  scripts/            Core utilities (state machine, routing, budgeting, locks, worktrees)
    run-tests.cjs       Zero-dep test runner
    bench-caveman-*.cjs Caveman benchmarks
    bench-worktree-*.cjs Worktree overhead benchmarks
  tests/              9 test suites, 100 assertions
  templates/          Output + config templates (state.md, resume.md in caveman form)
  references/         Reference docs
    config-schema.md
    state-machine.md
    forge-directories.md
    checkpoint-schema.md
    headless-status-schema.md
    budget-thresholds.md
  docs/
    testing.md          How to run the test suite
    benchmarks/         Caveman + worktree overhead measurements
```

---

## Platform Support

Works on macOS, Linux, and Windows (WSL and Git Bash). Pure JavaScript (CommonJS) + Bash. No native dependencies, no build step.

Cross-platform quirks:
- Windows Git Bash has higher process startup overhead (~80ms bash + ~100ms node). Hook performance floors are documented in `hooks/token-monitor.sh`.
- File locking is advisory on all platforms (presence of lock file + heartbeat freshness, not `flock`).
- Atomic writes use temp-file-rename pattern with EBUSY retry on Windows.

---

## Credits

- **Caveman skill** adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) under MIT License. The original inspired the internal token optimization approach.
- **Ralph Loop pattern** by [Geoffrey Huntley](https://ghuntley.com/ralph/). Forge's self-prompting loop is a smarter-state-machine variant of the core idea.
- **Spec-driven development** concepts from GSD v1 by TÂCHES. Forge's milestone/phase/plan hierarchy is philosophically adjacent.
- **Claude Code plugin system** by Anthropic. Forge is a native extension, not a wrapper.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run tests: `node scripts/run-tests.cjs`
5. Open a pull request

---

## License

[MIT](LICENSE)
