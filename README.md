<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg">
    <img alt="Forge" src="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg" width="600">
  </picture>
</p>

<p align="center">
  <strong>Turn a one-line idea into a branch with tested, reviewed, committed code.</strong>
  <br>
  The brainstorm-to-commit pipeline for Claude Code.
</p>

<p align="center">
  <a href="https://github.com/LucasDuys/forge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://github.com/LucasDuys/forge/stargazers"><img src="https://img.shields.io/github/stars/LucasDuys/forge?style=flat" alt="Stars"></a>
  <a href="https://github.com/LucasDuys/forge/issues"><img src="https://img.shields.io/github/issues/LucasDuys/forge" alt="Issues"></a>
</p>

---

## The Problem

Using Claude Code for non-trivial tasks today looks like this:

1. Describe what you want in a prompt
2. Manually review the output
3. Realize it missed half the requirements
4. Re-prompt with more context
5. Lose track of what was done vs. what remains
6. Hit the context window limit
7. Start over in a new session, losing all progress

**Forge replaces that entire loop with three commands.**

## How It Works

```
  /forge:brainstorm                /forge:plan                    /forge:execute

  "Add real-time collab    --->   Spec decomposed into     --->  Autonomous loop:
   with conflict resolution       ordered task frontiers          implement, test,
   and live cursors"              with dependency DAG             review, commit

  Interactive Q&A that            Smart depth detection:          Runs unattended.
  produces a formal spec          quick | standard | thorough     Handles context resets.
  with R-numbered requirements    TDD + review scheduling         Self-corrects on failures.
```

One idea in. Working, tested, committed code out. No manual intervention required.

## Quick Start

```bash
# Install the plugin
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

Then, in any Claude Code session:

```bash
/forge:brainstorm "build a REST API for task management"
/forge:plan
/forge:execute
```

That's it. Forge handles the rest.

> **Requirements:** Claude Code v1.0.33+ with plugin support. No `npm install`, no build step, no dependencies.

## Why Forge?

**Without Forge**, you are the loop. You read, plan, prompt, review, re-prompt, debug, and commit -- manually, for every task. Context resets lose your progress. Complex features require dozens of back-and-forth exchanges.

**With Forge**, Claude becomes an autonomous development agent that follows a structured pipeline:

| Capability | What it does |
|---|---|
| **Spec generation** | Interactive brainstorm session produces a formal spec with numbered requirements and acceptance criteria |
| **Task decomposition** | Specs are broken into an ordered dependency DAG with parallel frontiers |
| **Autonomous execution** | Three-layer loop (phase / task / quality) runs implement-test-review-fix cycles without intervention |
| **Adaptive depth** | Auto-detects complexity: `quick` (3-5 tasks), `standard` (6-12), `thorough` (12-20 with TDD + review on every task) |
| **Context survival** | Monitors context usage, saves handoff snapshots at 60%, resumes cleanly in a new session |
| **Self-correction** | Circuit breakers catch loops: 3 test fails triggers debug mode, 3 debug attempts escalates to you |
| **Backpropagation** | Traces runtime bugs back to spec gaps, updates specs, generates regression tests |
| **Capability discovery** | Detects your MCP servers, plugins, and skills at startup and routes work through them |

## Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge:brainstorm [topic]` | Interactive spec generation from an idea | `--from-code`, `--from-docs path/` |
| `/forge:plan` | Decompose specs into ordered task frontiers | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge:execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge:resume` | Continue after context reset or interruption | -- |
| `/forge:backprop [desc]` | Trace a bug back to a spec gap | `--from-test path/` |
| `/forge:status` | Show current progress, budget, blockers | -- |

## Autonomy Levels

Choose how much control you want:

- **`full`** -- Runs completely unattended. Handles context resets automatically via the runner script.
- **`gated`** -- Pauses between phases for your approval. Recommended for first use.
- **`supervised`** -- Pauses between individual tasks. Maximum oversight.

```bash
# Fully autonomous (long-running sessions)
/forge:execute --autonomy full

# Pause between phases (recommended)
/forge:execute --autonomy gated

# Pause between tasks
/forge:execute --autonomy supervised
```

## Architecture

```
forge/
  commands/        Slash commands (brainstorm, plan, execute, resume, backprop, status)
  skills/          Procedural workflows (brainstorming, planning, executing, reviewing)
  agents/          Specialized subagents (speccer, planner, executor, reviewer, verifier)
  hooks/           Smart loop engine (state machine + token monitor)
  scripts/         Core utilities (state, config, token math, capability discovery)
  templates/       Output file templates (spec, plan, state, summary)
  references/      Reference docs (token profiles, patterns, heuristics)
```

The loop engine is a stop-hook state machine:

```
/forge:execute
      |
      v
  STOP HOOK fires after each Claude response
      |
      +---> Read state + frontier + token budget
      |
      +---> Route: implement | test | review | debug | next-task | next-frontier
      |
      +---> Return next prompt (loop continues)
      |         or
      +---> Clean exit (done / budget exhausted / human needed)
```

## Fully Autonomous Mode

For sessions that may hit context limits:

```bash
bash scripts/forge-runner.sh
```

This wrapper auto-restarts Claude after context resets, reads the handoff snapshot from `.forge/.forge-resume.md`, and continues from the exact point of interruption.

## Platform Support

Works on **macOS**, **Linux**, and **Windows (WSL)**. Pure JavaScript (CommonJS) + Bash. No native dependencies.

## Configuration

Forge stores per-project state in `.forge/` (gitignored). Key settings:

```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "context_reset_threshold": 60
}
```

See the [design spec](docs/superpowers/specs/2026-03-17-forge-design.md) for the full schema.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run tests: `node --test tests/`
5. Commit with a descriptive message
6. Open a pull request

## License

[MIT](LICENSE)
