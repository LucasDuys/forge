---
description: "Run the autonomous implementation loop"
argument-hint: "[--autonomy full|gated|supervised] [--max-iterations N] [--token-budget N] [--depth quick|standard|thorough] [--filter NAME]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Bash(*)", "Agent(*)"]
---

# Forge Execute

Launch the autonomous implementation loop. Reads the frontier, implements tasks one by one, and relies on the Stop hook state machine to drive iteration until all tasks are complete.

## Pre-flight Check

1. Verify `.forge/` exists. If it does not, stop and tell the user:
   > `.forge/` not found. Run `/forge brainstorm` first to generate specifications, then `/forge plan` to create task frontiers.

2. Verify `.forge/specs/` contains at least one spec file. If not, stop and tell the user:
   > No specs found. Run `/forge brainstorm` first.

3. Verify `.forge/plans/` contains at least one `*-frontier.md` file. If not, stop and tell the user:
   > No task frontiers found. Run `/forge plan` first to decompose specs into tasks.

4. Check for Ralph Loop conflict: if `.claude/ralph-loop.local.md` exists, stop and tell the user:
   > Ralph Loop is active. Run `/cancel-ralph` first — only one loop plugin should be active at a time.

## Parse Arguments

Parse flags from `$ARGUMENTS`:

| Flag | Default | Description |
|------|---------|-------------|
| `--autonomy full\|gated\|supervised` | Value from `.forge/config.json` (default: `gated`) | When to pause for human review |
| `--max-iterations N` | Value from config (default: `100`) | Maximum stop-hook iterations before forced exit |
| `--token-budget N` | Value from config (default: `500000`) | Total token budget for execution |
| `--depth quick\|standard\|thorough` | Value from config (default: `standard`) | Quality/ceremony level |
| `--filter NAME` | *(all specs)* | Only execute tasks for specs whose domain matches NAME |

If a flag is not provided, fall back to `.forge/config.json`, then to the built-in default.

## Read Configuration and Capabilities

1. Read `.forge/config.json` for project settings (repos, loop circuit breakers, review settings, etc.).
2. Read `.forge/capabilities.json` if it exists, to know which MCP servers and skills are available for execution.
3. Read all frontier files from `.forge/plans/` (filtered by `--filter` if provided).
4. Identify the first spec to execute: use `--filter` domain if given, otherwise the first frontier file alphabetically.

## Initialize Loop State

Run `setup-state` to create `.forge/.forge-loop.json` and prepare `.forge/state.md` for execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" setup-state \
  --forge-dir .forge \
  --spec "{first-spec-domain}" \
  --autonomy "{resolved-autonomy}" \
  --depth "{resolved-depth}" \
  --max-iterations "{resolved-max-iterations}" \
  --token-budget "{resolved-token-budget}" \
  --completion-promise "FORGE_COMPLETE"
```

This sets `phase: executing` in state.md and creates the loop file that activates the Stop hook.

## Identify First Task

1. Read the frontier file for the first spec: `.forge/plans/{spec-domain}-frontier.md`
2. Parse the frontier to find the first unblocked task (Tier 1, first entry).
3. Update `.forge/state.md` with `current_task: {task-id}` and `task_status: pending`.
4. Update the "What's Next" section in state.md with all remaining tasks.

## Begin Execution

Now invoke the **forge:executing** skill to begin working on the first task.

Pass to the skill:
- The current task ID and name from the frontier
- The spec file path for acceptance criteria
- The resolved depth level
- The capabilities map
- The repo configuration (if multi-repo)

The skill handles the per-task implementation cycle: read spec, implement, test, review, commit, update state.

**From this point forward, the Stop hook takes over.** After each Claude response, the Stop hook in `hooks/stop-hook.sh`:
1. Reads `.forge/.forge-loop.json` and `.forge/state.md`
2. Calls `forge-tools.cjs route` to determine the next action
3. Either blocks exit with a new prompt (driving the next iteration) or allows exit (done, paused, or budget exhausted)

The state machine handles all transitions: implementing, testing, reviewing, fixing, debugging, advancing to the next task, verifying specs, and completing the loop. See Section 5.3 and 6.2 in the design spec for the full state machine table.

## Autonomy Modes

| Mode | Behavior |
|------|----------|
| `full` | Runs unattended until all tasks are complete, blocked, or budget exhausted. Never pauses between tasks or specs. |
| `gated` | Pauses between specs/phases for human review. Runs autonomously within a single spec. |
| `supervised` | Pauses after every task. Human must `/forge resume` to continue. Good for critical code or first runs. |

## Completion

When ALL tasks across ALL specs (or the filtered subset) are genuinely complete and verified:

Output the completion promise exactly as shown:

```
<promise>FORGE_COMPLETE</promise>
```

**CRITICAL:** Only output the completion promise when:
- Every task in every frontier has status `complete` in state.md
- Phase verification has passed (for standard and thorough depth)
- All acceptance criteria from the spec are satisfied
- Code is committed

Do NOT output the promise prematurely. If tasks remain, the stop hook will continue driving execution. If you are blocked or uncertain, update state.md with the blocker and let the stop hook handle it.

## Output

After starting execution, present a brief launch summary:

```
Forge Execute — Starting
---
Spec: {domain}
Tasks: {N} total ({M} in first tier)
Depth: {quick|standard|thorough}
Autonomy: {full|gated|supervised}
Token budget: {N}
Max iterations: {N}

Starting task {T001}: {task name}...
```

Then immediately begin working on the first task. The stop hook handles everything after that.
