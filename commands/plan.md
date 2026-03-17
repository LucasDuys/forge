---
description: "Decompose specs into task frontiers with dependency tracking"
argument-hint: "[--filter NAME] [--depth quick|standard|thorough] [--repos REPO1,REPO2]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Agent(*)"]
hide-from-slash-command-tool: "true"
---

# Forge Plan

Decompose approved specifications into ordered task frontiers with dependency DAGs, token estimates, and repo tags.

## Pre-flight Check

1. Verify `.forge/` exists. If it does not, stop and tell the user:
   > `.forge/` not found. Run `/forge brainstorm` first to generate specifications.
2. Verify `.forge/specs/` contains at least one `spec-*.md` file with `status: approved` in its frontmatter. If none found, stop and tell the user:
   > No approved specs found in `.forge/specs/`. Run `/forge brainstorm` to create specs, then approve them before planning.

## Parse Arguments

Parse flags from `$ARGUMENTS`:

| Flag | Default | Description |
|------|---------|-------------|
| `--filter NAME` | *(all specs)* | Only plan specs whose domain matches NAME |
| `--depth quick\|standard\|thorough` | *(auto-detect)* | Task granularity level |
| `--repos REPO1,REPO2` | *(all configured repos)* | Limit planning to specific repos |

If `--depth` is not provided and the project config has `auto_detect_depth: true`:
- Dispatch a **forge-complexity** agent (via `Agent` tool) to analyze the specs and recommend a depth level.
- Use the agent's recommendation unless the user overrides.
- If auto-detection is disabled in config, fall back to the `depth` value in `.forge/config.json` (default: `standard`).

## Read Configuration

1. Read `.forge/config.json` for project settings (repos, depth, cross_repo_rules).
2. Read `.forge/capabilities.json` if it exists, to inform the planner about available MCP servers and skills.

## Invoke Planning

Invoke the **forge:planning** skill with the following context:
- The list of approved spec files (filtered if `--filter` was used)
- The resolved depth level
- The repo configuration (filtered if `--repos` was used)
- Capabilities (if discovered)

The planning skill will:
1. Dispatch a **forge-planner** agent for each spec
2. Build dependency DAGs and group tasks into parallelizable tiers
3. Write frontier files to `.forge/plans/{spec-domain}-frontier.md`
4. Write token estimates to `.forge/token-ledger.json`
5. Initialize `.forge/state.md` with the first spec and `phase: idle`

## Output

After planning completes, present a summary:

```
Planning Complete
---
Specs planned: N
Total tasks: N
Estimated tokens: ~Nk
Depth: quick|standard|thorough

Frontier files:
  .forge/plans/spec-auth-frontier.md (N tasks)
  .forge/plans/spec-ui-frontier.md (N tasks)
```

Then tell the user:
> Run `/forge execute` to start autonomous implementation, or `/forge execute --autonomy supervised` to pause between each task.
