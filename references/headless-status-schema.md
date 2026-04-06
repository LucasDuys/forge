# Headless Status JSON Schema

Spec coverage: R010 (Headless Status Query). Implemented in
`scripts/forge-tools.cjs::queryHeadlessState`.

## Purpose

`forge headless query --json` (alias `forge headless status --json`) emits a
machine-readable snapshot of Forge's current state without invoking any LLM
call, git operation, or network request. It is intended for monitoring tools
(Prometheus exporters, dashboards, CI checks) that need fast, parseable
visibility into a long-running Forge loop.

## Performance Contract

- The query MUST complete in under 100ms on a typical `.forge/` directory.
- The CLI measures elapsed wall time and prints `query_elapsed_ms` in human
  output, and writes a `SLOW` warning to stderr when the budget is exceeded.
- Implementation reads only the local filesystem. No subprocess, no network,
  no git, no LLM.

## Schema Versioning

The output includes a top-level `schema_version` field. The current version
is **1.0**.

Versioning rules:

- Bump the **major** component (1.0 -> 2.0) for backward-incompatible
  changes: removed fields, renamed fields, changed value types, or changed
  enum value semantics.
- Bump the **minor** component (1.0 -> 1.1) for additive changes: new
  optional fields appended to the object.
- Consumers SHOULD treat unknown fields as forward-compatible and ignore
  them. Consumers MUST check `schema_version` before relying on enum values.

## Field Reference

| Field | Type | Nullable | Units / Values | Description |
|-------|------|----------|----------------|-------------|
| `schema_version` | string | no | semver-like (`"1.0"`) | Schema version of this payload. |
| `queried_at` | string | no | ISO 8601 UTC | Wall-clock time the snapshot was produced. |
| `phase` | string | no | enum: `unknown`, `brainstorming`, `planning`, `executing`, `reviewing`, `backpropagation`, `budget_exhausted`, `lock_conflict`, `conflict_resolution`, `recovering`, `complete` | Current Forge loop phase from `state.md`. |
| `spec_domain` | string \| null | yes | spec slug, e.g. `"gsd2-caveman-integration"` | Active spec domain from `state.md`'s `spec` field. |
| `tier` | string \| number \| null | yes | tier number (`2`) or label (`"infrastructure"`) | Current frontier tier being executed. |
| `autonomy` | string \| null | yes | enum: `interactive`, `supervised`, `full` | Autonomy mode for the loop. |
| `depth` | string \| null | yes | enum: `quick`, `standard`, `thorough` | Quality ceremony depth. |
| `current_task` | string \| null | yes | task id, e.g. `"T022"` | Task currently in flight (if any). |
| `completed_tasks` | integer | no | count, >= 0 | Number of tasks marked complete in the registry or frontier. |
| `remaining_tasks` | integer | no | count, >= 0 | Number of tasks still pending. |
| `token_budget_used` | integer | no | tokens, >= 0 | Cumulative tokens consumed across the run. |
| `token_budget_remaining` | integer | no | tokens, >= 0 | `tokens_budget - token_budget_used`, floored at 0. |
| `tool_count` | integer | no | count, >= 0 | Best-effort proxy for total tool invocations this session (from `ledger.iterations`). |
| `last_error` | string \| null | yes | free-form message | Most recent error from `state.md` or checkpoint error log. |
| `lock_status` | string | no | enum: `free`, `held`, `stale` | Status of `.forge/.forge-loop.lock`. |
| `last_heartbeat` | string \| null | yes | ISO 8601 UTC | Most recent lock heartbeat (null when no lock). |
| `active_checkpoints` | integer | no | count, >= 0 | Number of in-progress task checkpoints on disk. |

### Type guarantees

- All timestamps are ISO 8601 in UTC with the `Z` suffix.
- All counts are JSON integers, never strings, never floats.
- All booleans (none currently in 1.0) would be JSON `true`/`false`, never
  `0`/`1`.
- Missing fields are emitted as JSON `null`, never `undefined`. Field order
  in the payload is stable across invocations.

## Example Output

```json
{
  "schema_version": "1.0",
  "queried_at": "2026-04-05T12:34:56.789Z",
  "phase": "executing",
  "spec_domain": "gsd2-caveman-integration",
  "tier": "5",
  "autonomy": "full",
  "depth": "standard",
  "current_task": "T022",
  "completed_tasks": 18,
  "remaining_tasks": 12,
  "token_budget_used": 142318,
  "token_budget_remaining": 357682,
  "tool_count": 412,
  "last_error": null,
  "lock_status": "held",
  "last_heartbeat": "2026-04-05T12:34:55.001Z",
  "active_checkpoints": 1
}
```

## CLI Usage

```bash
# One-shot human-readable output (with timing line)
node scripts/forge-tools.cjs headless query

# One-shot JSON for monitoring tools
node scripts/forge-tools.cjs headless query --json

# Live dashboard, refreshes every 5 seconds, ctrl-c to exit
node scripts/forge-tools.cjs headless query --watch

# Live JSON tail (useful piped into jq -c)
node scripts/forge-tools.cjs headless query --json --watch

# Custom forge directory
node scripts/forge-tools.cjs headless query --json --forge-dir path/to/.forge
```

`status` is an alias for `query`.

## Sample Prometheus-Style Exporter

A minimal shell exporter that scrapes the JSON every 15 seconds and writes
metrics in Prometheus text-exposition format. Drop it behind a static file
server or `node_exporter`'s `textfile` collector.

```bash
#!/usr/bin/env bash
# forge-exporter.sh -- emit Prometheus metrics from forge headless query
set -euo pipefail

FORGE_DIR="${FORGE_DIR:-.forge}"
OUT="${OUT:-/var/lib/node_exporter/forge.prom}"

while true; do
  snap="$(node scripts/forge-tools.cjs headless query --json --forge-dir "$FORGE_DIR")"
  used=$(echo   "$snap" | jq '.token_budget_used')
  remain=$(echo "$snap" | jq '.token_budget_remaining')
  done_=$(echo  "$snap" | jq '.completed_tasks')
  todo=$(echo   "$snap" | jq '.remaining_tasks')
  tools=$(echo  "$snap" | jq '.tool_count')
  phase=$(echo  "$snap" | jq -r '.phase')
  cat > "$OUT.tmp" <<EOF
# HELP forge_tokens_used Cumulative tokens consumed by the forge loop.
# TYPE forge_tokens_used counter
forge_tokens_used $used
forge_tokens_remaining $remain
forge_tasks_completed $done_
forge_tasks_remaining $todo
forge_tool_invocations $tools
forge_phase{phase="$phase"} 1
EOF
  mv "$OUT.tmp" "$OUT"
  sleep 15
done
```

## Backward Compatibility

Schema 1.0 is a strict superset of the original T011 `queryHeadlessState`
return shape. The original nine fields (`phase`, `current_task`,
`completed_tasks`, `remaining_tasks`, `token_budget_used`,
`token_budget_remaining`, `last_error`, `lock_status`, `active_checkpoints`)
are preserved with identical semantics. Existing T011 callers continue to
work without modification.
