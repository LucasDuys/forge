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
  <a href="https://github.com/LucasDuys/forge/releases"><img src="https://img.shields.io/badge/version-0.2.0-green" alt="Version"></a>
  <a href="https://github.com/LucasDuys/forge/tree/main/docs"><img src="https://img.shields.io/badge/tests-206%20passing-brightgreen" alt="Tests"></a>
  <a href="https://lucasduys.github.io/forge/"><img src="https://img.shields.io/badge/docs-architecture_video-orange" alt="Docs"></a>
</p>

<p align="center">
  <a href="https://lucasduys.github.io/forge/">Watch the architecture video</a>
  &nbsp;·&nbsp;
  <a href="docs/">Read the docs</a>
</p>

---

You start a feature in Claude Code. You write the prompt. It writes the code. You review it. You re-prompt. It tries again. It loses context. You re-explain. You watch the "context: 87%" warning crawl up. You restart. You re-explain again. You're three hours in, you have half a feature, and you're the one keeping the whole thing from falling apart.

You are the project manager. You are the state machine. You are the glue.

**Forge replaces you as the glue.** You describe what you want in one line. Forge writes the spec, plans the tasks, runs them in parallel git worktrees with TDD, reviews the code, verifies it against the acceptance criteria, and commits atomically. You read the diffs in the morning.

## Install

Two minutes. Requires Claude Code v1.0.33+. Zero npm install, zero build step, zero dependencies.

```bash
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

## Quickstart

Three commands. One autonomous loop. One squash-merge to main.

```bash
/forge brainstorm "add rate limiting to /api/search with per-user quotas"
/forge plan
/forge execute --autonomy full
```

Then walk away. Here is what you actually see while Forge runs.

```
$ /forge brainstorm "add rate limiting to /api/search with per-user quotas"

[forge-speccer] generating spec from idea...
spec written: .forge/specs/spec-rate-limiting.md
  R001  per-user quotas, configurable per tier (free / pro / enterprise)
  R002  sliding window counters (1 minute, 1 hour, 1 day)
  R003  429 response with Retry-After header
  R004  bypass for admin tokens
  R005  redis-backed counters with atomic increment
  R006  structured logs for rate-limit events
  R007  integration test against /api/search

$ /forge plan

[forge-planner] decomposing into task DAG...
8 tasks across 3 tiers (depth: standard)
  T001  add redis client + connection pool          [haiku, quick]
  T002  implement sliding window counter            [sonnet, standard]
  T003  build rate-limit middleware                 [sonnet, standard]
  T004  wire middleware to /api/search route        [haiku, quick]
  T005  add 429 response with Retry-After           [haiku, quick]
  T006  admin token bypass                          [haiku, quick]
  T007  structured logging                          [haiku, quick]
  T008  integration test                            [sonnet, standard]
        deps: T001 T002 T003 T004 T005 T006 T007

$ /forge execute --autonomy full

══ FORGE iteration 3/100 ══════════════════════════════════ phase: executing ══
  Task    T002  [in_progress]  @ tests_written → tests_passing
  Tasks   [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 1/8 (12%)
  Tokens  47k in / 12k out / 23k cached   budget 47k/500k (9%)
  Per-task 8k/15k tok (53%)
  Lock    alive pid 18432, 4s ago   restarts 0/10
──────────────────────────────────────────────────────────────────────

[14:02:48] T001 PASS   4 lines,  1 commit,  budget 1820/5000
[14:02:48] T002 T003 dispatched in parallel (disjoint files)
[14:06:01] T003 PASS   62 lines, 8 tests,   budget 13880/15000
[14:08:27] tier 2 complete,  squash-merged 6 worktrees
[14:14:18] forge-verifier: existence > substantive > wired > runtime
[14:14:18] verifier PASS   all 7 requirements satisfied
[14:14:18] <promise>FORGE_COMPLETE</promise>

8 tasks. 12 minutes. 218 lines. 9 commits squash-merged to main.
session budget: 47200 / 500000 used. lock released.
```

You read the diffs. You merge the branch. You move on.

The pipeline is strictly sequential, enforced programmatically: `brainstorm` → `plan` → `execute`. You cannot skip brainstorming, skip planning, or bypass the approval gate. The spec is the contract. Every acceptance criterion has an R-number; every task maps to at least one R-number; the verifier checks R-numbers, not checklists.

## Why Forge

Six outcomes, each traceable to a mechanism.

- **No silent token overruns at 3am.** Per-task and session budgets are hard ceilings, not warnings. At 100% the state machine transitions to `budget_exhausted`, writes a handoff at `.forge/resume.md`, and stops cleanly. Resume picks up where it died, no re-explaining. [budgets](docs/budgets.md)
- **Failed tasks never touch your main branch.** Every task runs in its own git worktree. Success squash-merges with a structured commit message. Failure discards the worktree; main stays green. [worktrees](docs/worktrees.md)
- **Crashes survive.** Lock file with heartbeat, per-step checkpoints, forensic resume from the git log. Machine reboots mid-feature, `/forge resume` reconstructs phase, current task, completed tasks, orphan worktrees, and continues. No lost work, no re-running passing tests. [recovery](docs/recovery.md)
- **Verification checks the spec, not the checklist.** Four levels: existence, substantive (not a stub), wired (imported where used), runtime (tests pass, webhooks handle, CI green). Catches "looks done but isn't" before it ships. [verification](docs/verification.md)
- **Headless-ready.** Proper exit codes, JSON state query in ~2ms, zero interactive prompts. Drop `/forge status --json` into Prometheus or a cron job. [headless](docs/headless.md)
- **Native Claude Code plugin.** Lives in your session. No separate harness, no TUI to learn, no API key to manage. Install in two minutes. [architecture](docs/architecture.md)

### Automatic backpropagation

One of Forge's more novel ideas. When the executor's tests fail, a PostToolUse hook catches it and trips a flag. The next iteration runs a five-step workflow before resuming the failing task:

1. **Trace.** Which spec and R-number does this failure map to?
2. **Analyze.** Is the gap a missing criterion, an incomplete one, or a whole missing requirement?
3. **Propose.** A spec update for your approval.
4. **Generate.** A regression test that would have caught it.
5. **Log.** Record in `.forge/backprop-log.md`; after three gaps in the same category, suggest systemic changes at the brainstorming layer.

The failure becomes a better spec, not just a fixed bug. Opt out with `auto_backprop: false` in `.forge/config.json` or `FORGE_AUTO_BACKPROP=0`. Manual invocation is `/forge backprop "description"`. Full detail in [backpropagation](docs/backpropagation.md).

### What Forge does vs what you do

| Action | Forge | You |
|---|:---:|:---:|
| Write the spec from a one-line idea | autonomous (via Q&A) | approve the approach |
| Decompose spec into task DAG | autonomous | review if you like |
| Write code + tests for each task | autonomous | |
| Review each task against the spec | autonomous (separate agent) | |
| Verify all R-numbers satisfied | autonomous | |
| Squash-merge passing tasks to main | autonomous | read the diffs before pushing |
| Propose spec updates when tests fail | autonomous (via backprop) | approve the proposed update |
| Install new dependencies, hit paid APIs, push to remote | never without you | authorize explicitly |

## How Forge saves tokens

Five mechanisms. Numbers are either measured from the repo's own benchmark suite or tagged as estimates.

**Hard per-task and session budgets** ([budgets.md](docs/budgets.md)). Task budgets scale with detected complexity:

```
quick     5 000 tokens
standard 15 000 tokens
thorough 40 000 tokens
session 500 000 tokens
```

At 80% the next prompt gets a warning injected. At 100% the phase flips to `budget_exhausted`, state halts, a resume doc is written. No silent drift over hours of autonomous work.

**Caveman compression** ([caveman.md](docs/caveman.md), [benchmark](docs/benchmarks/caveman-integration.md)). Three intensity modes compress internal agent artifacts (state notes, handoff bundles, checkpoint context, review reports). Never compresses source code, commits, specs, or PR descriptions.

| Mode | When | Measured reduction |
|---|---|---|
| lite | budget > 50% | ~1% on mixed artifacts (filler-word strip only) |
| full | 20-50% | **12% on the 10-scenario benchmark** |
| ultra | < 20% | 18% on the same benchmark, up to 65% on dense prose |

The 12% full-intensity figure is below the original 30% target and ships behind a `terse_internal: false` flag pending tuning. The 26.8% figure cited elsewhere comes from write-path benchmarks on pure-prose artifacts; the agent-output benchmark is the honest headline.

**Tool-call cache** ([hooks/tool-cache.js](hooks/tool-cache.js)). PreToolUse intercept with a 120s TTL on read-only operations (`git status/log/diff/branch`, `ls`, `find`, `Glob`, `Grep`, `Read`). On a hit it returns the cached result and skips the LLM round-trip entirely. Estimated savings: significant on iterative workflows that re-read the same files; not yet benchmarked end-to-end.

**Test-output filter** ([hooks/test-output-filter.js](hooks/test-output-filter.js)). For test runner output over 2000 characters (vitest / jest / pytest / cargo test / go test / npm test / mocha), the hook keeps only the failure blocks, eight lines of surrounding context, and the summary tail. Estimated compression: 50-80% on large test suites; measurement pending.

**Graphify integration** ([skills/graphify-integration/SKILL.md](skills/graphify-integration/SKILL.md)). Optional. When `graphify-out/graph.json` exists, the planner aligns task boundaries with community clusters, the researcher queries the graph before external docs, the reviewer runs a blast-radius check, the executor pulls only the relevant subgraph instead of scanning the whole codebase. Graceful degradation: no graph, no change. Token impact estimated, not yet measured.

## How it compares

Three tools solve overlapping problems. The right choice depends on what you value.

| | Forge | Ralph Loop | GSD-2 |
|---|---|---|---|
| **Core model** | Native Claude Code plugin, streaming DAG, state machine | Re-feed same prompt in a while loop | Standalone TypeScript harness on Pi SDK |
| **State** | Task DAG, lock file, per-task checkpoints, token ledger | One integer (`iteration`) + active flag | External state machine in TypeScript |
| **Decomposition** | Spec → R-numbers → task DAG, adaptive depth | None; Claude infers from files | Milestone → slice → task |
| **Cost controls** | Per-task + session token budgets, hard ceilings | None built in | Per-unit ledger with ceilings |
| **Git isolation** | Per-task worktrees with squash-merge | None | Worktree per slice |
| **Crash recovery** | Lock + forensic resume from checkpoints + git log | None | Lock files + session forensics |
| **Verification** | Goal-backward (existence > substantive > wired > runtime) | Whatever the prompt says | Auto-fix retries on test/lint |
| **Setup** | `claude plugin install` | Built into Claude Code | `npm install -g gsd-pi` |

- Pick **Forge** if you want autonomous execution inside your existing Claude Code session with hard cost controls, adaptive depth, and crash recovery.
- Pick **GSD-2** if you want a battle-tested standalone TUI harness with more engineering hours behind it.
- Pick **Ralph Loop** if you have a tightly-scoped greenfield task with binary verification and want the absolute minimum infrastructure.

Full honest comparison with all trade-offs: [docs/comparison.md](docs/comparison.md).

## How it works under the hood

Forge is a state machine that lives inside your Claude Code session. A spec becomes a tier-ordered task DAG; an autonomous loop dispatches parallel executors in git worktrees; each task is gated by review and verification; successful tasks squash-merge atomically. Seven hooks fire on every tool call to cap tokens, condense test output, cache repeat reads, track progress, and trigger auto-backprop when tests hit a spec gap. State files under `.forge/` are the single source of truth; the TUI and headless query both read them without writing.

### The big picture

End-to-end. Three commands, one autonomous loop, one merge.

```mermaid
flowchart LR
    User([You: one line idea]) --> Bs["/forge brainstorm"]
    Bs --> Spec[".forge/specs/spec-{domain}.md<br/>R001…R0NN + acceptance criteria"]
    Spec --> Plan["/forge plan"]
    Plan --> Frontier[".forge/plans/{spec}-frontier.md<br/>tier 1 ┃ tier 2 ┃ tier 3<br/>dependency DAG"]
    Frontier --> Exec["/forge execute"]
    Exec --> Loop{"autonomous<br/>loop"}
    Loop -->|all done| Done([squash-merge to main<br/>FORGE_COMPLETE])
    Loop -.->|read-only| Watch["/forge watch<br/>live TUI dashboard"]
    Loop -.->|read-only| Headless["/forge status --json<br/>headless query"]
    Crash[crash / context reset] -.->|/forge resume| Loop

    classDef cmd fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef state fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef ui fill:#e0f7fa,stroke:#006064,color:#004d40
    classDef done fill:#c8e6c9,stroke:#1b5e20,color:#0d2818

    class Bs,Plan,Exec,Loop cmd
    class Spec,Frontier state
    class Watch,Headless ui
    class Done,User done
    class Crash state
```

Four deeper diagrams cover the execute loop, hooks pipeline, backpropagation, and recovery layer. Click any to expand. The full one-piece view sits at the bottom.

<details>
<summary><strong>Execute loop (state machine + DAG dispatch)</strong></summary>

What `/forge execute` actually runs. State machine drives everything; the Stop hook re-fires it after every Claude turn.

```mermaid
flowchart TB
    Stop["Stop hook<br/>fires after every Claude turn"] --> SM{{"routeDecision()<br/>12 phases"}}
    SM --> Dispatch["streaming-DAG dispatch<br/>tiers sequential ┃ tasks parallel"]
    Dispatch --> Router["forge-router<br/>haiku=1 ┃ sonnet=5 ┃ opus=25"]
    Router --> Wts["per-task worktrees<br/>forge-executor"]
    Wts --> Reviewer["forge-reviewer"]
    Reviewer -->|issues| SM
    Reviewer -->|pass| Verifier["forge-verifier"]
    Verifier -->|gap| SM
    Verifier -->|R's met| Squash["squash-merge to main"]
    Squash -->|merge fail| Conflict["conflict_resolution<br/>preserve worktree"]
    Squash -->|ok| SM
    Conflict -.-> SM
    SM -->|next iteration| Stop
```

</details>

<details>
<summary><strong>Hooks pipeline (every tool call)</strong></summary>

Seven hooks fire on every executor tool call. They keep the loop fast, cheap, and self-correcting.

```mermaid
flowchart LR
    Tool["executor tool call"] --> Pre[PreToolUse]
    Pre --> Cache["tool-cache<br/>120s TTL on read-only ops"]
    Cache -.->|hit| Skip([cached, no LLM])
    Cache -.->|miss| Run[run real tool]
    Run --> Post["PostToolUse fan-out"]
    Post --> Tok["token-monitor<br/>80%/100% gates"]
    Post --> Filt["test-output-filter<br/>>2000 chars"]
    Post --> Prog[progress-tracker]
    Post --> AutoBP["auto-backprop<br/>FAIL pattern detect"]
    Post --> Store[tool-cache-store]
    Tok -->|>=100%| Exhaust([budget_exhausted])
    AutoBP -->|FAIL| Flag([flag file + state flag])
```

</details>

<details>
<summary><strong>Backpropagation and replanning loops</strong></summary>

Two feedback loops that change what runs next based on what just happened.

```mermaid
flowchart TB
    subgraph Auto["Auto-backprop: test failure → spec fix"]
        Fail[test failure] --> Hook[auto-backprop.js captures context]
        Hook --> Flag[.auto-backprop-pending.json]
        Flag --> Inject[stop-hook injects directive]
        Inject --> BP5["TRACE → ANALYZE → PROPOSE → GENERATE test → LOG"]
        BP5 --> SpecUpd[spec updated + regression test]
        SpecUpd --> Resume[resume original task]
    end
    subgraph Replan["Replanning: concerns → re-decompose"]
        Tier[tier completes] --> Check{"shouldReplan()<br/>concerns ÷ done ≥ 0.3?"}
        Check -->|yes| Redec["planner re-invoked<br/>T003 → T003.1, T003.2"]
        Redec --> Continue[continue with new frontier]
        Check -->|no| Continue
    end
    SpecUpd -.->|can trigger| Check
```

</details>

<details>
<summary><strong>Recovery layer</strong></summary>

Three independent layers cooperate so nothing is lost.

```mermaid
flowchart LR
    subgraph Live
        Acquire["acquireLock()<br/>or take over stale (5 min)"] --> HB[heartbeat every 30s]
        HB --> WriteCP[writeCheckpoint after each step]
    end
    Live --> Files[".forge-loop.lock + progress/T###.json + git log"]
    Files --> Resume{"/forge resume"}
    Resume --> Forensic[performForensicRecovery]
    Forensic --> Loop2[resume at exact step]
```

</details>

<details>
<summary><strong>Full one-piece architecture diagram</strong></summary>

All subsystems in one flow. The four focused diagrams above are easier to read individually; this is the holistic view. GitHub's "click to expand" button renders it at full size.

```mermaid
flowchart TB
    User([You: one line idea]) --> Bs["forge-speccer<br/>R-numbered spec"]
    Bs --> Planner["forge-planner<br/>tier DAG + token estimates"]
    Planner --> SM{"routeDecision()<br/>12-phase state machine"}
    SM --> Dispatch["streaming-DAG dispatch"]
    Dispatch --> Exec["forge-executor<br/>TDD + tests"]
    Exec --> Gates["reviewer + verifier<br/>existence > substantive > wired > runtime"]
    Gates --> Merge["squash-merge worktree"]
    Merge --> SM
    SM -->|tier done + concerns| Planner
    SM -->|all done| Done([FORGE_COMPLETE])

    Exec -.->|every tool call| Hooks["hooks: tool-cache, token-monitor,<br/>test-filter, progress, auto-backprop"]
    Hooks -.->|test failure| Planner
    SM -.->|writes| Recovery["lock + checkpoints + forensic resume"]
```

</details>

### Subsystem reference

Short version. Full table with every file pointer: [docs/architecture.md](docs/architecture.md).

| Layer | Key files | What it does |
|---|---|---|
| State machine | `scripts/forge-tools.cjs::routeDecision` | 12-phase router called by the Stop hook every Claude turn |
| DAG dispatch | `scripts/forge-tools.cjs::findAllUnblockedTasks` | Tiers sequential, tasks within a tier parallel |
| Model routing | `scripts/forge-router.cjs::selectModel` | Per-role baseline + complexity + budget → haiku / sonnet / opus |
| Budget tracking | `scripts/forge-budget.cjs` | Per-task + session spend with model cost weights, hard 100% gate |
| Agents | `agents/forge-*.md` | Speccer, planner, researcher, executor, reviewer, verifier, complexity |
| Hooks | `hooks/*.{js,sh}` | Seven hooks: tool cache, token monitor, test filter, progress, auto-backprop, cache store, stop |
| Recovery | `scripts/forge-tools.cjs` (lock + checkpoints + forensic) | Lock with heartbeat, 10-step checkpoints, rebuild from git log |
| TUI + headless | `scripts/forge-tui.cjs`, `scripts/forge-tools.cjs::queryHeadlessState` | Read-only; `/forge watch` renders at 10Hz, JSON snapshot in ~2ms |

## Receipts

- **206 tests, 0 dependencies.** Full suite runs in 2.6 seconds. Pure `node:assert`, zero npm install.
- **Headless state query: ~2ms.** Zero LLM calls, 17-field versioned JSON schema.
- **Caveman compression: 12% measured** on the 10-scenario agent-output benchmark at full intensity, rising to 18% at ultra and up to 65% on dense prose. [benchmark](docs/benchmarks/caveman-integration.md)
- **Seven hooks fire on every tool call.** Tool cache, token monitor, test filter, progress tracker, auto-backprop, cache store, stop. See [architecture](docs/architecture.md).
- **Seven circuit breakers.** Test failures, debug exhaustion, Codex rescue, re-decomposition, review iterations, no-progress detection, max iterations. Nothing runs forever. [verification](docs/verification.md)
- **Lock heartbeat survives** crashes, reboots, OOMs, and context resets. Five-minute stale threshold, never auto-deletes user work.
- **Seven specialized agents**, each routed to the cheapest model that can handle the job. [agents](docs/agents.md)

Three cross-cutting skills shipped in v0.2.0 also influence every agent: **Karpathy Guardrails** (four behavioral principles, flagged by the reviewer), **Graphify Integration** (optional knowledge-graph context), and **DESIGN.md Support** (design-system compliance pass). Details in [docs/superpowers/](docs/superpowers/).

## Documentation

- [Architecture](docs/architecture.md): three-tiered loop, self-prompting engine, execution flow
- [Commands](docs/commands.md): every slash command and flag
- [Configuration](docs/configuration.md): `.forge/config.json` reference
- [Token budgets](docs/budgets.md): per-task and session ceilings
- [Caveman optimization](docs/caveman.md): internal token compression modes
- [Worktree isolation](docs/worktrees.md): how each task gets its own branch
- [Crash recovery](docs/recovery.md): forensic resume from checkpoints
- [Verification and circuit breakers](docs/verification.md): goal-backward verification and the seven safety nets
- [Backpropagation](docs/backpropagation.md): test failures to spec gaps
- [Headless mode](docs/headless.md): CI and cron usage, JSON schema
- [Specialized agents](docs/agents.md): the seven roles and model routing
- [Live dashboard](docs/dashboard.md): `/forge watch` interactive TUI
- [Testing](docs/testing.md): running the test suite
- [Comparison](docs/comparison.md): Forge vs Ralph Loop vs GSD-2

## Credits

- **Caveman skill** adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT)
- **Ralph Loop pattern** by [Geoffrey Huntley](https://ghuntley.com/ralph/); Forge's self-prompting loop is a smarter-state-machine variant
- **Spec-driven development** concepts from GSD v1 by TÂCHES
- **Karpathy guardrails** from [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
- **Claude Code plugin system** by Anthropic; Forge is a native extension, not a wrapper

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `node scripts/run-tests.cjs`
5. Open a pull request

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
