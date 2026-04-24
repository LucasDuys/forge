# Commands Reference Index

Forge ships as a Claude Code plugin. Every slash command routes through the plugin; there is no separate CLI.

The canonical per-command reference with every flag, every example, and every exit code lives at [docs/commands.md](../commands.md). This index is a short pointer so the top-level README does not need to repeat the flag tables.

## Core three

| Command | What it does |
|---|---|
| `/forge:brainstorm <idea>` | Turn one line into a spec with R-numbered requirements and testable acceptance criteria |
| `/forge:plan` | Decompose the approved spec into a dependency-ordered task frontier |
| `/forge:execute [--autonomy gated\|full] [--filter <spec>]` | Run the autonomous implementation loop |

## Observability

| Command | What it does |
|---|---|
| `/forge:watch` | Live TUI dashboard, 10 Hz refresh, read-only against `.forge/` state |
| `/forge:status [--json]` | One-shot status; JSON mode emits a 17-field versioned schema in ~2 ms |

## Recovery and maintenance

| Command | What it does |
|---|---|
| `/forge:resume` | Rebuild phase + current task + completed tasks from checkpoints + git log, continue where the prior run stopped |
| `/forge:backprop [description]` | Trace a runtime bug to the spec gap that let it through, propose spec update, generate regression test |
| `/forge:review-branch [branch]` | Holistic review of an existing branch before merge: blast radius, conventions, security, spec compliance |
| `/forge:setup-tools` | Detect missing CLIs and offer to install |
| `/forge:update` | Pull latest Forge from upstream |
| `/forge:help` | Usage guide |

## Autonomy modes

`--autonomy gated` (default) pauses before each external side effect: installing a dep, hitting a paid API, pushing to a remote. `--autonomy full` assumes prior explicit consent, same side effects, no pause. See the README top section for the full automatic-vs-explicit-approval table.
