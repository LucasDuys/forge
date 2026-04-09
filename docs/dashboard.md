# Live Dashboard (`/forge watch`)

For eyes-on visibility into a running Forge session, use `/forge watch` instead of `/forge execute`. It launches the same autonomous loop but spawns Claude with `--output-format stream-json --verbose`, parses the line-delimited JSON event stream in real time, and renders an interactive dashboard:

```
Forge — interactive runner                                       phase: executing
  Task:   T010  [in_progress]
  Agent:  forge-executor   Tool: Edit
  Tasks:  [████████████████████████░░░░░░░░░░░░░░░░] 9/15 (60%)
  Tokens: 142k in / 38k out / 89k cached
  Meters: Restarts 2/10   Context 71%   Tools used 17
────────────────────────────────────────────────────────────────────────────────
── Transcript ──────────────────────────────────────────────────────────────────
  > [forge-executor] Reading src/auth/middleware.ts
  ~ Edit /repo/src/auth/middleware.ts
  = File edited successfully.
  > [forge-executor] Running tests...
  = tests passed (1 more lines)
```

## What it shows

| Region | Source | Updates |
|---|---|---|
| Header | `.forge/state.md` frontmatter (`phase`) | 500ms poll |
| Task line | `.forge/state.md` (`current_task`, `task_status`) + per-task checkpoint (`current_step`, `next_step`, `token_usage`) | 500ms poll |
| Agent + Tool line | `assistant` events from stream-json (Task `subagent_type` + most recent `tool_use.name`) | live |
| Progress bar | Newest `.forge/plans/*-frontier.md` (`total_tasks`) + completed task IDs cached in `.forge/.tui-state.json` | 500ms poll |
| **Parallel panel (R013)** | `.forge/task-status.json` `running` tasks + each task's `.forge/progress/{id}.json` checkpoint | 500ms poll |
| Token meters | `result` events `usage.input_tokens` / `output_tokens` / `cache_read_input_tokens` (high-water mark), session budget from headless query, total task tokens summed across all checkpoints | live + 500ms |
| Restart + Context meters | Internal counter + cumulative `input_tokens` divided by session budget total (or 200k fallback) | live |
| Lock indicator | `.forge/.forge-loop.lock` (PID + heartbeat age, 5-min stale threshold) | 500ms poll |
| Transcript | Ring buffer of last 50 events (configurable via `--transcript-lines`) | live |

Multiline `tool_result` bodies are collapsed on screen to the first line plus `(N more lines)`. The full event log is mirrored to `.forge/.tui-log.jsonl` for post-mortem inspection.

## Parallel panel (R013)

When more than one task is running in parallel (v2.1 streaming-DAG dispatch with worktree isolation), the dashboard renders a `── Parallel ──` separator followed by one row per task:

```
── Parallel ──────────────────────────────────────────────────────────────
  T002  forge-executor   @ tests_written → tests_passing   8.4k/15k tok (56%)
  T003  forge-reviewer   @ review_pending                  12.1k/15k tok (80%)
  T004  forge-executor   @ implementation_started           2.3k/15k tok (15%)
```

Each row shows:

- **Task ID** — clickable in modern terminals if the executor logs file links
- **Agent** — `forge-executor`, `forge-reviewer`, etc., from the checkpoint's `agent` field
- **Step** — current_step → next_step from `.forge/progress/{id}.json`
- **Token cost** — `tokens_used / per_task_budget (percentage)` with green/yellow/red color thresholds at 70/90

The panel is **capped at 4 visible rows** plus a `(...N more)` overflow indicator so 8 parallel tasks don't crush the transcript pane. When the terminal is too small to fit both the panel and a 5-row transcript minimum, the panel collapses to the v1 single-line summary (`Running: T002, T003, T004 (3 parallel)`) automatically.

The panel only renders when **more than one** task is running. With one task, the status line already covers it.

## Per-task token cost (R014)

Single-task mode adds a token suffix to the status line:

```
  Task:   T010  [in_progress]  @ tests_written → tests_passing   12.4k/15k tok (83%)
```

The token line gains a `task-tot` subfield showing total tokens summed across **every** `.forge/progress/{id}.json` checkpoint (not just running tasks):

```
  Tokens: 142k in / 38k out / 89k cached   budget 47k/500k (9%)   task-tot 47k
```

Per-task budgets come from `.forge/config.json`:

```json
{
  "per_task_budget": {
    "quick": 5000,
    "standard": 15000,
    "thorough": 40000
  }
}
```

The depth used for the current task is read from the task's checkpoint (`depth` field), falling back to the project's `depth` config field. Color thresholds intentionally diverge from the context-meter (70/90 for budget, 60/80 for context) because they measure different things — budget is "how much of this task's allowance have we spent" while context is "how close are we to a context reset."

When a checkpoint has no `token_usage` field (older checkpoint format), the display falls back to `— tok` instead of crashing.

## Requirements

- Node 18+ on `PATH`
- Interactive terminal of at least 80×24 columns/rows
- `claude` CLI on `PATH`
- 256-color terminal recommended (16-color and ASCII fallbacks supported)

Zero npm install — `scripts/forge-tui.cjs` uses only Node built-ins (`fs`, `path`, `os`, `child_process`).

## Invocations

```bash
# Slash command (recommended)
/forge watch --autonomy full

# Direct env var (when running the bash runner outside Claude Code)
FORGE_TUI=1 bash scripts/forge-runner.sh

# Direct script invocation with custom flags
node scripts/forge-tui.cjs --max-restarts 20 --transcript-lines 100
```

## Flags

| Flag | Default | Description |
|---|---|---|
| `--max-restarts N` | 10 | Max Claude restart attempts before giving up |
| `--base-delay N` | 3 | Base backoff delay in seconds (matches `forge-runner.sh`) |
| `--transcript-lines N` | 50 | Transcript ring buffer size |
| `--no-fallback` | off | Disable the exit-code-87 fallback contract |
| `--forge-dir PATH` | `./.forge` | Path to the `.forge/` directory |

Equivalent environment variables: `FORGE_MAX_RESTARTS`, `FORGE_BASE_DELAY`, `FORGE_TUI_NO_FALLBACK`.

## Fallback contract

If the TUI hits an unrecoverable error it self-aborts with exit code 87 and `forge-runner.sh` automatically falls back to the plain-text loop. Triggers:

- Three consecutive stream-json parse errors
- `ENOENT` when spawning `claude` (binary not on `PATH`)
- Unrecoverable render error
- Non-TTY stdout (for piped or redirected invocations — these still drive the runner loop, just in headless mode)

`forge-runner.sh` also detects exit code 127 (command not found) for cases where Node or `forge-tui.cjs` itself is missing. Pass `--no-fallback` (or set `FORGE_TUI_NO_FALLBACK=1`) to disable fallthrough and propagate the sentinel exit code instead.

| Exit code | Meaning |
|---|---|
| 0 | Forge run completed cleanly, or task became blocked |
| 1 | Real error (max restarts reached, missing resume prompt) |
| 87 | TUI self-abort sentinel — runner falls back to plain mode |
| 127 | Node or `forge-tui.cjs` not found — runner falls back to plain mode |

## What's not in this version

The dashboard is read-only in v1. Future enhancements (no ETAs):

- Interactive controls (pause, resume, skip task, re-plan from dashboard)
- Multi-session multiplexing for parallel forge runs across repos
- TUI for `/forge brainstorm` and `/forge plan` conversational flows
- Per-task checkpoint progress (would integrate with `.forge/progress/{task-id}.json`)
- Real context-window query if Claude exposes one (current estimate over-counts for cache-heavy sessions)
- Mouse support for scrolling the transcript pane

## Tests

The TUI ships with 27 tests in `tests/forge-tui/`:

- `parser-test.cjs` — chunk-boundary safety, agent attribution, malformed JSON handling, fallback trigger
- `reconciler-test.cjs` — frontmatter parsing, restart hydration, atomic state save
- `backoff-test.cjs` — exponential backoff math identical to `forge-runner.sh`
- `fallback-test.cjs` — exit code constants, CLI arg parsing
- `render-test.cjs` — snapshot test against `tests/forge-tui/snapshot-render.txt`

Run them via the standalone runner:

```bash
node tests/forge-tui/run.cjs
```

Or as part of the full Forge suite via `node scripts/run-tests.cjs` (the suite picks up tests in `tests/` recursively).

## Design rationale

See [`docs/superpowers/specs/2026-04-09-tui-dashboard.md`](superpowers/specs/2026-04-09-tui-dashboard.md) for the full design doc, including the "why zero-dep ANSI over `ink`" rationale and the data flow diagram.
