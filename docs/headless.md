# Headless Mode

For CI, cron jobs, and automated pipelines. Zero interactive prompts.

```bash
$ node scripts/forge-tools.cjs headless execute --forge-dir .forge --spec auth-v2

[14:30:01Z] lock acquired
[14:30:02Z] spec loaded -> 29 tasks
[14:30:03Z] executing T001
...
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks complete and verified |
| 1 | Failed with unrecoverable error |
| 2 | Budget exhausted (recoverable) |
| 3 | Blocked, needs human decision |
| 4 | Lock conflict with another session |

## State queries

Machine-readable state queries in under 5ms:

```bash
$ node scripts/forge-tools.cjs headless query --forge-dir .forge --json

{
  "schema_version": "1.0",
  "queried_at": "2026-04-06T14:30:15Z",
  "phase": "executing",
  "current_task": "T008",
  "spec_domain": "auth-v2",
  "tier": 3,
  "completed_tasks": 7,
  "remaining_tasks": 22,
  "token_budget_used": 156400,
  "token_budget_remaining": 343600,
  "last_heartbeat": "2026-04-06T14:30:12Z",
  "lock_status": "held",
  "active_checkpoints": 1,
  "autonomy": "full",
  "depth": "standard",
  "tool_count": 247,
  "last_error": null
}
```

Watch mode for monitoring during long runs:

```bash
node scripts/forge-tools.cjs headless query --watch
```

## Subcommands

```bash
node scripts/forge-tools.cjs headless execute --spec <domain>   # CI/cron execution
node scripts/forge-tools.cjs headless query                     # JSON state snapshot
node scripts/forge-tools.cjs headless status                    # alias for query
node scripts/forge-tools.cjs headless query --watch             # live monitoring
```

Schema is versioned. Fields are additive across versions. See [headless-status-schema.md](../references/headless-status-schema.md) for the full field reference and a sample Prometheus exporter.
