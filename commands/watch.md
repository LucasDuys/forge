---
description: "Run the autonomous implementation loop with a live TUI dashboard"
argument-hint: "[--autonomy full|gated|supervised] [--max-iterations N] [--token-budget N] [--depth quick|standard|thorough] [--filter NAME] [--max-restarts N] [--base-delay N] [--transcript-lines N] [--no-fallback]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tui.cjs:*)", "Bash(FORGE_TUI=1 bash ${CLAUDE_PLUGIN_ROOT}/scripts/forge-runner.sh:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Bash(*)", "Agent(*)"]
---

# Forge Watch

Launch the autonomous implementation loop with an interactive TUI dashboard. Identical to `/forge execute` except that it spawns `claude` with `--output-format stream-json --verbose` and renders a live dashboard showing the current phase, active agent + tool, frontier progress bar, token counters, restart meter, and a scrolling transcript pane.

Use this when you want eyes-on visibility into what Forge is doing in real time. Use `/forge execute` when you want plain stdout (better for CI logs, redirected output, or small terminals).

## Pre-flight Check

Identical to `/forge execute`:

1. Verify `.forge/` exists. If it does not, stop and tell the user:
   > `.forge/` not found. Run `/forge brainstorm` first to generate specifications, then `/forge plan` to create task frontiers.

2. Verify `.forge/specs/` contains at least one spec file. If not, stop and tell the user:
   > No specs found. Run `/forge brainstorm` first.

3. Verify `.forge/plans/` contains at least one `*-frontier.md` file. If not, stop and tell the user:
   > No task frontiers found. Run `/forge plan` first to decompose specs into tasks.

4. Check for Ralph Loop conflict: if `.claude/ralph-loop.local.md` exists, stop and tell the user:
   > Ralph Loop is active. Run `/cancel-ralph` first — only one loop plugin should be active at a time.

5. Verify Node 18+ is on PATH (`node --version`). If not, stop and tell the user:
   > `/forge watch` needs Node.js 18+ for the TUI dashboard. Install Node or use `/forge execute` for the plain runner.

## Parse Arguments

Accepts all `/forge execute` flags plus TUI-specific flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--autonomy full\|gated\|supervised` | from config | Inherited from `/forge execute` |
| `--max-iterations N` | from config | Inherited from `/forge execute` |
| `--token-budget N` | from config | Inherited from `/forge execute` |
| `--depth quick\|standard\|thorough` | from config | Inherited from `/forge execute` |
| `--filter NAME` | *(all specs)* | Inherited from `/forge execute` |
| `--max-restarts N` | 10 | Max Claude restart attempts (TUI runner) |
| `--base-delay N` | 3 | Base backoff delay in seconds |
| `--transcript-lines N` | 50 | Transcript ring buffer size |
| `--no-fallback` | off | Do not fall back to plain runner on TUI self-abort |

Execute-flow flags are interpreted by the executing skill; TUI flags are passed through to `forge-tui.cjs` via the runner bridge.

## Read Configuration and Capabilities

Run the same configuration read as `/forge execute`:

1. Read `.forge/config.json`.
2. Read `.forge/capabilities.json` if present.
3. Read all frontier files from `.forge/plans/`.
4. Identify the first spec to execute (filter or first alphabetical).

## Initialize Loop State

Run the same `setup-state` call as `/forge execute`:

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

## Launch the Runner with the TUI Bridge

Instead of invoking the forge-runner.sh loop in plain mode or dispatching the stop-hook state machine inside this session, `/forge watch` delegates to the bash runner with `FORGE_TUI=1` so the bridge installed in `scripts/forge-runner.sh` hands execution to `scripts/forge-tui.cjs`:

```bash
FORGE_TUI=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/forge-runner.sh" \
  --max-restarts "{resolved-max-restarts}" \
  --base-delay "{resolved-base-delay}" \
  --transcript-lines "{resolved-transcript-lines}" \
  {--no-fallback if requested}
```

The TUI reads `.forge/.forge-resume.md` (populated by the executing skill's first response) and drives the loop from there. On TUI self-abort (exit code 87) or if Node is unavailable (exit code 127), the runner falls back to the plain-text loop automatically — unless `--no-fallback` was passed.

## Completion

When the TUI dashboard shows "Forge complete!" and exits, present:

```
Forge Watch — Complete
---
Spec: {domain}
Tasks: {N} complete
Restarts: {R}
Tokens used: {N}k in / {N}k out / {N}k cached
```

Then output the completion promise exactly as shown:

```
<promise>FORGE_COMPLETE</promise>
```

Only emit the promise once all tasks across all specs are verified complete, matching the same completion rules as `/forge execute`.

## Fallback Behavior

If the TUI self-aborts (three consecutive stream-json parse errors, unrecoverable render error, or `claude` missing from PATH), the runner bridge automatically falls through to the plain-text loop. The user sees a one-line "falling back to plain runner" message on stderr followed by the normal `/forge execute` output. Pass `--no-fallback` to disable this and propagate the TUI exit code instead.

## Output Expectations

- Fullscreen dashboard rendered via ANSI escape sequences at 10Hz
- Minimum terminal size: 80 columns x 24 rows
- On SIGINT (Ctrl+C), cursor visibility and terminal colors are restored before exit
- All parsed stream-json events are mirrored to `.forge/.tui-log.jsonl` for post-mortem inspection
