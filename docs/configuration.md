# Configuration

`.forge/config.json` (auto-created on first brainstorm):

```json
{
  "autonomy": "gated",
  "depth": "standard",
  "auto_detect_depth": true,
  "max_iterations": 100,
  "token_budget": 500000,
  "session_budget_tokens": 500000,
  "per_task_budget": {
    "quick":    5000,
    "standard": 15000,
    "thorough": 40000
  },
  "terse_internal": false,
  "use_worktrees": true,
  "headless_notify_url": null
}
```

See [config-schema.md](../references/config-schema.md) for the full field reference including model routing, token hooks, adaptive replanning, Codex hybrid, and circuit breaker thresholds.

## Project Structure

```
forge/
  commands/           Slash commands (brainstorm, plan, execute, resume, backprop, status)
  skills/             Procedural workflows (brainstorming, planning, executing, reviewing)
    caveman-internal/   Token optimization skill (adapted from JuliusBrussee/caveman)
  agents/             Specialized subagents with model routing + artifact contracts
  hooks/              Self-prompting engine (stop hook state machine + token hooks)
  scripts/            Core utilities (state machine, routing, budgeting, locks, worktrees)
    run-tests.cjs       Zero-dep test runner
    bench-caveman-*.cjs Caveman benchmarks
    bench-worktree-*.cjs Worktree overhead benchmarks
  tests/              9 test suites, 100 assertions
  templates/          Output + config templates (state.md, resume.md in caveman form)
  references/         Reference docs
    config-schema.md
    state-machine.md
    forge-directories.md
    checkpoint-schema.md
    headless-status-schema.md
    budget-thresholds.md
  docs/
    testing.md          How to run the test suite
    benchmarks/         Caveman + worktree overhead measurements
```

## Platform Support

Works on macOS, Linux, and Windows (WSL and Git Bash). Pure JavaScript (CommonJS) + Bash. No native dependencies, no build step.

Cross-platform quirks:
- Windows Git Bash has higher process startup overhead (~80ms bash + ~100ms node). Hook performance floors are documented in `hooks/token-monitor.sh`.
- File locking is advisory on all platforms (presence of lock file + heartbeat freshness, not `flock`).
- Atomic writes use temp-file-rename pattern with EBUSY retry on Windows.
