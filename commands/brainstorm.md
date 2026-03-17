---
description: "Turn an idea into concrete specs with testable requirements"
argument-hint: "[TOPIC] [--from-code] [--from-docs PATH]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh:*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Agent(*)"]
---

# Forge Brainstorm

## Step 1: Initialize project state

If `.forge/` does not exist, initialize it:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" .
```

## Step 2: Discover capabilities

Scan the user's environment for MCP servers, skills, and plugins:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" discover --forge-dir .forge
```

This writes `.forge/capabilities.json` with available tools that can enhance brainstorming and execution.

## Step 3: Start brainstorming

Now invoke the `forge:brainstorming` skill with the user's arguments.

**User arguments:** $ARGUMENTS

Pass the full arguments to the skill. The skill handles:
- Plain topic: interactive brainstorm from scratch
- `--from-code`: analyze existing codebase, generate spec draft
- `--from-docs PATH`: read documents, extract requirements into spec format
