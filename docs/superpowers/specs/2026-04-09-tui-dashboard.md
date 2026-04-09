---
title: TUI Dashboard for Forge Runner
date: 2026-04-09
status: shipped
related_spec: .forge/specs/spec-tui-dashboard.md
related_frontier: .forge/plans/spec-tui-dashboard-frontier.md
---

# TUI Dashboard for Forge Runner

## Overview

Forge today runs via `scripts/forge-runner.sh`, which loops `claude --print -p "$(cat .forge/.forge-resume.md)"` and dumps raw text to the terminal. Users have no live visibility into which agent is active, which tool is running, token usage, or progress across the frontier. This design adds an opt-in interactive TUI dashboard — `scripts/forge-tui.cjs` — that wraps the same runner loop, parses Claude's `stream-json` output in real time, reconciles live data with `.forge/` state files, and renders a dashboard using zero-dependency ANSI escape sequences. A new `/forge watch` command and a `FORGE_TUI=1` env var are the two entry points. The existing `forge-runner.sh` remains the default and is the fallback path when Node or stream parsing fails.

**Chosen approach:** zero-dependency ANSI renderer in CommonJS Node.js. Parses `claude -p --output-format stream-json --verbose` line-by-line, polls `.forge/` state files on a 500ms interval, and preserves all existing runner semantics (restart limit, exponential backoff, blocked detection, completion detection).

**Explicitly out of scope for v1:**
- Multi-session multiplexing (no cmux-style tabs for concurrent forge runs)
- Interactive controls (no pause/resume/skip-task keybinds — read-only dashboard)
- Persistence of dashboard layout preferences
- TUI for `/forge brainstorm` or `/forge plan` (execute-only)
- Exact context-window accounting (best-effort estimate only)

## Why zero-dep ANSI over `ink`

The implementation deliberately avoids `ink` (React-for-CLIs) in favor of hand-rolled ANSI escape sequences. Three reasons:

1. **The "zero npm install for users" rule in `CLAUDE.md` is load-bearing.** Forge ships as a Claude Code plugin that users install with one command and zero post-install steps. Adding a 200KB+ React-style dependency tree (or vendoring it inline) introduces audit surface, version-skew risk, and a build step we don't otherwise need. Every alternative we considered for satisfying R001 AC3 (`grep` for non-builtin requires returns zero matches) either had to vendor ink or branch on whether ink is installed — both worse than simply not depending on it.

2. **The layout is static enough that React-style diffing is overkill.** The dashboard has 5 fixed regions (header, status, progress, tokens/meters, transcript) plus optional alert/countdown overlays. A 10Hz double-buffered full-frame redraw with frame-equality dedup is ~30 lines of code and produces visually identical output to a React reconciler for this kind of always-on data display. We're not rendering a complex form or a data grid that benefits from minimal-diff updates.

3. **Debugging stays inside one process and one language.** Stream-json parsing, state polling, terminal handling, and rendering all live in one ~700-line CommonJS file. There's no virtual DOM to step through, no React lifecycle to learn, no JSX to bundle. A maintainer who knows Node and bash can read the whole TUI in one sitting.

The trade-off we accept: terminal handling is manual. Cursor save/restore, color-mode detection, UTF-8 fallback, and SIGINT cleanup are all implemented by hand in `scripts/forge-tui.cjs` Section 3 (`detectCaps`, `ANSI`, `enableRawTerminal`, `restoreTerminal`). Test coverage in `tests/forge-tui/render-test.cjs` snapshots the rendered frame so accidental regressions in this hand-rolled code path get caught.

## Architecture

```
                        ┌──────────────────────┐
                        │  /forge watch        │
                        │  (commands/watch.md) │
                        └──────────┬───────────┘
                                   │ FORGE_TUI=1
                                   v
                  ┌──────────────────────────────────┐
                  │  scripts/forge-runner.sh         │
                  │  (TUI bridge at top of main)     │
                  └──────────┬───────────────────────┘
                             │ node forge-tui.cjs
                             v
        ┌───────────────────────────────────────────────┐
        │  scripts/forge-tui.cjs                        │
        │  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
        │  │ Runner   │->│ Stream   │->│ StreamParser │ │
        │  │ (spawn   │  │ stdout   │  │ + attribution│ │
        │  │  claude) │  │ (chunks) │  │ stack        │ │
        │  └──────────┘  └──────────┘  └──────┬───────┘ │
        │       │                              │         │
        │       v                              v         │
        │  ┌──────────────┐            ┌──────────────┐ │
        │  │ StatePoller  │  reconcile │  Renderer    │ │
        │  │ (500ms tick) │<-----------│  (10Hz tick) │ │
        │  └──────┬───────┘            └──────┬───────┘ │
        └─────────┼──────────────────────────┼───────────┘
                  │                          │
                  v                          v
            .forge/state.md           process.stdout
            .forge/token-ledger.json  (ANSI frames)
            .forge/.tool-count
            .forge/.forge-loop.json
            .forge/plans/*-frontier.md
            .forge/.tui-state.json    (restart hydration cache)
            .forge/.tui-log.jsonl     (post-mortem event log)
```

The data flow is one-way: `Runner` spawns Claude → stdout chunks fed to `StreamParser` → `StreamParser` updates its internal `latest` snapshot → `Renderer` reads the snapshot on every tick. `StatePoller` runs independently on its own 500ms timer and reads disk state, exposing a parallel snapshot that the renderer also consumes. The two snapshots are reconciled by `StatePoller.reconcile()` which keeps a high-water mark for token counters so the dashboard never visibly resets to zero when the Claude child restarts.

## Fallback contract

R007 specifies a sentinel exit code of 87 for TUI self-abort. The contract has two sides that must land atomically (and did, in commit `d1e6d48`):

- **TUI side (`forge-tui.cjs`):** exits with code 87 on three consecutive parse errors (parser `onFatal`), `ENOENT` from `child_process.spawn('claude', ...)` (Runner `_spawnOnce` error handler), or any uncaught render error (main `try/catch`). Exits with 0 on completion, 1 on real errors (max restarts reached, missing resume prompt), 87 on self-abort.
- **Bash side (`forge-runner.sh`):** when `FORGE_TUI=1` is set, runs `node "$TUI_SCRIPT" "$@"` first. On exit 0 or 1, propagates immediately. On exit 87 or 127 (command not found), prints a one-line warning and falls through to the original plain-text loop. `FORGE_TUI_NO_FALLBACK=1` disables fallthrough.

This means a user who runs `/forge watch` on a machine without Node, or in a terminal that doesn't support ANSI, gets the plain runner experience automatically — no error, no broken plugin.

## Test strategy

`tests/forge-tui/run.cjs` is a zero-dep test runner that discovers `*-test.cjs` files and runs each exported function. 27 tests total across 5 files, all pass on first run:

| File | Coverage |
|---|---|
| `parser-test.cjs` | Chunk-boundary parsing (1-byte, 7-byte, character-by-character, pseudo-random sizes); attribution stack push/pop on Task tool_use/tool_result; token extraction from result event; malformed JSON handling; 3-consecutive-error fallback trigger; counter reset on valid line |
| `reconciler-test.cjs` | YAML frontmatter parsing; frontier total parsing; loop active detection; restart hydration via fresh `StatePoller` instance; `TuiState.load` defaults; atomic tmp+rename on save |
| `backoff-test.cjs` | Baseline math for base=3 (3,6,12,24,48); 60s cap; non-zero exit doubling (6,12,24,48,96); 120s cap; custom base scaling |
| `fallback-test.cjs` | Stable exit code constants; `parseArgs` for `--no-fallback`, `--max-restarts`, `--base-delay`, `--transcript-lines`, `--help` |
| `render-test.cjs` | Snapshot test against `snapshot-render.txt` (ANSI stripped for human readability); locks the layout against accidental drift |

The seed fixture at `tests/forge-tui/fixture-stream.jsonl` is currently a hand-crafted synthetic recording of a forge-executor session: system init → assistant text → Task tool_use → nested Read/Edit → tool_results → result event with usage. It exists because the implementation environment did not have the `claude` CLI on PATH and could not produce a real recording at execution time. The synthetic fixture should be replaced with a real recording the first time `/forge watch` runs end-to-end against a live forge session — the snapshot test will catch any structural drift.

## v2 amendments (R013/R014, shipped post-merge)

After the initial v1 ship, two requirements were appended to the spec to fully integrate with v2.1's streaming-DAG dispatch:

- **R013 — Multi-task parallel panel.** When more than one task is running, the renderer emits a `── Parallel ──` section with one row per task showing id/agent/step/tokens. Capped at 4 visible rows plus an overflow indicator. Falls back to the v1 single-line summary when the terminal is too small to fit both the panel and a 5-row transcript minimum. Implemented in `Renderer._parallelPanelLines()` and `Renderer._parallelRow()`.
- **R014 — Per-task token cost.** Status line and parallel-panel rows show `tokens_used / per_task_budget (percentage)` with 70/90 color thresholds. Token line gains a `task-tot` subfield summing token_usage across all `.forge/progress/*.json` checkpoints. `StatePoller._readAll()` reads `per_task_budget` from `.forge/config.json` and resolves the current task's depth from its checkpoint.

These amendments preserve backwards compatibility — the existing single-task render path is unchanged, and all v1 snapshot tests still pass. The fallback to the v1 single-line summary ensures small-terminal users keep their transcript visible.

## Future considerations

- Interactive controls (pause, resume, skip task, re-plan from dashboard) — explicitly deferred
- Multi-session multiplexing for parallel forge runs across repos — separate spec
- TUI for `/forge brainstorm` and `/forge plan` conversational flows — separate spec
- Persistent dashboard layout preferences in `.forge/config.json`
- Real context-window query if Claude exposes one (current estimate divides cumulative `input_tokens` by a fixed 200k, which over-counts for cache-heavy sessions)
- Mouse support for scrolling the transcript pane
