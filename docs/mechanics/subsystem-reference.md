# Subsystem Reference

One-table view of where each Forge subsystem lives in the repo. This table used to sit inline in the README; moved here so the top-of-README stays focused on "how the phase loop works."

Full architecture writeup with file-by-file pointers: [docs/architecture.md](../architecture.md).

| Layer | Key files | What it does |
|---|---|---|
| State machine | `scripts/forge-tools.cjs::routeDecision` | 12-phase router called by the Stop hook every Claude turn |
| DAG dispatch | `scripts/forge-tools.cjs::findAllUnblockedTasks` | Tiers sequential, tasks within a tier parallel |
| Model routing | `scripts/forge-router.cjs::selectModel` | Per-role baseline + complexity + budget to haiku / sonnet / opus |
| Budget tracking | `scripts/forge-budget.cjs` | Per-task + session spend with model cost weights, hard 100% gate |
| Agents | `agents/forge-*.md` | Speccer, planner, researcher, executor, reviewer, verifier, complexity |
| Hooks | `hooks/*.{js,sh}` | Seven hooks: tool cache, token monitor, test filter, progress, auto-backprop, cache store, stop |
| Recovery | `scripts/forge-tools.cjs` (lock + checkpoints + forensic) | Lock with heartbeat, 10-step checkpoints, rebuild from git log |
| TUI + headless | `scripts/forge-tui.cjs`, `scripts/forge-tools.cjs::queryHeadlessState` | Read-only; `/forge watch` renders at 10Hz, JSON snapshot in ~2ms |

## See also

- [docs/architecture.md](../architecture.md): end-to-end walkthrough with diagrams
- [docs/agents.md](../agents.md): full list of seven specialized agents and which model each routes to
- [docs/commands.md](../commands.md): every slash command and flag
- [docs/verification.md](../verification.md): goal-backward verifier and the seven circuit breakers
