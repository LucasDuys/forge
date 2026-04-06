# Forge vs The Alternatives

Honest positioning. All three tools solve overlapping problems; the right choice depends on what you value.

| Dimension | Forge | Ralph Loop | GSD-2 |
|---|---|---|---|
| **Core metaphor** | Native Claude Code plugin with streaming DAG + state machine | Re-feed same prompt in a while loop | Standalone TypeScript agent harness on Pi SDK |
| **State model** | Task DAG, lock file, per-task checkpoints, token ledger | One integer (`iteration`) + active flag | Full state machine in external TypeScript |
| **Task decomposition** | Milestone > Spec > R-number > Task DAG, adaptive depth | None. Claude figures it out from files | Milestone > Slice > Task hierarchy |
| **Context isolation** | Handoff + resume in new Claude Code session at 60% | Same session, context accumulates | Fresh 200k window per task via Pi SDK |
| **Stop condition** | DAG complete + verifier pass, or budget ceiling | `--max-iterations` OR exact `<promise>` match. Default infinite. | Budget ceiling + verification + Escape key |
| **Cost controls** | Per-task + session token budgets, hard ceilings | None built-in | Per-unit token ledger with budget ceilings |
| **Git isolation** | Per-task worktrees with squash-merge | None | Worktree isolation per slice |
| **Crash recovery** | Lock file + forensic resume from checkpoints + git log | None | Lock files + session forensics |
| **Verification** | Goal-backward verifier (existence > substantive > wired > runtime) | Whatever you put in the prompt | Auto-fix retries on test/lint failures |
| **Setup** | `claude plugin install` | Built into Claude Code | `npm install -g gsd-pi` |
| **Lives in** | Your existing Claude Code session | Your existing Claude Code session | Separate TUI harness |
| **Author** | Lucas Duys | Anthropic (technique by Geoffrey Huntley) | TÂCHES |

**When Forge wins:** you already love Claude Code and want autonomous execution without leaving it. Native plugin architecture, zero install friction, adaptive depth scoring, multi-repo coordination, backpropagation, readable source (markdown + bash + CJS).

**When GSD-2 wins:** you want a battle-tested harness with more engineering hours behind it, hard per-task budget ceilings from day one, and you're willing to switch to a separate TUI.

**When Ralph Loop wins:** you have a tightly-scoped greenfield task with binary verification (tests pass or fail), you don't care about cost, and you want the absolute minimum infrastructure.
