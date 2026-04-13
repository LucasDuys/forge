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

## Step 2.5: Auto-Detect Project Context

Before starting the interactive Q&A, automatically detect available context:

**Design system:** Check if `DESIGN.md`, `design.md`, or `docs/DESIGN.md` exists. If found, pass its path to the brainstorming skill so it can reference existing design constraints in the spec. If not found, the brainstorming skill will ask whether the user wants one (for UI projects).

**Knowledge graph:** Check if `graphify-out/graph.json` exists. If found, load the god nodes and community structure to inform the brainstorming Q&A with architecture context. This helps propose approaches that align with existing codebase structure.

Neither requires any user action. Detection is automatic and silent.

## Step 3: Start brainstorming

**IMPORTANT: The brainstorm phase is mandatory before planning and execution.** The spec files produced by this workflow are the ONLY way to get `status: approved` specs, which are required by `/forge plan` and `/forge execute`. Do NOT skip this step. Do NOT write spec files directly without going through the full interactive brainstorm flow.

Now invoke the `forge:brainstorming` skill with the user's arguments, plus any auto-detected context (design system path, graph summary).

**User arguments:** $ARGUMENTS

Pass the full arguments to the skill. The skill handles:
- Plain topic: interactive brainstorm from scratch
- `--from-code`: analyze existing codebase, generate spec draft
- `--from-docs PATH`: read documents, extract requirements into spec format

**Workflow enforcement:** The brainstorming skill MUST:
1. Ask clarifying questions (minimum 3, even for simple topics)
2. Present 2-3 approach proposals with trade-offs
3. Wait for EXPLICIT user approval before writing the spec
4. Only set `status: approved` after the user confirms their choice

If the user tries to skip brainstorming or rush through it, gently enforce the workflow. A few minutes of clarification prevents hours of wasted implementation.
