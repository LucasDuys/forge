---
description: "Decompose specs into task frontiers with dependency tracking"
argument-hint: "[--filter NAME] [--depth quick|standard|thorough] [--repos REPO1,REPO2]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Agent(*)"]
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

## Auto-Detect Project Context

These checks run automatically before planning. Do not skip them.

**Knowledge graph:** First check if `graphify-out/graph.json` already exists. If not, check if graphify is installed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" graph-status
```

If graphify is available and no graph exists, build one:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" graph-build --project-dir .
```

Once a graph exists, extract the summary:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" graph-summary --graph graphify-out/graph.json
```

This returns god nodes (top 10 most-connected concepts), community structure, and stats. Pass this summary to the planner agent. The planner uses it to align task boundaries with module boundaries and order tasks by architectural impact.

**Design system:** Check if `DESIGN.md`, `design.md`, or `docs/DESIGN.md` exists. If found, check each spec for UI-related requirements. For specs with UI tasks:
- Pass the DESIGN.md path to the planner
- The planner will tag UI tasks with `design: DESIGN.md` and add a design verification task

Neither is required. If absent, planning proceeds with standard spec-only decomposition.

## Spec Path-Validation Gate (R011)

Before invoking the planner, run the **forge-speccer-validator** agent on every spec that will be planned. This catches stale or misspelled paths in the spec before the planner decomposes it into tasks that would target files that do not exist.

For each spec file being planned:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-speccer-validator.cjs" <spec-path> <repo-root>
```

Interpret the exit code and JSON output:

- **Exit 0 / `status: OK`** — All paths in the spec resolve. Proceed to planning.
- **Exit 2 / `status: REPLAN_NEEDED`** — One or more paths are missing. Do NOT dispatch the planner against this spec yet. Instead:
  1. For each missing entry, compute an autocorrect suggestion via `findNearestPath(missingPath, repoRoot)` from the same module.
  2. Dispatch a replan pass: invoke the **forge-speccer** agent (or a replan sub-task) with the original spec plus the list of `{line, path, suggested, alternatives}` entries and instructions to rewrite the spec with the corrected paths. If no `suggested` match exists for a given missing path, flag it for human review rather than inventing a path.
  3. Write the corrected spec back to the same path (preserve the original under `.forge/specs/<name>.pre-replan.bak` for audit).
  4. Re-run the validator on the corrected spec. If it now returns OK, proceed to planning. If it still returns REPLAN_NEEDED and the missing paths are unchanged, stop and surface the issue to the user with the unresolved entries — do not loop indefinitely.
- **Exit 1 / fatal error** — surface the validator error to the user and stop. Do not plan against an unreadable spec.

This gate is mandatory. Skipping it risks a frontier whose tasks point at nonexistent files.

## Invoke Planning

Invoke the **forge:planning** skill with the following context:
- The list of approved spec files (filtered if `--filter` was used)
- The resolved depth level
- The repo configuration (filtered if `--repos` was used)
- Capabilities (if discovered)
- Knowledge graph summary (if `graphify-out/graph.json` exists)
- Design system path (if DESIGN.md exists)

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
