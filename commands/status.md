---
description: "Show Forge progress and status"
allowed-tools: ["Read(*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)"]
---

# Forge Status

Read the following files and present a concise status report:

1. Read `.forge/state.md` — current phase, spec, task, iteration
2. Read `.forge/token-ledger.json` — token usage vs budget
3. Read `.forge/config.json` — autonomy mode, depth setting
4. Read `.forge/capabilities.json` — discovered MCP servers and skills (if exists)

Present the status in this format:

```
Forge Status
═══════════════════════════════════
Phase:     {{phase}}
Spec:      {{spec}}
Task:      {{current_task}} ({{task_status}})
Iteration: {{iteration}}

Tokens:    {{used}} / {{budget}} ({{percent}}%)
Depth:     {{depth}}
Autonomy:  {{autonomy}}

Capabilities: {{count}} MCP servers, {{count}} skills
```

If `.forge/` does not exist, say: "Forge not initialized. Run `/forge brainstorm` to get started."

If `.forge/.forge-loop.json` exists, add: "Loop active (iteration {{N}}/{{max}})"
