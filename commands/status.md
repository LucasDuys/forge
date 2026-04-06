---
description: "Show Forge progress and status"
allowed-tools: ["Read(*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)"]
---

# Forge Status

Present a unified Forge dashboard. If the user passed `--json` anywhere in the
command arguments, emit machine-readable JSON instead of the formatted view.

## Data sources

Run these commands and combine their output. Always pass `--forge-dir .forge`.

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs headless query --forge-dir .forge --json`
   - Authoritative snapshot from T011: phase, current_task, completed/remaining
     task counts, lock_status, active_checkpoints, last_error, token totals.
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs budget-status --forge-dir .forge --json`
   - Per-task token ledger plus session budget summary and iteration count.
3. Read `.forge/state.md` directly for fields the headless query does not
   surface (autonomy, depth, blocked_reason, last heartbeat timestamp).
4. Read `.forge/capabilities.json` if it exists to count MCP servers and skills.
5. Check whether `.forge/.forge-loop.json` exists -- if so, the autonomous loop
   is currently active.
6. Check whether `.forge/.forge-debug.log` exists and is non-empty.
7. List `.forge/checkpoints/*.json` (if the directory exists) to surface any
   in-progress task checkpoints.

## JSON mode

If the user passed `--json`, output a single JSON object with these top-level
keys merged from the sources above. Do not pretty-format with extra commentary.

```
{
  "phase": "...",
  "spec": "...",
  "current_task": "...",
  "task_status": "...",
  "iteration": N,
  "max_iterations": N,
  "tasks": { "completed": N, "remaining": N, "total": N },
  "tokens": { "used": N, "budget": N, "percent": N, "remaining": N },
  "per_task_budgets": [ ... from budget-status ... ],
  "lock_status": "free|held|stale",
  "active_checkpoints": N,
  "last_error": "...",
  "depth": "...",
  "autonomy": "...",
  "loop_active": true|false,
  "debug_log_has_entries": true|false,
  "blocked_reason": "..." | null,
  "capabilities": { "mcp_servers": N, "skills": N }
}
```

## Formatted mode (default)

Render this layout:

```
Forge Status
===================================
Phase:     {phase}
Spec:      {spec}
Task:      {current_task} ({task_status})
Iteration: {iteration} / {max_iterations}

Tasks:     {completed}/{total} complete, {remaining} remaining
Tokens:    {used} / {budget} ({percent}%, {remaining} remaining)
Depth:     {depth}
Autonomy:  {autonomy}

Lock:         {lock_status}
Checkpoints:  {active_checkpoints}
Capabilities: {mcp_count} MCP servers, {skill_count} skills
```

After the dashboard, append any of these conditional lines that apply:

- If `.forge/.forge-loop.json` exists: `Loop active`
- If `.forge/.forge-debug.log` is non-empty:
  `Debug log has entries -- run cat .forge/.forge-debug.log to inspect`
- If `blocked_reason` is set in state.md: `Blocked: {blocked_reason}`
- If `last_error` from headless query is non-null: `Last error: {last_error}`
- If `active_checkpoints > 0`: list each checkpoint id and step from
  `.forge/checkpoints/*.json` so the user can see in-progress task state.

Then append the per-task budget table from
`node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs budget-status --forge-dir .forge`
(plain text mode, not JSON) so the user sees per-task token usage at a glance.

## Edge cases

- If `.forge/` does not exist, say:
  `Forge not initialized. Run /forge brainstorm to get started.`
  and stop.
- If the headless query command fails, fall back to reading `.forge/state.md`
  and `.forge/token-ledger.json` directly and present whatever is available.
- Never use em dashes in the output (per project style).
