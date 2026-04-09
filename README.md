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
  <a href="https://github.com/LucasDuys/forge/releases"><img src="https://img.shields.io/badge/version-2.1-green" alt="Version"></a>
  <a href="https://github.com/LucasDuys/forge/tree/main/docs"><img src="https://img.shields.io/badge/tests-100%20passing-brightgreen" alt="Tests"></a>
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

Requires Claude Code v1.0.33+. Zero npm install, zero build step, zero dependencies.

```bash
claude plugin marketplace add LucasDuys/forge
claude plugin install forge@forge-marketplace
```

## Three commands to ship a feature

```bash
/forge brainstorm "add rate limiting to /api/search with per-user quotas"
/forge plan
/forge execute --autonomy full
```

Then walk away.

## What you actually see

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

[14:02:11Z] lock acquired (pid 18432)
[14:02:11Z] T001 worktree created -> .forge/worktrees/T001/
[14:02:11Z] T001 executing  haiku  budget 5000
[14:02:48Z] T001 PASS       4 lines  1 commit  budget 1820/5000
[14:02:48Z] T002 executing  sonnet  budget 15000
[14:02:48Z] T003 executing  sonnet  budget 15000   (parallel, no file conflict)
[14:04:33Z] T002 PASS       37 lines  5 tests  budget 11240/15000
[14:06:01Z] T003 PASS       62 lines  8 tests  budget 13880/15000
[14:06:01Z] T004 T005 T006 T007 dispatched in parallel
[14:08:27Z] tier 2 complete  squash-merged 6 worktrees
[14:08:27Z] T008 executing  sonnet  budget 15000
[14:14:12Z] T008 PASS       44 lines  12 tests  budget 12300/15000
[14:14:12Z] forge-verifier: existence > substantive > wired > runtime
[14:14:18Z] verifier PASS  all 7 requirements satisfied
[14:14:18Z] <promise>FORGE_COMPLETE</promise>

8 tasks. 12 minutes. 218 lines. 9 commits squash-merged to main.
session budget: 47200 / 500000 used. lock released.
```

You read the diffs. You merge the branch. You move on.

## Why it works

- **Native Claude Code plugin.** Lives in your existing session. No separate harness, no TUI to learn, no API key to manage. ([architecture](docs/architecture.md))
- **Hard token budgets.** Per-task and per-session ceilings, enforced as hard stops, not warnings. No more silent overruns at 3am. ([budgets](docs/budgets.md))
- **Git worktree isolation.** Every task runs in its own worktree. Failed tasks get discarded. Successful ones squash-merge with atomic commit messages. Your main branch only ever sees green code. ([worktrees](docs/worktrees.md))
- **Crash recovery that actually works.** Lock file with heartbeat, per-step checkpoints, forensic resume from git log. If your machine reboots mid-feature, `/forge resume` picks up exactly where it died. ([recovery](docs/recovery.md))
- **Headless mode for CI and cron.** Proper exit codes, JSON state queries in under 5ms, zero interactive prompts. ([headless](docs/headless.md))
- **Goal-backward verification.** The verifier checks the spec, not the tasks. Existence > substantive > wired > runtime. Catches stubs, dead code, and "looks done but isn't" before they ship. ([verification](docs/verification.md))
- **Backpropagation, automatic.** When the executor's PostToolUse hook detects a test failure, `/forge backprop` runs automatically on the next iteration — tracing the failure to a spec gap, proposing a spec update, and generating a regression test before the failure ever reaches you. Opt out with `auto_backprop: false` in `.forge/config.json` or set `FORGE_AUTO_BACKPROP=0`. ([backprop](docs/backpropagation.md))
- **Self-updating.** `/forge update` pulls the latest Forge from upstream — git checkouts are fast-forwarded with dirty-tree protection, marketplace installs get manual instructions. Cross-platform git binary resolution so it works on Windows out of the box.
- **Live dashboard, optional.** `/forge watch` runs the same loop with an interactive TUI showing the active agent, current tool, frontier progress, token meters, and a scrolling event log. Zero npm install — pure Node built-ins and ANSI. Falls back to the plain runner automatically if your terminal can't render it. ([dashboard](docs/dashboard.md))

## Receipts

- **100 tests, 0 dependencies.** Full suite runs in 2.4 seconds. Pure `node:assert`.
- **Headless state query: under 5ms.** Zero LLM calls. Drop it in a Prometheus exporter.
- **Caveman compression: 26.8% reduction** on internal artifacts. ([benchmark](docs/benchmarks/caveman-integration.md))
- **Lock heartbeat survives** crashes, reboots, OOMs, and context resets. Five minute stale threshold, never auto-deletes user work.
- **Worktree isolation:** failed tasks never touch your main branch. Successful ones land as one squashed commit with a structured message.
- **Seven specialized agents.** Speccer, planner, researcher, executor, reviewer, verifier, complexity scorer. Each routed to the cheapest model that can handle the job. ([agents](docs/agents.md))
- **Seven circuit breakers.** Test failures, debug exhaustion, review iterations, no-progress detection, token ceilings. Nothing runs forever. ([circuit breakers](docs/verification.md))

## How it compares

Forge is one of three tools in this space alongside [Ralph Loop](https://ghuntley.com/ralph/) and [GSD-2](https://github.com/taches-org/gsd). They overlap but optimize for different things:

- Pick **Forge** if you want autonomous execution that lives inside your existing Claude Code session, with hard cost controls, adaptive depth, and crash recovery.
- Pick **GSD-2** if you want a more battle-tested standalone TUI harness with more engineering hours behind it.
- Pick **Ralph Loop** if you have a tightly-scoped greenfield task with binary verification and want the absolute minimum infrastructure.

Full honest comparison with all the trade-offs: [docs/comparison.md](docs/comparison.md).

## Documentation

- [Architecture](docs/architecture.md) — three-tiered loop, self-prompting engine, execution flow
- [Commands](docs/commands.md) — every slash command and flag
- [Configuration](docs/configuration.md) — `.forge/config.json` reference
- [Token budgets](docs/budgets.md) — per-task and session ceilings
- [Worktree isolation](docs/worktrees.md) — how each task gets its own branch
- [Crash recovery](docs/recovery.md) — forensic resume from checkpoints
- [Headless mode](docs/headless.md) — CI/cron usage and JSON schema
- [Specialized agents](docs/agents.md) — the seven roles and their model routing
- [Verification & circuit breakers](docs/verification.md) — goal-backward verification, the seven safety nets
- [Backpropagation](docs/backpropagation.md) — bugs to spec gaps
- [Caveman optimization](docs/caveman.md) — internal token compression
- [Live dashboard](docs/dashboard.md) — `/forge watch` interactive TUI
- [Testing](docs/testing.md) — running the 100-test suite
- [Comparison](docs/comparison.md) — Forge vs Ralph Loop vs GSD-2

## Credits

- **Caveman skill** adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT)
- **Ralph Loop pattern** by [Geoffrey Huntley](https://ghuntley.com/ralph/) — Forge's self-prompting loop is a smarter-state-machine variant
- **Spec-driven development** concepts from GSD v1 by TÂCHES
- **Claude Code plugin system** by Anthropic — Forge is a native extension, not a wrapper

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `node scripts/run-tests.cjs`
5. Open a pull request

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
