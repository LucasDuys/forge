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
| **Task decomposition** | Specs are broken into an ordered dependency DAG with parallel frontiers and CLI-Anything tagging |
| **Research before code** | forge-researcher agent queries official docs, academic papers, and codebase conventions before implementation |
| **Autonomous execution** | Three-layer loop (phase / task / quality) runs implement-test-review-fix cycles without intervention |
| **Adaptive depth** | Auto-detects complexity: `quick` (3-5 tasks), `standard` (6-12), `thorough` (12-20 with TDD + review on every task) |
| **Blast radius analysis** | Reviewer checks all dependents of modified files for breaking changes before approving |
| **Legacy code safe** | Auto-detects conventions from existing code (imports, naming, error handling, tests) -- matches patterns, not just CLAUDE.md |
| **Context survival** | Monitors context usage, saves handoff snapshots at 60%, resumes cleanly in a new session |
| **Self-correction** | Circuit breakers catch loops: 3 test fails triggers debug mode, 3 debug attempts escalates to you |
| **Runtime verification** | 4-level goal-backward verification: existence, substantive, wired, and runtime (Playwright, Stripe, Vercel) |
| **Backpropagation** | Traces runtime bugs back to spec gaps, updates specs, generates regression tests |
| **CLI tool ecosystem** | Auto-discovers 11+ CLI tools (gh, stripe, ffmpeg, vercel, gws, etc.) and adapts execution accordingly |
| **CLI-Anything** | On-demand desktop app CLI generation (GIMP, Blender, LibreOffice) -- planner tags tasks, executor generates and uses |

## Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge:brainstorm [topic]` | Interactive spec generation from an idea | `--from-code`, `--from-docs path/` |
| `/forge:plan` | Decompose specs into ordered task frontiers | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge:execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge:resume` | Continue after context reset or interruption | -- |
| `/forge:backprop [desc]` | Trace a bug back to a spec gap | `--from-test path/` |
| `/forge:status` | Show current progress, budget, blockers | -- |
| `/forge:review-branch` | Review an unmerged branch before merging | `--base main`, `--spec path/`, `--fix`, `--comment` |
| `/forge:setup-tools` | Detect and install CLI tools that enhance Forge | -- |

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
  agents/          Specialized subagents (speccer, planner, executor, reviewer, verifier, researcher, complexity)
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

## Enterprise & Legacy Codebase Support

Forge is designed to be safe for large enterprise codebases with legacy code and many contributors.

### Convention Inference

When `CLAUDE.md` is missing or incomplete, the executor auto-detects conventions from existing code:

- **Import style**: scans for `import` vs `require()` patterns
- **Naming**: detects camelCase vs snake_case for variables, PascalCase vs kebab-case for files
- **Error handling**: identifies custom error classes, catch patterns, error response shapes
- **Test framework**: detects jest/mocha/vitest/pytest and test file locations
- **File organization**: reads directory structure and follows it

**Critical rule:** For legacy codebases, Forge matches existing conventions even if they differ from modern best practices. Consistency within a codebase takes priority over modernity.

### Blast Radius Analysis

The reviewer (Step 2.5) runs dependency impact analysis before approving any task:

1. Finds all files that import from modified modules
2. Checks for breaking changes in exported signatures
3. Verifies dependent tests still pass
4. Flags untested downstream modules
5. Respects CODEOWNERS for domain-specific review routing

### Branch Review (Pre-Merge Verification)

Review existing branches before merging -- works both standalone and inside the execution loop:

```bash
# Standalone: review your current branch against main
/forge:review-branch --base main

# With spec compliance check
/forge:review-branch --base main --spec .forge/specs/spec-auth.md

# Auto-fix critical issues and post to PR
/forge:review-branch --base main --fix --comment
```

Dispatches 4 parallel review agents (following Anthropic's multi-agent code review architecture):
1. **Spec compliance** -- verifies every acceptance criterion is met
2. **Blast radius** -- checks all dependents of modified files for breaking changes
3. **Convention & quality** -- validates code matches existing codebase patterns
4. **Research validation** (thorough depth) -- verifies approaches against official docs

**Inside the execution loop:** Automatically runs after all tasks in a spec complete, before phase verification. Catches cross-task integration issues that per-task reviews miss.

### Research Before Implementation

The `forge-researcher` agent investigates best practices before the executor writes code:

- Queries official framework/library documentation (via Context7 MCP)
- Searches academic papers (Semantic Scholar, arXiv MCP servers)
- Scans existing codebase for established patterns
- Ranks sources by credibility (peer-reviewed > vendor docs > community)
- Produces a structured research report with citations

Mandatory for security-sensitive and `thorough` depth tasks. Optional for simple tasks.

## CLI Tool Ecosystem

Forge auto-discovers CLI tools on your system and adapts its execution accordingly. Run `/forge:setup-tools` to see what's available and install what's missing.

| Tool | What Forge Uses It For |
|------|----------------------|
| `gh` | PR creation, issue linking, CI status checks |
| `playwright` | E2E browser testing, runtime verification |
| `stripe` | Payment webhook testing, event simulation |
| `ffmpeg` | Video/audio processing, media verification |
| `vercel` | Preview deployments, serverless function testing |
| `gws` | Google Workspace access (Drive, Gmail, Sheets) |
| `notebooklm` | Research with grounded, citation-backed answers |
| `supabase` | Database migrations, edge function testing |
| `firebase` | Emulator testing, cloud function deployment |
| `docker` | Containerized dependencies for integration tests |

### CLI-Anything Integration

Forge can generate CLIs for desktop applications on the fly via [CLI-Anything](https://github.com/HKUDS/CLI-Anything):

1. The **planner** tags tasks that need desktop app control: `cli: gimp`, `cli: blender`
2. The **executor** checks if the CLI exists; if not, generates it automatically
3. Generated CLIs persist on PATH for reuse by future tasks

Supported apps: GIMP, Blender, Inkscape, LibreOffice, Audacity, Kdenlive, OBS Studio, and more.

## Agents

| Agent | Role |
|-------|------|
| **forge-speccer** | Writes R-numbered specs with testable acceptance criteria from brainstorm output |
| **forge-planner** | Decomposes specs into dependency DAGs with parallel tiers and token estimates |
| **forge-executor** | Implements tasks with TDD/standard/quick depth, convention inference, and targeted tests |
| **forge-researcher** | Multi-source research (docs, papers, codebase) before implementation |
| **forge-reviewer** | Two-pass review (spec compliance + quality) with blast radius analysis |
| **forge-verifier** | Four-level goal-backward verification: existence, substantive, wired, runtime |
| **forge-complexity** | Auto-scores task complexity and recommends depth level |

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
