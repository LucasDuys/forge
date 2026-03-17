# Forge

**Autonomous spec-driven development for Claude Code.**

<!-- Badges (uncomment when published) -->
<!-- ![Version](https://img.shields.io/badge/version-0.1.0-blue) -->
<!-- ![License](https://img.shields.io/badge/license-MIT-green) -->

## What is Forge?

Forge is a Claude Code CLI plugin that turns a single idea into working, tested code through three commands: **brainstorm**, **plan**, and **execute**. It runs a smart loop powered by a state machine that routes between implementation, testing, review, and debugging — all without you pressing Enter. The system self-improves via backpropagation (tracing runtime bugs back to spec gaps), adapts its ceremony level to match task complexity, and manages its own token budget so it can run autonomously for hours.

## Installation

```bash
# 1. Download or clone the forge directory
# 2. Launch Claude Code with the plugin:
claude --plugin-dir /path/to/forge

# Or add a permanent alias to your shell:
echo 'alias claude-forge="claude --plugin-dir /path/to/forge"' >> ~/.bashrc
source ~/.bashrc
```

**Requirements:** Claude Code v1.0.33+ (plugin support). No `npm install` needed.

> **Note:** Commands are namespaced as `/forge:brainstorm`, `/forge:plan`, `/forge:execute`, etc.

## Quick Start

```bash
# 1. Brainstorm — interactive Q&A that produces a formal spec
/forge:brainstorm "build a REST API for task management"

# 2. Plan — decomposes the spec into an ordered task DAG
/forge:plan

# 3. Execute — autonomous implementation loop
/forge:execute --autonomy gated
```

## Commands

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `/forge:brainstorm [topic]` | Interactive spec generation from an idea | `--from-code`, `--from-docs path/` |
| `/forge:plan` | Decompose specs into ordered task frontiers | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge:execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N`, `--token-budget N` |
| `/forge:resume` | Continue after context reset or interruption | — |
| `/forge:backprop [desc]` | Trace a bug back to a spec gap | `--from-test path/` |
| `/forge:status` | Show current progress, budget, blockers | — |
| `/forge:help` | Usage guide for all commands and flags | — |

## Features

- **Three-layer smart loop** — Outer loop (phase/spec progression), middle loop (task progression), inner loop (quality iteration: implement, test, review, fix).
- **Configurable autonomy** — `full` (runs unattended), `gated` (pauses between phases), `supervised` (pauses between tasks).
- **Adaptive depth** — Auto-detects complexity and scales ceremony: `quick` (3-5 tasks, no review), `standard` (6-12 tasks, reviews on critical paths), `thorough` (12-20 tasks, TDD + review on every task).
- **Context window management** — Monitors estimated context usage. At 60% threshold, saves a handoff snapshot and exits cleanly so a fresh session can continue.
- **Token budget tracking** — Tracks cumulative usage across sessions. Auto-downgrades to quick mode at 70%, graceful exit at 90%.
- **Multi-repo support** — Coordinates work across multiple repositories with API-first ordering. Each task is tagged with its target repo.
- **Backpropagation** — Traces runtime bugs back to spec gaps, proposes spec updates, generates regression tests. After 3+ similar backprops, suggests systemic spec improvements.
- **Capability discovery** — Scans your MCP servers, plugins, and skills at startup. Routes work to leverage tools you already have (Playwright for E2E, Context7 for docs, etc.).
- **Circuit breakers** — Prevents infinite loops. 3 test failures triggers debug mode, 3 debug attempts escalates to human, 2 no-progress iterations flags a blocker.

## Configuration

Forge stores per-project state in `.forge/` (gitignored by default). Initialize it with `/forge:brainstorm` or the setup script:

```bash
bash scripts/setup.sh
```

Key settings in `.forge/config.json`:

```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "context_reset_threshold": 60,
  "repos": { ... },
  "loop": {
    "circuit_breaker_test_fails": 3,
    "circuit_breaker_debug_attempts": 3,
    "single_task_budget_percent": 20
  }
}
```

See the [design spec](docs/superpowers/specs/2026-03-17-forge-design.md) for the full config schema.

## Architecture

```
forge/
├── .claude-plugin/plugin.json     Plugin manifest
├── commands/                      Slash commands (brainstorm, plan, execute, resume, backprop, status, help)
│   └── *.md                       Each command is a markdown prompt
├── skills/                        Procedural workflows
│   ├── brainstorming/             Spec generation workflow
│   ├── planning/                  Task decomposition + DAG
│   ├── executing/                 Autonomous implementation
│   ├── backpropagation/           Bug-to-spec tracing
│   └── reviewing/                 Claude-on-Claude review
├── agents/                        Specialized subagents
│   ├── forge-speccer.md           Writes specs from brainstorm output
│   ├── forge-planner.md           Decomposes specs into tasks
│   ├── forge-executor.md          Implements tasks (TDD)
│   ├── forge-reviewer.md          Reviews code against spec
│   ├── forge-verifier.md          Goal-backward phase verification
│   └── forge-complexity.md        Recommends depth level
├── hooks/
│   ├── hooks.json                 Hook registration
│   ├── stop-hook.sh               Smart loop engine (state machine)
│   └── token-monitor.sh           Token usage + context monitoring
├── scripts/
│   ├── forge-tools.cjs            Core utility (state, config, token math, capability discovery)
│   └── setup.sh                   Initialize .forge/ in a project
├── templates/                     Output file templates (spec, plan, state, summary)
└── references/                    Reference docs (token profiles, patterns, heuristics)
```

**How the loop works:**

```
User runs /forge:execute
        │
        v
  ┌─────────────────────────────────────────┐
  │  STOP HOOK (fires after each response)  │
  │                                         │
  │  1. Read state + frontier + budget      │
  │  2. Route via state machine             │
  │  3. Return next prompt OR allow exit    │
  └─────────────────────────────────────────┘
        │                         │
   ┌────┘                         └────┐
   v                                   v
 "block" + next prompt            clean exit
 (loop continues)                 (done / budget / human needed)
```

## Fully Autonomous Mode

For long-running sessions that may hit context limits, use the wrapper script:

```bash
# After /forge:execute, if using full autonomy:
bash scripts/forge-runner.sh
```

This script auto-restarts Claude after context resets, reads the handoff snapshot from `.forge/.forge-resume.md`, and continues from the exact point of interruption. It exits when the work is complete or when human intervention is needed.

## Platform Support

| Platform | Status |
|----------|--------|
| Windows (WSL) | Primary target |
| macOS | Supported |
| Linux | Supported |

No native dependencies. Pure JavaScript (CommonJS) + Bash. No build step, no bundler, no `npm install`.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run tests: `node --test tests/`
5. Commit with a descriptive message (`feat: add X` / `fix: resolve Y`)
6. Open a pull request

## License

[MIT](LICENSE)
