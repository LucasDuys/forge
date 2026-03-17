# Forge — Design Specification

**Date:** 2026-03-17
**Author:** Lucas Duys
**Status:** Approved
**Version:** 0.1.0

---

## 1. Overview

Forge is an open-source Claude Code CLI plugin that provides autonomous, spec-driven development. It combines the best ideas from Ralph Loop (autonomous iteration), GSD (structured planning + verification), Superpowers (quality gates + TDD), and SDD (spec-driven backpropagation) into a single, unified system.

Three core commands — `/forge brainstorm`, `/forge plan`, `/forge execute` — chain together to take an idea from concept to working code with minimal human intervention. Additional commands: `/forge backprop` traces runtime bugs back to spec gaps (self-improvement), `/forge resume` continues after context resets or session interruptions, and `/forge status` and `/forge help` provide utility.

### Core Principles

1. **Spec-driven** — Specifications are the source of truth, not code. Code is generated output.
2. **Adaptive** — Auto-detects complexity, scales ceremony. Never wastes tokens on unnecessary process.
3. **Autonomous** — Configurable autonomy levels. Can run unattended for hours or pause at every step.
4. **Self-improving** — Backpropagation traces bugs to spec gaps. The system learns from mistakes.
5. **Ecosystem-aware** — Discovers and leverages whatever MCP servers and skills the user has installed.
6. **Token-efficient** — First-class budget management. Auto-downgrades depth when budget runs low.
7. **Cross-platform** — Works on Windows (WSL), macOS, and Linux. Zero native dependencies.

---

## 2. Installation

```bash
# From marketplace (when published)
claude plugin install forge@<marketplace>

# Local development
claude --plugin-dir /path/to/forge

# Reload without restart
/reload-plugins
```

**Requirements:** Claude Code v1.0.33+ (plugin support). No npm install needed for end users.

---

## 3. Plugin Structure

```
forge/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest (name, version, author, entry points)
├── commands/
│   ├── brainstorm.md                  # /forge brainstorm [topic] [--from-code] [--from-docs path/]
│   ├── plan.md                        # /forge plan [--filter tag] [--depth quick|standard|thorough]
│   ├── execute.md                     # /forge execute [--autonomy full|gated|supervised] [--max-iterations N]
│   ├── resume.md                      # /forge resume
│   ├── backprop.md                    # /forge backprop [description]
│   ├── status.md                      # /forge status
│   └── help.md                        # /forge help
├── skills/
│   ├── brainstorming/SKILL.md         # Spec generation workflow
│   ├── planning/SKILL.md              # Task decomposition + dependency DAG
│   ├── executing/SKILL.md             # Autonomous implementation loop
│   ├── backpropagation/SKILL.md       # Bug-to-spec tracing workflow
│   └── reviewing/SKILL.md            # Claude-on-Claude review protocol
├── agents/
│   ├── forge-speccer.md               # Writes specs from brainstorm output
│   ├── forge-planner.md               # Decomposes specs into ordered tasks
│   ├── forge-executor.md              # Implements individual tasks (TDD)
│   ├── forge-reviewer.md              # Reviews code against spec + quality
│   ├── forge-verifier.md              # Goal-backward phase verification
│   └── forge-complexity.md            # Analyzes task, recommends depth
├── hooks/
│   ├── hooks.json                     # Hook registration (Stop + PostToolUse)
│   ├── stop-hook.sh                   # Smart loop engine (state machine)
│   └── token-monitor.sh              # Token usage tracking + context % monitoring
├── scripts/
│   ├── forge-tools.cjs                # JS utility: state mgmt, config, token math, complexity scoring, capability discovery
│   └── setup.sh                       # Initialize .forge/ in a project
├── templates/
│   ├── spec.md                        # Spec file template
│   ├── plan.md                        # Frontier file template
│   ├── state.md                       # State file template
│   ├── summary.md                     # Execution summary template
│   └── backprop-report.md            # Backpropagation trace template
└── references/
    ├── token-profiles.md              # Token budgets per depth level
    ├── backprop-patterns.md           # How to trace bugs to spec gaps
    ├── multi-repo.md                  # Cross-repo coordination rules
    ├── complexity-heuristics.md       # How auto-detection scores tasks
    └── review-protocol.md            # Claude-on-Claude review standards
```

---

## 4. Per-Project State (`.forge/`)

Created by `/forge brainstorm` or `setup.sh`. Gitignored by default.

```
.forge/
├── config.json                        # Project settings
├── capabilities.json                  # Discovered MCP servers + skills
├── state.md                           # Current position, decisions, progress
├── token-ledger.json                  # Cumulative token usage per phase
├── .forge-loop.json                   # Active loop state (iteration, promise, session)
├── .forge-resume.md                   # Auto-generated resume prompt for context resets
├── specs/
│   └── spec-{domain}.md              # One spec per domain/feature
├── plans/
│   └── {spec}-frontier.md            # Task frontier (ordered, dependency-aware)
├── history/
│   ├── cycles/                        # Archived completed cycles
│   └── backprop-log.md               # Record of all spec corrections
└── summaries/
    └── {spec}-summary.md             # Execution results per spec
```

### 4.1 Config Schema (`.forge/config.json`)

```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "context_reset_threshold": 60,
  "repos": {
    "api": {
      "path": "../my-api",
      "role": "primary",
      "order": 1,
      "conventions": "Read CLAUDE.md in repo root"
    },
    "frontend": {
      "path": "../my-frontend",
      "role": "secondary",
      "order": 2,
      "conventions": "Read .claude/CLAUDE.md"
    }
  },
  "cross_repo_rules": {
    "commit_in_source": true,
    "api_first": true,
    "shared_specs": true
  },
  "loop": {
    "circuit_breaker_test_fails": 3,
    "circuit_breaker_debug_attempts": 3,
    "circuit_breaker_review_iterations": 3,
    "circuit_breaker_no_progress": 2,
    "single_task_budget_percent": 20
  },
  "review": {
    "enabled": true,
    "min_depth": "standard",
    "model": "claude"
  },
  "verification": {
    "enabled": true,
    "min_depth": "standard",
    "stub_detection": true
  },
  "backprop": {
    "auto_generate_regression_tests": true,
    "re_run_after_spec_update": false
  },
  "capability_hints": {}
}
```

### 4.2 Spec File Format

```markdown
---
domain: auth
status: approved
created: 2026-03-17
complexity: medium
linked_repos: [api, frontend]
---

# Auth System Spec

## Overview
Brief description of the domain and its purpose.

## Requirements

### R001: User Registration
Users can register with email and password.
**Acceptance Criteria:**
- [ ] POST /auth/register accepts {email, password}
- [ ] Password hashed with bcrypt (min 12 rounds)
- [ ] Returns 201 with JWT + refresh token
- [ ] Returns 409 if email exists

### R002: Token Refresh
...
```

### 4.3 Frontier File Format

```markdown
---
spec: auth
total_tasks: 8
estimated_tokens: 45000
depth: standard
---

# Auth Frontier

## Tier 1 (parallel)
- [T001] User model + migration          | est: ~4k tokens | repo: api
- [T002] Auth controller scaffolding      | est: ~3k tokens | repo: api

## Tier 2 (depends on T001, T002)
- [T003] Registration endpoint + tests    | est: ~6k tokens | repo: api | depends: T001, T002
- [T004] Login endpoint + tests           | est: ~6k tokens | repo: api | depends: T001, T002

## Tier 3 (depends on T003, T004)
- [T005] JWT middleware + tests           | est: ~5k tokens | repo: api | depends: T003
- [T006] Refresh token rotation + tests   | est: ~7k tokens | repo: api | depends: T004

## Tier 4 (cross-repo)
- [T007] Frontend auth context + hooks    | est: ~6k tokens | repo: frontend | depends: T005
- [T008] Login/register pages + tests     | est: ~8k tokens | repo: frontend | depends: T007
```

### 4.4 State File Format

```markdown
---
phase: executing
spec: auth
current_task: T003
task_status: testing
iteration: 12
tokens_used: 128000
tokens_budget: 500000
depth: standard
autonomy: gated
---

## What's Done
- T001: User model (complete, committed abc123)
- T002: Auth controller (complete, committed def456)

## In-Flight Work
- T003: Registration endpoint — implemented, running tests
- File: src/controllers/auth.ts — needs validation fix

## What's Next
- T003: Fix 1 failing test, then review
- T004-T008 remain in frontier

## Key Decisions
- Using bcrypt over argon2 (per spec R001)
- JWT expiry: 15min access, 7d refresh
```

---

## 5. Command Specifications

### 5.1 `/forge brainstorm`

**Syntax:**
```
/forge brainstorm [topic]
/forge brainstorm --from-code
/forge brainstorm --from-docs path/
/forge brainstorm --resume
```

**Behavior:**
1. Run capability discovery (scan MCP servers, skills, plugins)
2. Save capabilities to `.forge/capabilities.json`
3. If `--from-code`: dispatch forge-complexity agent to analyze codebase, generate initial spec draft
4. If `--from-docs`: read documents from path, extract requirements into spec format
5. Auto-detect complexity:
   - Simple (single feature): quick brainstorm, 3-5 questions
   - Medium (multi-component): standard brainstorm, 8-12 questions
   - Complex (multi-domain): decompose into sub-projects first
6. Interactive Q&A: one question at a time, multiple choice preferred
7. Propose 2-3 approaches with trade-offs and recommendation
8. Write approved specs to `.forge/specs/spec-{domain}.md`
9. Each spec has R-numbered requirements with testable acceptance criteria
10. Initialize `.forge/config.json` if not present

**Output:** One or more spec files in `.forge/specs/`

### 5.2 `/forge plan`

**Syntax:**
```
/forge plan
/forge plan --filter auth
/forge plan --depth quick|standard|thorough
/forge plan --repos api,frontend
```

**Behavior:**
1. Read all approved specs from `.forge/specs/` (or filtered subset)
2. Auto-detect depth or use `--depth` flag:
   - quick: 3-5 large tasks per spec, no review steps
   - standard: 6-12 tasks per spec, review after critical tasks
   - thorough: 12-20 fine-grained tasks, TDD + review for every task
3. Dispatch forge-planner agent per spec
4. Build dependency DAG across all specs
5. Group tasks into parallelizable tiers
6. Tag each task with: repo, estimated tokens, dependencies, acceptance criteria
7. Write frontiers to `.forge/plans/{spec}-frontier.md`
8. Write token estimates to `.forge/token-ledger.json`
9. Initialize `.forge/state.md`

**Output:** Frontier files in `.forge/plans/`, initial state and token ledger

### 5.3 `/forge execute`

**Syntax:**
```
/forge execute
/forge execute --filter auth
/forge execute --autonomy full|gated|supervised
/forge execute --max-iterations 50
/forge execute --token-budget 500000
/forge execute --depth quick|standard|thorough
```

**Behavior:**
1. Read state, frontier, capabilities
2. Activate the Stop hook loop (`.forge/.forge-loop.json`)
3. For each iteration, the Stop hook reads state and routes to the correct action:

**Stop hook state machine:**

| Current State | Condition | Action |
|---------------|-----------|--------|
| Task not started | Next unblocked task exists | Feed implementation prompt with spec + acceptance criteria |
| Implemented | Tests not run | Feed "run tests" prompt |
| Tests failing | Fail count < 3 | Feed "fix these failures" prompt |
| Tests failing | Fail count >= 3 | Switch to DEBUG mode |
| DEBUG mode | Attempt < 3 | Feed systematic debugging prompt (4-phase) |
| DEBUG mode | Attempt >= 3 | Pause, ask human |
| Tests passing | Not reviewed (depth >= standard) | Feed review prompt |
| Review issues | Fix attempts < 3 | Feed "fix issues" prompt |
| Review issues | Fix attempts >= 3 | Accept with warnings, move on |
| Review clean | — | Commit, mark done, advance to next task |
| All tasks done | — | Run phase verification |
| Verification passed | Next spec/phase exists | Advance to next spec/phase |
| Verification passed | No more specs | Output completion promise |
| Verification gaps | — | Route back to execution with gap list |
| No progress (see 6.5) | 2 iterations | Pause, flag blocker |
| Context >= 60% | — | Save handoff snapshot, allow exit |
| Token budget >= 90% | — | Switch to quick mode |
| Token budget exhausted | — | Save state, graceful exit |

**Autonomy modes:**

| Mode | Pauses at | Use case |
|------|-----------|----------|
| full | Never (unless blocked/budget) | Greenfield, overnight runs |
| gated | Between specs/phases | Existing codebases, needs review |
| supervised | Between every task | Critical code, learning, first run |

**Output:** Committed code, updated frontier, execution summaries

### 5.4 `/forge resume`

**Syntax:**
```
/forge resume
```

**Behavior:**
1. Read `.forge/.forge-resume.md` (auto-generated resume prompt)
2. Load state, frontier, capabilities
3. Continue execution from exact point of interruption
4. Works after context resets, session closes, or manual pauses

For fully autonomous operation, a wrapper script can auto-restart:
```bash
#!/bin/bash
# forge-runner.sh — external loop for context resets
while true; do
  # .forge-resume.md contains natural-language instructions (not slash commands)
  # that tell Claude to read state files and continue from where it left off
  claude --print -p "$(cat .forge/.forge-resume.md)"

  # Check if forge is done (loop state file removed on completion)
  [ ! -f .forge/.forge-loop.json ] && echo "Forge complete!" && break

  # Check if human intervention needed (YAML frontmatter in state.md)
  grep -q 'status: blocked' .forge/state.md 2>/dev/null && \
    echo "Forge paused — needs human input. Run /forge resume when ready." && break

  echo "Context reset. Starting fresh session..."
done
```

**Note:** `--print` mode runs Claude headlessly. The resume prompt in `.forge/.forge-resume.md` is always natural-language instructions (e.g., "Read .forge/state.md and continue..."), never a slash command. Verify that Stop hooks fire correctly in `--print` mode during development.

### 5.5 `/forge backprop`

**Syntax:**
```
/forge backprop "description of bug"
/forge backprop --from-test path/to/failing-test
```

**Behavior:**
1. Analyze the bug description or failing test. For `--from-test`: Forge runs the specified test, captures stdout/stderr, and uses the failure output plus the test source code to identify which spec requirement's acceptance criteria should have caught this case.
2. Scan `.forge/specs/` to find matching requirements
3. Identify which acceptance criterion missed this case
4. Classify: one-off edge case vs. systemic pattern
5. Propose spec update (new criterion, modified criterion, or new requirement)
6. User approves or edits the proposed change
7. Generate regression test that would have caught this bug
8. Optionally re-run `/forge execute` on affected spec to verify fix emerges from spec alone
9. Log to `.forge/history/backprop-log.md`
10. After 3+ backprops of same pattern type: suggest systemic brainstorming prompt change

**Output:** Updated spec, regression test, backprop log entry

### 5.6 `/forge status`

**Syntax:**
```
/forge status
```

**Behavior:** Display current progress including:
- Current spec/phase and task
- Tasks completed / total
- Token usage (used / budget)
- Current depth and autonomy mode
- Active circuit breakers or blockers
- Discovered capabilities

### 5.7 `/forge help`

Displays usage guide for all commands, flags, and configuration options.

---

## 6. Smart Loop Architecture

### 6.1 Three-Layer Loop

```
OUTER LOOP (Stop Hook — phase/spec progression)
  brainstorm → plan → execute → verify → next spec → done

  MIDDLE LOOP (task progression within a spec)
    Read frontier → pick next unblocked → execute → mark done → repeat

    INNER LOOP (quality iteration within a task)
      implement → test → review → fix → re-test → re-review
      Until: tests pass AND review clean (or circuit breaker trips)
```

### 6.2 Stop Hook Implementation

The Stop hook (`hooks/stop-hook.sh`) is the core engine. It fires every time Claude finishes responding and tries to exit.

1. Reads `.forge/.forge-loop.json` for loop metadata (iteration, promise, session ID)
2. Reads `.forge/state.md` for current position
3. Reads `.forge/token-ledger.json` for budget
4. Calls `forge-tools.cjs` for routing decision
5. Returns JSON decision to Claude Code:
   - `{ "decision": "block", "reason": "<next prompt>" }` — continue loop. **Critical:** the `reason` field becomes Claude's next user prompt. This is the mechanism that drives the loop — the hook constructs a targeted prompt based on current state and feeds it to Claude as if the user had typed it.
   - Clean `exit 0` with no JSON output — allows Claude to stop (done, budget exhausted, or needs human input). This matches the Claude Code Stop hook convention (no explicit "approve" decision needed; absence of "block" means allow).

**Hook conflict note:** Forge's Stop hook checks for active Ralph Loop state (`.claude/ralph-loop.local.md`) on startup. If found, Forge warns the user and defers — only one loop-controlling plugin should be active at a time.

### 6.3 Context Window Management

**Mechanism:** The Claude Code hook API does not directly expose context window percentage to hooks. Instead, Forge uses the **transcript file** (available via `transcript_path` in hook input) as a proxy. The Stop hook reads the transcript JSONL file and estimates context usage based on cumulative message size (using a ~4 chars/token heuristic against the 200k token context window). This estimate is updated on every Stop hook invocation — a natural checkpoint at the end of each iteration.

**Flow when estimated context >= configured threshold (default 60%):**

1. Stop hook detects high context via transcript size estimate
2. Stop hook injects via `reason`: "Context approaching limit. Save comprehensive handoff to .forge/state.md including: current task, what's done, what's next, in-flight decisions. Then stop."
3. Claude writes handoff snapshot to state.md
4. On the next Stop hook invocation, hook detects `handoff_requested: true` in state.md
5. Stop hook generates `.forge/.forge-resume.md` (a natural-language resume prompt, NOT a slash command)
6. Stop hook exits cleanly (exit 0) — allows session to end
7. User runs `/forge resume` (or wrapper script auto-restarts)
8. Fresh session loads state from files, continues from exact task

**Accuracy tradeoff:** Transcript-based estimation is approximate (~10-15% margin of error). Setting the threshold at 60% provides a safety buffer — actual context will be between 50-70% when the reset triggers, well before the ~80% compaction danger zone.

### 6.4 Token Budget Management

**Mechanism:** Token budget tracking uses the same transcript-based estimation as context management. The Stop hook reads the transcript JSONL and calculates cumulative tokens across all iterations (stored in `.forge/token-ledger.json`). Each Stop hook invocation updates the ledger with the estimated tokens consumed in the latest iteration. The iteration count is also tracked as a secondary proxy — if transcript estimation fails, iteration count * average-tokens-per-iteration provides a fallback.

| Budget Usage | Action |
|--------------|--------|
| 0-70% | Run at configured depth |
| 70-90% | Auto-downgrade to quick (skip reviews) |
| 90-100% | Save state, graceful exit |

Single task consuming > 20% of total budget: force-complete, flag for human.

### 6.5 Circuit Breakers

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Same test fails repeatedly | 3x | Switch to DEBUG mode |
| DEBUG mode stuck | 3 attempts | Pause, ask human |
| Review loop cycling | 3 iterations | Accept with warnings |
| No progress detected | 2 iterations | Pause, flag blocker |
| Token budget exhausted | 100% | Graceful exit |
| Single task over budget | 20% of total | Force-complete |

**"No progress" definition:** Progress is defined as any of: (a) new git diff since last iteration (files created or modified in working tree), (b) task status advanced in `.forge/state.md` (e.g., `implementing` → `testing`), or (c) test results changed from previous run (different pass/fail count). The Stop hook tracks the previous iteration's git diff hash and task status. If none of these change across 2 consecutive iterations, the no-progress circuit breaker trips.

---

## 7. Capability Discovery

On startup of any `/forge` command, `forge-tools.cjs` scans the environment:

1. Read MCP config from `~/.claude.json`, `.claude.json`, `.mcp.json`
2. Read installed plugins from `~/.claude/plugins/installed_plugins.json` (best-effort — this is an internal Claude Code path that may change between versions; Forge gracefully handles missing/changed paths)
3. Write capability map to `.forge/capabilities.json`

**Fallback:** If plugin discovery fails, Forge still works — agents simply instruct Claude to "use MCP tool X if available" without pre-scanning. The capability map enhances routing but is not required.

The capability map is injected into agent prompts with routing rules:

| Capability | When Used |
|------------|-----------|
| Context7 MCP | Documentation lookup during implementation |
| Playwright MCP | E2E testing during verification |
| MongoDB MCP | Data inspection during debugging |
| TDD skill | Enforced during execution (if available) |
| Systematic debugging skill | Activated on DEBUG mode circuit breaker |
| Frontend design skill | Invoked for UI component tasks |
| Code review plugin | Powers the review inner loop |

Users can add custom routing hints in `.forge/config.json` under `capability_hints`.

---

## 8. Multi-Repo Support

### Configuration

Repos declared in `.forge/config.json` under the `repos` key. Each repo has:
- `path`: relative path from `.forge/` location
- `role`: primary or secondary
- `order`: execution priority (lower = first)
- `conventions`: how to find that repo's coding conventions

### Behavior

- **Planning:** Tasks tagged with `repo:` field. Primary repo tasks ordered before secondary.
- **Execution:** Executor `cd`s to correct repo, reads its CLAUDE.md, commits in that repo.
- **State:** `.forge/` lives in the working directory (not inside any repo).
- **Backprop:** Bug traced through cross-repo dependencies. Regression tests land in correct repo.

For single-repo projects, the `repos` key is omitted. Forge defaults to current directory.

---

## 9. Agent Specifications

### 9.1 forge-speccer
- **Role:** Write specs from brainstorm output
- **Input:** User's topic, Q&A answers, approach selection
- **Output:** `.forge/specs/spec-{domain}.md` with R-numbered requirements
- **Key behavior:** One question at a time, multiple choice preferred, propose 2-3 approaches

### 9.2 forge-planner
- **Role:** Decompose specs into task frontiers
- **Input:** Approved specs, depth setting, repo configuration
- **Output:** `.forge/plans/{spec}-frontier.md` with tiered tasks
- **Key behavior:** Build dependency DAG, estimate tokens, tag repos, group into tiers

### 9.3 forge-executor
- **Role:** Implement individual tasks
- **Input:** Task from frontier, spec requirements, capabilities
- **Output:** Committed code, updated task status
- **Key behavior:** TDD if available, atomic commits, follows repo conventions

### 9.4 forge-reviewer
- **Role:** Review code against spec and quality standards
- **Input:** Implemented code, spec requirements, review protocol
- **Output:** PASS or ISSUES with file:line references
- **Key behavior:** Reads actual code (not reports), checks spec compliance, flags over-engineering

### 9.5 forge-verifier
- **Role:** Goal-backward phase verification
- **Input:** Completed tasks, spec requirements, frontier
- **Output:** PASSED or GAPS_FOUND with gap descriptions
- **Key behavior:** Checks observable truths, detects stubs, verifies cross-component wiring

### 9.6 forge-complexity
- **Role:** Analyze task and recommend depth level
- **Input:** Task description, codebase context
- **Output:** Recommended depth (quick/standard/thorough) with reasoning
- **Key behavior:** Lightweight analysis, runs on every command startup

---

## 10. Platform Compatibility

| Platform | Status | Notes |
|----------|--------|-------|
| Windows (WSL) | Primary target | Use `#!/usr/bin/env bash`, forward slashes in JS |
| macOS | Supported | Native bash, no special handling |
| Linux | Supported | Native bash, no special handling |

### Key Constraints
- Shell scripts: `#!/usr/bin/env bash` for portability
- JS utility: CommonJS (`require`/`module.exports`), no TypeScript, no build step
- Path handling: forward slashes in JS, handle Windows paths in bash
- No native dependencies: pure JS + bash
- No npm install for end users: everything bundled in the plugin directory

---

## 11. Future Considerations (Out of Scope for v0.1)

- **Multi-model adversarial review:** Pluggable review interface for GPT/Gemini/local models
- **Plugin marketplace publishing:** Submit to Claude Code marketplace
- **Visual companion:** Browser-based mockups during brainstorming
- **Parallel subagent execution:** Multiple forge-executor agents working on same-tier tasks
- **Grafana integration:** Observability dashboard for long-running forge sessions
- **Firecrawl integration:** Web research for framework documentation during brainstorming
