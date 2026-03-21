---
name: executing
description: Autonomous task implementation workflow — implement, test, review, commit for each task in the frontier
---

# Executing Skill

This skill guides the per-task implementation cycle during `/forge execute`. For each task in the frontier, you follow a structured workflow: read the spec, implement, test, review, commit, and update state. The Stop hook drives task-to-task progression; this skill handles the work within a single task.

## Inputs

You will receive:
- **Task ID and name**: From the frontier (e.g., `T003: Registration endpoint + tests`)
- **Spec file path**: Location of the spec with acceptance criteria (e.g., `.forge/specs/spec-auth.md`)
- **Depth**: `quick`, `standard`, or `thorough`
- **Capabilities**: From `.forge/capabilities.json` (optional, informs tool choices)
- **Repo config**: From `.forge/config.json` (which repo to work in, conventions to follow)

## Procedure

### Step 1: Read Context

1. **Read current state** from `.forge/state.md` — check what task you are on, what is already done, any in-flight work or key decisions from prior tasks.
2. **Read the frontier** from `.forge/plans/{spec}-frontier.md` — find your current task, understand its dependencies, and what comes after.
3. **Read the spec** from `.forge/specs/spec-{domain}.md` — find the R-numbered requirements and acceptance criteria that this task must satisfy. Identify the exact checkboxes you need to check off.
4. **Read capabilities** from `.forge/capabilities.json` if it exists — check for available MCP servers (Context7 for docs, Playwright for E2E, MongoDB for data inspection) and skills (TDD, systematic debugging, code review).

### Step 2: Prepare the Workspace

1. **Multi-repo**: If the task has a `repo:` tag, `cd` into the correct repo directory (from `.forge/config.json` repos). Read that repo's CLAUDE.md or coding conventions file first.
2. **Single-repo**: Stay in the current directory. Read CLAUDE.md if it exists.
3. **Conventions**: Note the project's coding style, naming conventions, import patterns, test framework, and commit message format. Follow them exactly.

### Step 3: Implement the Task

The implementation approach depends on the depth level and available capabilities:

#### Depth: Thorough (or TDD skill available)
1. **Write failing tests first.** Based on the acceptance criteria, write test cases that define the expected behavior. Run them to confirm they fail.
2. **Implement the feature** to make the tests pass. Write the minimum code needed.
3. **Run all tests** (not just the new ones) to ensure nothing is broken.
4. **Refactor** if needed — clean up while tests are green.

#### Depth: Standard
1. **Implement the feature** based on the acceptance criteria.
2. **Write tests** after implementation — cover happy paths and key error cases from the acceptance criteria.
3. **Run all tests** to confirm everything passes.

#### Depth: Quick
1. **Implement the feature** based on the acceptance criteria.
2. **Run existing tests** if there is an existing test suite. Do not write new tests unless the project requires it.
3. If no test suite exists, manually verify the implementation satisfies the acceptance criteria.

#### Implementation Guidelines

- **Read before writing.** Before creating new files, search for existing patterns in the codebase. Follow established conventions (file structure, naming, imports, error handling).
- **One concern per file.** Do not stuff unrelated logic into existing files.
- **Error handling.** Implement error cases from the acceptance criteria, not just the happy path.
- **No stubs.** Every function must have a real implementation. Do not leave `// TODO` or `throw new Error('not implemented')`.
- **No over-engineering.** Implement exactly what the spec requires. If the acceptance criteria do not ask for it, do not build it.

### Step 4: Run Tests and Fix Failures (Inner Loop)

After implementation, run the test suite:

1. Run the relevant test command for the project (detected from package.json scripts, Makefile, or conventions).
2. If tests pass: proceed to Step 5.
3. If tests fail:
   - Read the failure output carefully.
   - Fix the failing code (not the tests, unless the test itself is wrong).
   - Re-run tests.
   - Repeat up to 3 times (the circuit breaker threshold from config).
   - If still failing after 3 attempts, update `.forge/state.md` with `task_status: debugging` and describe the failure. The stop hook will switch to systematic DEBUG mode.

### Step 5: Update State to Testing

After tests pass, update `.forge/state.md`:

1. Set `task_status: testing` in the frontmatter.
2. Under "In-Flight Work", describe what you implemented and that tests are passing.
3. Note any key decisions you made (library choices, design patterns, deviations from conventions).

The stop hook reads this state and decides the next action:
- If depth is `quick`: skip review, proceed to commit.
- If depth is `standard` or `thorough`: the stop hook will feed a review prompt.

### Step 6: Review (Standard and Thorough Only)

When the stop hook feeds a review prompt, review the implementation:

1. **Re-read the spec** acceptance criteria for this task.
2. **Check each criterion** — is it fully implemented? Partially? Missing?
3. **Check code quality** — follows repo conventions? Error handling? No stubs?
4. **Check edge cases** — are error cases from the spec handled?
5. **Report**: If all criteria are met, report PASS. If issues exist, report ISSUES with specific file:line references.

If issues are found:
- Fix them immediately.
- Re-run tests to confirm fixes do not break anything.
- Update the review status.
- The stop hook handles the review iteration loop (max 3 iterations per the circuit breaker).

### Step 7: Commit Atomically

Once the task passes tests and review (or review is skipped for quick depth):

1. **Stage only the files for this task.** Do not stage unrelated changes.
2. **Write a descriptive commit message** following the repo's commit conventions. Include:
   - What was implemented (the task name)
   - Which spec requirement(s) it satisfies (R-numbers)
   - The task ID for traceability
   Example: `feat: add user registration endpoint (T003, R001)`
3. **Commit** in the correct repo (if multi-repo, commit in the repo the task targets).

### Step 8: Update State and Task Registry

After committing:

1. **Update the task registry** (`.forge/task-status.json`) — this is the authoritative source for task completion. Either:
   - Run: `node <plugin-root>/scripts/forge-tools.cjs mark-complete --forge-dir .forge --task T003 --commit abc1234`
   - Or directly edit `.forge/task-status.json` to set the task's status to `"complete"` with the commit hash.

2. Set `task_status: complete` in `.forge/state.md` frontmatter.
3. Move the task from "In-Flight Work" to "What's Done" with the commit hash:
   ```
   ## What's Done
   - T003: Registration endpoint + tests (complete, committed abc1234)
   ```
4. Clear the "In-Flight Work" section.
5. Update "What's Next" to reflect remaining tasks.
6. Increment `iteration` in the frontmatter.

The stop hook will then pick up the updated state and either:
- Feed the next task prompt (full/gated autonomy within a spec)
- Dispatch multiple same-tier tasks in parallel (if available)
- Allow exit for human review (supervised autonomy, or gated between specs)
- Trigger phase verification (if all tasks for the current spec are done)

## Task Status Progression

Each task moves through these states, tracked in `.forge/state.md` frontmatter as `task_status`:

```
pending → implementing → testing → reviewing → complete
                ↑            ↓
                └── fixing ──┘
                     ↓
                debugging (circuit breaker)
                     ↓
                blocked (needs human)
```

- **pending**: Task not started. Stop hook feeds implementation prompt.
- **implementing**: Actively writing code. Self-managed within this skill.
- **testing**: Tests running/passing. Stop hook decides whether to review.
- **reviewing**: Code review in progress (standard/thorough only).
- **fixing**: Fixing review issues, will re-test.
- **debugging**: Systematic debug mode after 3 test failures. Stop hook manages.
- **complete**: Committed and done. Stop hook advances to next task.
- **blocked**: Cannot proceed. Stop hook pauses for human intervention.

## Multi-Repo Execution

When `.forge/config.json` defines multiple repos:

1. **Check the task's `repo:` tag** in the frontier.
2. **Navigate to the correct directory**: Use the `path` from the repo config (relative to the `.forge/` location).
3. **Read conventions**: Each repo may have its own CLAUDE.md, coding standards, test framework, and commit message format.
4. **Commit in the source repo**: Always commit in the repo where the files were changed.
5. **API-first ordering**: If `cross_repo_rules.api_first` is true, backend tasks are completed before frontend tasks that depend on them. The frontier already enforces this ordering.

## Capability-Enhanced Execution

If `.forge/capabilities.json` lists available tools, use them when relevant:

| Capability | When to Use |
|------------|-------------|
| **Context7 MCP** | Look up library/framework documentation when implementing unfamiliar APIs |
| **Playwright MCP** | Run E2E tests for frontend tasks, verify UI behavior |
| **MongoDB MCP** | Inspect database state during debugging, verify data operations |
| **TDD skill** | Enforce test-first workflow (activated automatically for thorough depth) |
| **Systematic debugging** | Use the 4-phase debugging protocol when in DEBUG mode |
| **Code review plugin** | Enhance the review step with structured review output |

Do not fail if a capability is listed but unavailable at runtime — fall back to manual approaches.

## Parallel Task Execution

When the stop hook detects multiple unblocked tasks in the same tier, it will instruct you to dispatch them in parallel:

1. **You implement the first task** yourself (following the normal procedure above).
2. **Dispatch remaining same-tier tasks** as independent subagents using the `Agent` tool with `isolation: "worktree"`.
3. Each agent receives the spec path, task ID, and depth level.
4. After all agents complete, **update both** `.forge/state.md` and `.forge/task-status.json` with the results from each agent.
5. Merge worktree changes if agents made commits in isolated worktrees.

This only applies when the stop hook explicitly instructs parallel execution. Do not attempt parallel dispatch on your own — let the hook decide based on the frontier tier structure.

## Key Principles

- **Atomic commits**: One commit per task. Never combine multiple tasks in a single commit.
- **Spec compliance**: Every acceptance criterion must be satisfied. Do not skip criteria.
- **No stubs**: Every function must be fully implemented. Stubs trigger verification failures.
- **Registry is truth**: Always update `.forge/task-status.json` after completing a task. This is the programmatic source of truth for task completion — more reliable than markdown parsing.
- **State for context**: Update `.forge/state.md` for human-readable progress and context preservation across session resets.
- **Let the hook drive**: Do not try to manage task-to-task progression yourself. Complete your current task, update state and registry, and let the stop hook decide what comes next.
