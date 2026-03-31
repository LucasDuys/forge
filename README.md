<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg">
    <img alt="Forge" src="https://raw.githubusercontent.com/LucasDuys/forge/main/docs/assets/forge-banner-light.svg" width="600">
  </picture>
</p>

<h3 align="center">One idea in. Tested, reviewed, committed code out.</h3>

<p align="center">
  <a href="https://github.com/LucasDuys/forge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://github.com/LucasDuys/forge/stargazers"><img src="https://img.shields.io/github/stars/LucasDuys/forge?style=flat" alt="Stars"></a>
  <a href="https://github.com/LucasDuys/forge/releases"><img src="https://img.shields.io/badge/version-2.0-green" alt="Version"></a>
  <a href="https://github.com/LucasDuys/forge/issues"><img src="https://img.shields.io/github/issues/LucasDuys/forge" alt="Issues"></a>
</p>

---

## The Problem

Claude Code is powerful, but for non-trivial features you become the glue: prompting, reviewing, re-prompting, losing context, starting over. A 12-task feature takes dozens of manual exchanges and multiple sessions.

**Forge replaces that entire loop with three commands.**

## The Pipeline

```
/forge:brainstorm                 /forge:plan                        /forge:execute

"Add real-time collab       -->   Dependency DAG with            --> Streaming execution:
 with conflict resolution          typed artifact contracts,         tasks launch the instant
 and live cursors"                 model routing, context             deps complete. Implement,
                                   bundles per task                   test, review, commit.

Interactive Q&A that               Smart depth detection:            Runs unattended.
produces a formal spec             quick | standard | thorough       Self-corrects on failures.
with R-numbered requirements       Token budget per task             Handles context resets.
```

## Quick Start

```bash
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

```bash
/forge:brainstorm "build a REST API for task management"
/forge:plan
/forge:execute
```

That is it. No `npm install`, no build step, no dependencies. Requires Claude Code v1.0.33+.

---

## Before and After

| | Without Forge | With Forge |
|---|---|---|
| **Planning** | You decompose features mentally, forget edge cases | Formal spec with numbered requirements + acceptance criteria |
| **Execution** | Prompt, review, re-prompt, lose context, repeat | Autonomous DAG execution across sessions |
| **Testing** | "Can you add tests?" after the fact | TDD built into every task cycle |
| **Review** | You eyeball the diff | Blast radius analysis + spec compliance + convention matching |
| **Context resets** | Start over, lose progress | Auto-save at 60% usage, seamless resume |
| **Cost** | Every agent runs on the same model | Intelligent routing: haiku for simple tasks, opus only when needed |

---

## What's New in V2

### Streaming DAG Execution

V1 waited for an entire tier of tasks to finish before starting the next tier. V2 launches each task the instant its specific dependencies complete.

- **20-40% faster wall-clock time** on standard and thorough depth plans
- Configurable concurrency: `max_concurrent_agents` (default: 3)
- Automatic file overlap detection prevents conflicts between parallel tasks

### Typed Artifact Contracts

Tasks declare what they `provides:` and what they `consumes:`. Executors write structured artifact JSON. Downstream agents receive 2-3 line summaries instead of re-reading source files.

- **5-15K token savings per execution** from eliminated redundant file reads
- Catches missing integration points at plan time, not at runtime
- Artifacts are typed (schema, endpoint, component, config) for precise routing

### Intelligent Model Routing

Every task is scored 0-20 across 5 complexity dimensions, then mapped to the right model.

| Model | Cost Weight | Used For |
|-------|------------|----------|
| Haiku | 1x | Simple implementations, config changes, boilerplate |
| Sonnet | 5x | Standard features, all reviews (minimum baseline) |
| Opus | 25x | Complex architecture, security-critical code |

Role baselines ensure reviewers never drop below Sonnet. **30-40% cost reduction** compared to running everything on the same model.

### Codex Hybrid Integration

Forge optionally integrates [OpenAI Codex CLI](https://github.com/openai/codex) as a second AI model at two critical points in the execution loop. The core insight: **using a different model for review than for implementation eliminates correlated blind spots**.

**Adversarial Review Gate** -- After Claude's forge-reviewer passes a task, Codex (GPT-5.4-mini) reviews the same diff looking specifically for race conditions, edge cases, and hidden assumptions. Claude is strong at spec compliance; Codex catches what a single-model pipeline misses. Adds ~6% cost at standard depth.

**Debug Rescue Escalation** -- When Claude is stuck after 2 debug attempts, Forge dispatches a Codex rescue agent with a structured diagnosis prompt. A different model often sees the root cause immediately because it reasons differently. One rescue call ($0.50) is cheaper than 3 more Claude attempts (~$1.50+) with diminishing returns.

```
Claude implements --> Claude reviews --> Codex adversarial review --> commit
                                              |
Claude debugging (2 attempts) ------> Codex rescue ------> re-decompose or human
```

**Setup** (optional -- Forge works without Codex):

```bash
npm install -g @openai/codex        # install Codex CLI
codex login                          # authenticate
/codex:setup                         # verify in Claude Code
```

**Configuration:**

```jsonc
{
  "codex": {
    "enabled": true,
    "review": {
      "enabled": true,
      "depth_threshold": "standard",   // never at quick, always at thorough
      "model": "gpt-5.4-mini",         // cheap + catches edge cases
      "sensitive_tags": ["security", "shared", "api-export"]
    },
    "rescue": {
      "enabled": true,
      "debug_attempts_before_rescue": 2,
      "model": null                     // uses Codex default
    }
  }
}
```

When Codex CLI is not installed, all integration points are silently skipped. No errors, no warnings, no behavior change.

### Token-Saving Hooks

| Hook | What It Does | Savings |
|------|-------------|---------|
| Test output filter | Shows only failures, suppresses passing test noise | 22-26K tokens/session |
| Tool call cache | 2-minute TTL on idempotent calls (file reads, directory listings) | 2-4.5K tokens/session |
| Zero-context progress tracker | Writes progress to stderr only | Zero token cost |

### Task Re-Decomposition

When a task fails, Forge auto-breaks it into smaller sub-tasks (T003.1, T003.2) before escalating to human. This adds a recovery layer between the circuit breaker and human intervention, resolving most failures without your input.

### Context Bundles

Each task gets a pre-assembled context file: the relevant spec requirements, upstream artifacts, convention snippets, and dependency signatures in one curated document. Replaces 4-5 separate file reads with 1 targeted read.

### Adaptive Replanning

After wave boundaries, if 30%+ of completed tasks had reviewer concerns, the planner re-evaluates remaining tasks. It can reorder, merge, or split tasks based on what was learned during execution.

---

## Architecture

```
forge/
  commands/        Slash commands (brainstorm, plan, execute, resume, backprop, status)
  skills/          Procedural workflows (brainstorming, planning, executing, reviewing)
  agents/          Specialized subagents with model routing + artifact contracts
  hooks/           Loop engine (state machine + token monitor + tool cache)
  scripts/         Core utilities (state, config, token math, capability discovery)
  templates/       Output + config templates (spec, plan, state, artifacts, config)
  references/      Reference docs (token profiles, patterns, heuristics)
```

### Execution Flow

```
/forge:execute
      |
      v
  LOAD plan DAG + artifact contracts
      |
      v
  STREAMING SCHEDULER -----> picks tasks whose deps are satisfied
      |                       scores complexity (0-20)
      |                       routes to haiku / sonnet / opus
      |                       assembles context bundle
      |
      +---> EXECUTOR: implement + test
      |         |
      |         v
      |     REVIEWER: spec compliance + blast radius + conventions
      |         |
      |         v
      |     (optional) CODEX REVIEW: adversarial cross-model check
      |         |
      |         v
      |     ARTIFACT WRITE: structured output for downstream consumers
      |         |
      |         +---> Pass: atomic commit, unlock dependents
      |         +---> Fail: re-decompose into sub-tasks or escalate
      |
      +---> WAVE BOUNDARY: adaptive replanning if concern_threshold hit
      |
      +---> CONTEXT MONITOR: save handoff at 60%, resume in new session
      |
      v
  DONE: all tasks committed, branch ready
```

## Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge:brainstorm [topic]` | Interactive spec generation from an idea | `--from-code`, `--from-docs path/` |
| `/forge:plan` | Decompose specs into streaming DAG with artifact contracts | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge:execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge:resume` | Continue after context reset or interruption | -- |
| `/forge:backprop [desc]` | Trace a bug back to a spec gap | `--from-test path/` |
| `/forge:status` | Show current progress, budget, blockers | -- |
| `/forge:review-branch` | Review an unmerged branch before merging | `--base main`, `--spec path/`, `--fix`, `--comment` |
| `/forge:setup-tools` | Detect and install CLI tools that enhance Forge | -- |

## Autonomy Levels

| Level | Behavior | Best For |
|---|---|---|
| `full` | Runs completely unattended, handles context resets automatically | Long-running features, overnight runs |
| `gated` | Pauses between phases for approval | Recommended for first use |
| `supervised` | Pauses between individual tasks | Maximum oversight, learning how Forge works |

```bash
/forge:execute --autonomy full        # hands-off
/forge:execute --autonomy gated       # approve each phase
/forge:execute --autonomy supervised  # approve each task
```

## Agent Roles

| Agent | Role | Model Range |
|-------|------|-------------|
| **forge-speccer** | Writes R-numbered specs with testable acceptance criteria | sonnet - opus |
| **forge-planner** | Decomposes specs into streaming DAGs with artifact contracts | sonnet - opus |
| **forge-executor** | Implements tasks with TDD, convention inference, targeted tests | haiku - opus |
| **forge-researcher** | Multi-source research (docs, papers, codebase) before implementation | haiku - sonnet |
| **forge-reviewer** | Two-pass review: spec compliance + blast radius analysis | sonnet - opus |
| **forge-verifier** | Four-level verification: existence, substantive, wired, runtime | sonnet - opus |
| **forge-complexity** | Scores task complexity across 5 dimensions for model routing | haiku |

## How Forge Differs from Plain Claude Code

| Capability | Claude Code | Forge |
|---|---|---|
| Planning | You hold the plan in your head | Formal dependency DAG with typed contracts |
| Parallelism | One task at a time | Streaming concurrent execution |
| Testing | On request | Built into every task cycle |
| Review | Manual | Automated blast radius + spec compliance + convention matching |
| Cross-model review | Single model only | Claude reviews spec compliance, Codex catches edge cases |
| Cost control | Same model for everything | Intelligent routing (haiku/sonnet/opus per task) |
| Context limits | Session dies, progress lost | Auto-handoff at 60%, seamless resume |
| Failure recovery | You debug | Circuit breaker, Codex rescue, re-decomposition, then human |
| Debugging | Same model retries | Different model (Codex) brings fresh perspective after 2 fails |
| Conventions | Follows CLAUDE.md | Also infers from existing code when CLAUDE.md is incomplete |

## Configuration

Forge stores per-project state in `.forge/` (gitignored). Default config:

```jsonc
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,

  // V2: Streaming concurrency
  "parallelism": {
    "max_concurrent_agents": 3,
    "max_concurrent_per_repo": 2
  },

  // V2: Intelligent model routing
  "model_routing": {
    "enabled": true,
    "cost_weights": { "haiku": 1, "sonnet": 5, "opus": 25 },
    "role_baselines": {
      "forge-reviewer": { "min": "sonnet" },
      "forge-executor": { "min": "haiku", "preferred": "sonnet", "max": "opus" }
    }
  },

  // V2: Token-saving hooks
  "hooks_config": {
    "test_filter": true,
    "tool_cache": true,
    "tool_cache_ttl": 120,
    "progress_tracker": true
  },

  // V2: Adaptive replanning
  "replanning": {
    "enabled": true,
    "concern_threshold": 0.3
  },

  // V2: Task re-decomposition
  "redecomposition": {
    "enabled": true,
    "max_expansion_depth": 1
  },

  // V2: Codex hybrid (graceful degradation if not installed)
  "codex": {
    "enabled": true,
    "review": { "enabled": true, "model": "gpt-5.4-mini" },
    "rescue": { "enabled": true, "debug_attempts_before_rescue": 2 }
  },

  // Circuit breakers
  "loop": {
    "circuit_breaker_test_fails": 3,
    "circuit_breaker_debug_attempts": 3,
    "single_task_budget_percent": 20
  }
}
```

## Enterprise and Legacy Codebase Support

### Convention Inference

When `CLAUDE.md` is missing or incomplete, the executor auto-detects from existing code: import style, naming conventions, error handling patterns, test framework, and file organization. For legacy codebases, Forge matches existing conventions even when they differ from modern best practices. Consistency within a codebase takes priority.

### Blast Radius Analysis

The reviewer runs dependency impact analysis before approving any task: finds all files importing modified modules, checks for breaking changes in exported signatures, verifies dependent tests still pass, flags untested downstream modules, and respects CODEOWNERS for domain-specific review routing.

### Branch Review

```bash
/forge:review-branch --base main                          # standalone review
/forge:review-branch --base main --spec .forge/specs/spec-auth.md  # with spec compliance
/forge:review-branch --base main --fix --comment          # auto-fix + PR comment
```

Dispatches 4 parallel review agents: spec compliance, blast radius, convention/quality, and research validation.

## CLI Tool Ecosystem

Forge auto-discovers CLI tools on your system and adapts execution. Run `/forge:setup-tools` to see what is available.

| Tool | What Forge Uses It For |
|------|----------------------|
| `gh` | PR creation, issue linking, CI status checks |
| `playwright` | E2E browser testing, runtime verification |
| `stripe` | Payment webhook testing, event simulation |
| `vercel` | Preview deployments, serverless function testing |
| `supabase` | Database migrations, edge function testing |
| `docker` | Containerized dependencies for integration tests |

Desktop app CLIs (GIMP, Blender, Inkscape, LibreOffice) are generated on-the-fly via [CLI-Anything](https://github.com/HKUDS/CLI-Anything) when the planner tags tasks that need them.

## Fully Autonomous Mode

For sessions that may hit context limits:

```bash
bash scripts/forge-runner.sh
```

This wrapper auto-restarts Claude after context resets, reads the handoff snapshot from `.forge/.forge-resume.md`, and continues from the exact point of interruption.

## Platform Support

Works on **macOS**, **Linux**, and **Windows (WSL)**. Pure JavaScript (CommonJS) + Bash. No native dependencies, no build step.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run tests: `node --test tests/`
5. Commit with a descriptive message
6. Open a pull request

## License

[MIT](LICENSE)
