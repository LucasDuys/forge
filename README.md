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
  <a href="https://lucasduys.github.io/forge/"><img src="https://img.shields.io/badge/docs-architecture_video-orange" alt="Docs"></a>
</p>

<p align="center">
  <a href="https://lucasduys.github.io/forge/">Watch the architecture video</a>
</p>

---

## The Problem

Claude Code is powerful, but for non-trivial features you become the glue: prompting, reviewing, re-prompting, losing context, starting over. A 12-task feature takes dozens of manual exchanges and multiple sessions.

**Forge replaces that entire loop with three commands.**

```
/forge brainstorm "your feature idea"
/forge plan
/forge execute --autonomy full
```

No `npm install`, no build step, no dependencies. Requires Claude Code v1.0.33+.

```bash
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

---

## Architecture

### The Three-Tiered Loop

Forge runs three nested loops. Each has its own circuit breakers and progression logic.

**Outer loop: Phase progression** -- Controls which spec is active and which phase runs next. Phases: `idle` > `executing` > `reviewing_branch` > `verifying` > `idle`. Driven by the stop hook state machine.

**Middle loop: Task progression** -- Within a spec, tasks advance through the dependency DAG. Streaming topological dispatch: tasks start the instant their specific dependencies complete, not when the entire tier finishes. 20-40% faster than tier-gated waves.

**Inner loop: Quality iteration** -- Each task cycles through `implement > test > fix (max 3) > debug > Codex rescue > redecompose > blocked`. Circuit breakers at every transition prevent infinite loops.

### The Self-Prompting Engine

The stop hook (`hooks/stop-hook.sh`) intercepts every Claude exit. It reads state from `.forge/.forge-loop.json`, calls `routeDecision()` in `forge-tools.cjs` (a 200+ line state machine), and either blocks exit with the next prompt or allows it. Claude never needs a human to tell it what to do next.

```
Claude acts > attempts exit > stop hook fires > routeDecision() > block with next prompt > repeat
```

Completion signal: Claude outputs `<promise>FORGE_COMPLETE</promise>` only when all tasks are complete and verified. The hook detects it, generates a summary, deletes the loop file, and allows exit.

### Execution Flow

```
/forge execute
      |
  LOAD plan DAG + artifact contracts
      |
  STREAMING SCHEDULER -----> picks tasks whose deps are satisfied
      |                       scores complexity (0-20)
      |                       routes to haiku / sonnet / opus
      |                       assembles context bundle
      |
      +---> RESEARCHER: deep research (official docs, papers, codebase conventions)
      |         |
      +---> EXECUTOR: implement + test (TDD at thorough depth)
      |         |
      |     REVIEWER: spec compliance + blast radius + conventions
      |         |
      |     (optional) CODEX REVIEW: adversarial cross-model check
      |         |
      |     ARTIFACT WRITE: structured output for downstream consumers
      |         |
      |         +---> Pass: atomic commit, unlock dependents
      |         +---> Fail: debug > Codex rescue > re-decompose > block
      |
      +---> CONTEXT MONITOR: save handoff at 60%, resume in new session
      |
      v
  VERIFIER: goal-backward verification (existence > substantive > wired > runtime)
      |
  DONE: all tasks committed, branch ready
```

### Deep Research Before Execution

The forge-researcher agent investigates before the executor touches code. Dispatched for unfamiliar tech, security-sensitive code, and external integrations. Follows a tiered source hierarchy:

| Tier | Source | Trust |
|------|--------|-------|
| 1 | Official docs (Context7, WebFetch) | Highest |
| 2 | Peer-reviewed papers, RFCs (Semantic Scholar) | High |
| 3 | Vendor blogs (Anthropic, Stripe, Vercel) | Medium |
| 4 | Community (GitHub discussions, Stack Overflow) | Medium |
| 5 | Blog posts (only with Tier 1-3 corroboration) | Low |

The researcher also infers codebase conventions: import style (ESM vs CJS), naming (camelCase vs snake_case), error handling patterns, and test framework. Legacy patterns are documented and followed for consistency.

### Seven Specialized Agents

| Agent | Role | Min Model | Key Constraint |
|-------|------|-----------|----------------|
| forge-speccer | Writes R-numbered specs with testable criteria | sonnet | One question at a time, capability-aware criteria |
| forge-planner | Decomposes specs into streaming DAGs | sonnet | Coverage verification, no gold-plating |
| forge-executor | Implements tasks with TDD + convention inference | haiku | Follow existing patterns, no scope creep |
| forge-researcher | Multi-source research before implementation | haiku | Produces reports only, never writes code |
| forge-reviewer | Two-pass review: spec compliance + blast radius | sonnet | Reads actual code, never trusts executor reports |
| forge-verifier | Four-level goal-backward verification | sonnet | Checks observable truths, not task checkboxes |
| forge-complexity | Scores task difficulty across 5 dimensions | haiku | Lightweight, runs on every command startup |

The separation between agents is deliberate. The reviewer has fresh context and no implementation bias. The verifier never sees execution details, only checks outcomes against the spec.

---

## Circuit Breakers

Seven levels of circuit breakers prevent infinite loops and runaway spending. Each escalates to the next when exhausted.

| Level | Trigger | Threshold | Action |
|-------|---------|-----------|--------|
| 1 | Test failures | 3 consecutive | Enter DEBUG mode |
| 2 | Debug attempts | 2 failures | Codex rescue (different model, fresh perspective) |
| 3 | Debug exhaustion | 3 total | Re-decompose task into sub-tasks (T005.1, T005.2) |
| 4 | Review iterations | 3 passes | Accept with warnings, move on |
| 5 | No progress | 2 identical snapshots | Block for human |
| 6 | Max iterations | 100 (configurable) | Save state, force exit |
| 7 | Budget exhaustion | 100% of token budget | Graceful handoff |

---

## Token-Saving Hooks

Three hooks operate at zero or near-zero context cost. Patterns derived from studying the Claude Code source.

| Hook | Type | What It Does | Savings |
|------|------|-------------|---------|
| Test output filter | PostToolUse | Detects test runners, compresses output >2000 chars to failures + context + summary | 22-26K tokens/session |
| Tool call cache | PreToolUse | Caches idempotent calls (git status, ls, Read, Grep) with 2min TTL. Never caches mutations. | 2-4.5K tokens/session |
| Progress tracker | PostToolUse | Writes to disk + stderr only. Never stdout. | Zero token cost |

---

## Intelligent Model Routing

Every task is scored 0-20 across 5 dimensions:

| Dimension | Score Range |
|-----------|------------|
| Files touched | 0-4 |
| Task type (scaffolding through architecture) | 0-5 |
| Judgment required | 0-4 |
| Cross-component dependencies | 0-5 |
| Novelty | 0-4 |

Score mapping: 0-4 = haiku, 5-10 = sonnet, 11+ = opus. Role baselines enforce quality floors (reviewers never drop below sonnet). Budget pressure >70% downgrades one tier, >90% uses role minimum only. **30-40% cost reduction** vs single-model approach.

---

## Goal-Backward Verification

The verifier works backwards from the spec, not forwards from the tasks. Four levels:

| Level | Checks |
|-------|--------|
| **Existence** | Do expected files, functions, routes, migrations exist? |
| **Substantive** | Real code, not stubs? Detects TODO, hardcoded returns, empty catch, skipped tests, placeholder components. |
| **Wired** | Module imported where used? Route registered? Middleware applied? Dead code = not satisfied. |
| **Runtime** | If Playwright: E2E tests. If Stripe: webhook handlers. If Vercel: deploy preview. If gh: CI status. |

---

## Backpropagation

When a bug is found post-execution, `/forge backprop` traces it back to the spec gap that allowed it.

1. **TRACE** -- Which spec and R-number does this bug map to?
2. **ANALYZE** -- Gap type: missing criterion, incomplete criterion, or missing requirement
3. **PROPOSE** -- Spec update for human approval
4. **GENERATE** -- Regression test that would have caught it
5. **VERIFY** -- Run test (should fail, confirming the gap). Optionally re-execute affected tasks.
6. **LOG** -- Record in backprop history. After 3+ gaps of the same category (input_validation, concurrency, error_handling), suggest systemic changes to future brainstorming questions.

---

## Context Reset and Resume

At 60% context usage, Forge saves a comprehensive handoff to `.forge/state.md`: current phase, task in progress, what's done (with commit hashes), in-flight work, key decisions, and token usage. New session reads state, spec, and frontier, then continues exactly where it left off. No re-reading completed work.

For sessions that may hit context limits, the runner wrapper auto-restarts Claude:

```bash
bash scripts/forge-runner.sh
```

---

## Codex Hybrid Integration

Optionally integrates [OpenAI Codex CLI](https://github.com/openai/codex) at two critical points. Core insight: **different model for review = different blind spots caught**.

**Adversarial Review Gate** -- After Claude's reviewer passes, Codex reviews the same diff for race conditions, edge cases, and hidden assumptions. ~6% cost at standard depth.

**Debug Rescue** -- Claude stuck after 2 attempts? Codex gets a structured diagnosis prompt. One rescue call ($0.50) beats 3 more Claude attempts ($1.50+).

```bash
npm install -g @openai/codex    # optional -- Forge works without it
codex login
```

When Codex CLI is not installed, all integration is silently skipped.

---

## Streaming DAG Execution

Tasks launch the instant their specific dependencies complete, not when the entire tier finishes. Typed artifact contracts between tasks: each task declares what it `provides:` and `consumes:`. Downstream agents get 2-3 line artifact summaries instead of re-reading source files (saves 5-15K tokens per execution).

Concurrency controls: max 3 concurrent agents, max 2 per repo, zero file overlap allowed between parallel tasks.

---

## CLI Tool Ecosystem

Forge auto-discovers CLI tools and adapts execution. Run `/forge setup-tools` to see what's available.

| Tool | What Forge Uses It For |
|------|----------------------|
| `gh` | PR creation, issue linking, CI status checks |
| `playwright` | E2E browser testing, runtime verification |
| `stripe` | Payment webhook testing, event simulation |
| `vercel` | Preview deployments, serverless function testing |
| `docker` | Containerized dependencies for integration tests |
| `ffmpeg` | Media processing, transcoding |

Desktop app CLIs (GIMP, Blender, LibreOffice) are generated on-the-fly via [CLI-Anything](https://github.com/HKUDS/CLI-Anything) when tasks require them.

---

## Enterprise and Legacy Codebase Support

**Convention inference** -- When CLAUDE.md is missing or incomplete, the executor auto-detects from existing code: import style, naming conventions, error handling patterns, test framework, and file organization. Legacy codebases get matched, not modernized. Consistency within a codebase takes priority.

**Blast radius analysis** -- The reviewer finds all files importing modified modules, checks for breaking changes in exported signatures, verifies dependent tests still pass, flags untested downstream modules, and respects CODEOWNERS for domain-specific routing.

**Branch review** -- Dispatches 4 parallel review agents: spec compliance, blast radius, convention/quality, and research validation.

```bash
/forge review-branch --base main --spec .forge/specs/spec-auth.md --fix --comment
```

---

## Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge brainstorm [topic]` | Interactive spec generation | `--from-code`, `--from-docs path/` |
| `/forge plan` | Decompose specs into streaming DAG | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge resume` | Continue after context reset | -- |
| `/forge backprop [desc]` | Trace bug to spec gap | `--from-test path/` |
| `/forge status` | Progress, budget, blockers | -- |
| `/forge review-branch` | Review unmerged branch | `--base main`, `--fix`, `--comment` |
| `/forge setup-tools` | Detect and install CLI tools | -- |

## Autonomy Levels

| Level | Behavior | Best For |
|---|---|---|
| `full` | Runs unattended, handles context resets | Long-running features, overnight |
| `gated` | Pauses between phases for approval | Recommended default |
| `supervised` | Pauses between individual tasks | Maximum oversight |

---

## Configuration

Forge stores per-project state in `.forge/` (gitignored). See `templates/config.json` for the full default configuration including streaming concurrency, model routing, token hooks, adaptive replanning, re-decomposition, Codex hybrid, and circuit breaker thresholds.

## Project Structure

```
forge/
  commands/        Slash commands (brainstorm, plan, execute, resume, backprop, status)
  skills/          Procedural workflows (brainstorming, planning, executing, reviewing)
  agents/          Specialized subagents with model routing + artifact contracts
  hooks/           Self-prompting engine (stop hook state machine + token hooks)
  scripts/         Core utilities (state machine, routing, budgeting, capability discovery)
  templates/       Output + config templates
  references/      Reference docs (token profiles, patterns, heuristics)
  docs/            Architecture video + design docs (GitHub Pages)
```

## Platform Support

Works on macOS, Linux, and Windows (WSL). Pure JavaScript (CommonJS) + Bash. No native dependencies, no build step.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Make your changes
4. Run tests: `node --test tests/`
5. Open a pull request

## License

[MIT](LICENSE)
