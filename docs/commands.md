# Commands

| Command | Description | Key Flags |
|---|---|---|
| `/forge brainstorm [topic]` | Interactive spec generation | `--from-code`, `--from-docs path/` |
| `/forge plan` | Decompose specs into streaming DAG | `--filter tag`, `--depth quick\|standard\|thorough` |
| `/forge execute` | Autonomous implementation loop | `--autonomy full\|gated\|supervised`, `--max-iterations N` |
| `/forge resume` | Continue after context reset or crash | Runs forensic recovery first |
| `/forge backprop [desc]` | Trace bug to spec gap | `--from-test path/` |
| `/forge status` | Unified dashboard: phase, budget, locks, checkpoints | `--json` |
| `/forge review-branch` | Review unmerged branch | `--base main`, `--fix`, `--comment` |
| `/forge setup-tools` | Detect and install CLI tools | |

## Autonomy Levels

| Level | Behavior | Best For |
|---|---|---|
| `full` | Runs unattended, handles context resets and budget exhaustion | Long-running features, overnight |
| `gated` | Pauses between phases for approval | Recommended default |
| `supervised` | Pauses between individual tasks | Maximum oversight |

## Headless Subcommands

```bash
node scripts/forge-tools.cjs headless execute --spec <domain>   # CI/cron execution
node scripts/forge-tools.cjs headless query                     # JSON state snapshot
node scripts/forge-tools.cjs headless status                    # alias for query
node scripts/forge-tools.cjs headless query --watch             # live monitoring
```

See [headless.md](headless.md) for full headless mode documentation.
