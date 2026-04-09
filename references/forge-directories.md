# Forge Directory Layout

The `.forge/` directory is per-project runtime state for the Forge plugin. It is created on first use of any `/forge` command and lives in the working directory of the project (not inside any single repo when multi-repo). Most contents are gitignored; a few stable artifacts are kept in version control for team visibility.

This document is the canonical contract for what every directory and file means, who reads it, who writes it, and how its lifecycle works.

## Top-Level Layout

```
.forge/
├── config.json                — Project configuration (repos, depth, autonomy, flags)
├── capabilities.json          — Detected MCP servers, CLI tools, skills
├── token-ledger.json          — Cumulative token usage across runs
├── state.md                   — Current phase, in-flight task, decisions, history
├── resume.md                  — Handoff snapshot written before context resets
├── .forge-loop.lock           — Active execution lock (PID, heartbeat, current task)
├── .forge-loop.json           — Loop engine internal state (iteration counts, fail counts)
├── specs/                     — Approved specs with R-numbered requirements
├── plans/                     — Task frontiers (DAGs) generated from specs
├── progress/                  — Per-task resumable checkpoints (NEW, R008)
├── worktrees/                 — Per-task git worktrees (NEW, R004)
├── runs/                      — Headless execution logs (NEW, R009)
├── artifacts/                 — Per-task artifact summaries consumed by downstream tasks
├── summaries/                 — Phase and milestone summaries
├── research/                  — forge-researcher reports
├── history/                   — Archived prior runs
└── task-status.json           — Quick-read snapshot of frontier task statuses
```

## Persistent Files (kept in git)

These are the high-value, low-churn artifacts a team wants under version control.

### `specs/spec-{domain}.md`
- **Format:** Markdown with YAML frontmatter, R-numbered requirements, acceptance criteria checkboxes.
- **Written by:** `/forge brainstorm` (forge-speccer agent).
- **Read by:** `/forge plan`, `/forge execute`, all executor and reviewer agents, `/forge backprop`.
- **Lifecycle:** Created during brainstorming, updated by backpropagation when bugs reveal spec gaps. Never auto-deleted.

### `plans/{spec}-frontier.md`
- **Format:** Markdown task DAG with task IDs, dependencies, repo tags, token estimates, R-number coverage.
- **Written by:** `/forge plan` (forge-planner agent).
- **Read by:** `/forge execute`, executors (to know dependencies and provides/consumes), `/forge status`.
- **Lifecycle:** Created during planning, regenerated when spec changes meaningfully.

### `state.md`
- **Format:** Markdown with YAML frontmatter (phase, current_task, task_status, depth, autonomy).
- **Written by:** Loop engine (stop hook), all executor agents on task completion.
- **Read by:** Every command, the loop engine, recovery flow.
- **Lifecycle:** Long-lived, append-only history sections. Never deleted.

## Runtime Files (gitignored)

These are ephemeral, machine-generated, and either large or volatile. They should not pollute git history.

### `progress/{task-id}.json` (R008)
Resumable per-task checkpoints written by executor agents during task execution.

- **Format (JSON):**
  ```json
  {
    "task_id": "T003",
    "step_name": "tests_written",
    "timestamp": "2026-04-05T14:23:11Z",
    "artifacts_produced": ["src/auth.ts", "src/__tests__/auth.test.ts"],
    "next_step": "run_tests"
  }
  ```
- **Step names (canonical sequence):** `spec_loaded`, `dependencies_read`, `research_done`, `implementation_started`, `tests_written`, `tests_passing`, `committed`.
- **Written by:** forge-executor agent after each significant step.
- **Read by:** forge-executor on resume (picks up from `next_step`), `/forge status` (shows current checkpoint), `/forge resume` (recovery flow).
- **Lifecycle:**
  1. Created on first significant step of a task.
  2. Overwritten in place after each subsequent step.
  3. Deleted automatically on successful task completion (after the squash merge commit).
  4. Survives crashes, context resets, lock expiry, and machine restarts.
- **Concurrency:** One file per task ID. Multiple parallel tasks have multiple files. Writes are atomic via temp-file-and-rename.

### `worktrees/{task-id}/` (R004)
Git worktree directories for task isolation. Each subdirectory is a real git worktree branched from the parent HEAD at task start.

- **Format:** Real git worktree (not a regular folder). Created via `git worktree add .forge/worktrees/{task-id} HEAD`.
- **Written by:** `forge-tools.cjs createTaskWorktree(taskId)` at task start.
- **Read by:** The forge-executor agent for that task uses this directory as its working directory for all file operations.
- **Lifecycle:**
  1. Created at task start (skipped if `depth: quick`, zero file targets, or `use_worktrees: false`).
  2. Executor performs all reads, writes, and per-task commits inside the worktree.
  3. On task success: squash-merged into parent branch with message `forge({domain}): {task_name} [T{num}]`, then removed via `git worktree remove`.
  4. On task failure or abort: removed via `git worktree remove --force`, no changes propagate to parent branch.
  5. Orphaned worktrees (lock expired, process crashed) are detected and cleaned up by `/forge resume`.
- **Fallback:** If `git worktree` fails (shallow clone, submodules, locked index), executor falls back to in-place execution with a warning logged to `state.md`.
- **Conflict handling (R005):** Tasks with overlapping file targets are serialized by the planner so worktrees never compete for the same paths in the same tier.

### `runs/{timestamp}/log.txt` (R009)
Headless mode execution logs. Created when running `forge headless execute`.

- **Format:** Plain text log, one line per loop iteration plus full command output.
- **Written by:** Headless mode loop engine (replaces stdout writes).
- **Read by:** External monitoring (tail), post-mortem analysis, `/forge status --run {timestamp}`.
- **Lifecycle:** Created at headless run start. Never auto-deleted (operator manages retention).

### `.forge-loop.lock` (R007)
Active execution lock file. Prevents concurrent `/forge execute` invocations from corrupting state.

- **Format (JSON):**
  ```json
  {
    "pid": 48213,
    "started_at": "2026-04-05T13:00:00Z",
    "current_task": "T003",
    "last_heartbeat": "2026-04-05T14:23:11Z"
  }
  ```
- **Written by:** Loop engine on execute start; heartbeat refreshed every 30 seconds.
- **Read by:** Concurrent `/forge execute` attempts (refuse or attach), `/forge resume` (detect stale locks).
- **Lifecycle:**
  1. Created when execution starts.
  2. Heartbeat field updated every 30 seconds.
  3. Released cleanly on normal completion.
  4. Considered stale by `/forge resume` if heartbeat is older than 5 minutes; recovery flow takes over.

### `.forge-loop.json`
Loop engine internal counters: iteration count for current task, consecutive fail count, debug-mode entry count, current circuit-breaker state. Pure machine state, not human-edited.

### `capabilities.json`
Discovered MCP servers, CLI tools, skills, and CLI-Anything availability. Regenerated by `/forge setup-tools`.

### `token-ledger.json`
Cumulative token usage. Updated by the PostToolUse token monitor hook. Used to drive depth auto-downgrade.

### `task-status.json`
Quick-read snapshot of frontier task statuses (completed, in_progress, blocked, pending). Avoids re-parsing the frontier markdown for `/forge status` calls.

### `artifacts/{task-id}.json`
Per-task artifact summaries written at task completion. Lists what the task produced (`provides:` from frontier), files created, files modified, key decisions. Read by downstream tasks instead of re-reading the source code.

### `summaries/`, `research/`, `history/`
Auxiliary outputs from various agents. Useful, but high-volume and low-stability, so gitignored.

## What Should Be Gitignored

The persistent files above (specs, plans, state.md) are valuable for team visibility and should be committed. Everything else is runtime state that would create noise or leak machine-specific paths.

```
# Forge runtime state — gitignore these
.forge/progress/
.forge/worktrees/
.forge/runs/
.forge/.forge-loop.lock
.forge/.forge-loop.json
.forge/capabilities.json
.forge/token-ledger.json
.forge/task-status.json
.forge/artifacts/
.forge/summaries/
.forge/research/
.forge/history/
.forge/resume.md

# Forge persistent state — keep in git
!.forge/specs/
!.forge/plans/
!.forge/state.md
!.forge/config.json
```

A ready-to-copy template lives at `templates/gitignore.forge`. Projects can append it to their existing `.gitignore` or use the broader plugin-level rule `.forge/` (which gitignores everything; only use this if your team does not want any Forge state in git).

## Lifecycle Summary by Component

| Component             | Reads                                              | Writes                                                  |
|-----------------------|----------------------------------------------------|---------------------------------------------------------|
| `/forge brainstorm`   | (none)                                             | `specs/`                                                |
| `/forge plan`         | `specs/`, `capabilities.json`                      | `plans/`, `state.md`                                    |
| `/forge execute`      | All                                                | `state.md`, `.forge-loop.lock`, `.forge-loop.json`      |
| forge-executor agent  | `specs/`, `plans/`, `artifacts/`, `progress/{id}`  | `progress/{id}`, `worktrees/{id}`, `artifacts/{id}`     |
| forge-reviewer agent  | `specs/`, modified files in worktree               | review notes appended to `state.md`                     |
| `/forge resume`       | `.forge-loop.lock`, `progress/`, `worktrees/`      | `state.md`, `resume.md`, cleans orphaned worktrees      |
| `/forge status`       | `state.md`, `task-status.json`, `progress/`        | (read-only)                                             |
| `/forge backprop`     | `specs/`, runtime bug reports                      | `specs/` (updates), regression test files               |
| Headless mode         | All                                                | `runs/{timestamp}/log.txt`                              |
| Token monitor hook    | (tool calls)                                       | `token-ledger.json`                                     |

## Invariants

1. **`progress/` and `worktrees/` mirror each other.** A task with a checkpoint should usually have a worktree, and vice versa. `/forge resume` reconciles drift.
2. **Checkpoint deletion is the last step.** A `progress/{task-id}.json` file existing after a process exit always means the task did not finish cleanly.
3. **Worktree removal is also the last step.** An orphaned worktree always means crash, abort, or external interruption.
4. **Lock file PID must match a live process.** `/forge resume` verifies this before honoring an existing lock.
5. **Atomic writes.** All JSON state files are written via temp-file-and-rename to survive partial-write crashes.
6. **No cross-task writes.** An executor for T003 must never write to `progress/T004.json` or `worktrees/T004/`.
