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

Claude Code is powerful, but for non-trivial features you become the glue: prompting, reviewing, re-prompting, losing context, starting over. A 12-task feature takes dozens of manual exchanges and multiple sessions.

You are the project manager. You are the state machine. You are the thing keeping everything from falling apart.

**Forge replaces you as the glue.** You describe what you want. Forge writes the spec, plans the tasks, runs them with TDD, reviews the code, verifies against acceptance criteria, and commits atomically. You read the diffs.

## Install

Requires Claude Code v1.0.33+. Zero npm install, zero build step.

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

That's it. Forge runs unattended until the feature is implemented, tested, reviewed, and committed.

## Why Forge

- **Native Claude Code plugin** — lives in your existing session, no separate harness or TUI to learn
- **Hard token budgets** per task and per session — no silent overruns at 3am ([docs](docs/budgets.md))
- **Git worktree isolation** per task — failed tasks discarded cleanly, successful ones squash-merged ([docs](docs/worktrees.md))
- **Crash recovery** from lock file + checkpoints + git log — `/forge resume` picks up where you crashed ([docs](docs/recovery.md))
- **Headless mode** for CI/cron with proper exit codes and <5ms JSON state queries ([docs](docs/headless.md))
- **Backpropagation** — when a bug surfaces, trace it back to the spec gap that allowed it ([docs](docs/backpropagation.md))
- **Goal-backward verification** — the verifier checks the spec, not the tasks ([docs](docs/verification.md))

## How it compares

Forge is one of three tools in this space alongside [Ralph Loop](https://ghuntley.com/ralph/) and [GSD-2](https://github.com/taches-org/gsd). They overlap but optimize for different things:

- Pick **Forge** if you want autonomous execution that lives inside your Claude Code session, with hard cost controls and adaptive depth
- Pick **GSD-2** if you want a more battle-tested standalone TUI harness
- Pick **Ralph Loop** if you have a tightly-scoped task and want the minimum infrastructure possible

Full honest comparison: [docs/comparison.md](docs/comparison.md).

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
