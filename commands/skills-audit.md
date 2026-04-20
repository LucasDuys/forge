---
description: "Audit every skill and command Forge can see — group by status (active, duplicate, deprecated, archived)"
allowed-tools: ["Read(*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-skills-audit.cjs:*)"]
---

# Forge Skills Audit

List every skill and slash-command visible to the current Forge install, with
source + path + status. Output is designed to be copy-paste-ready into a
"skills cleanup" PR description.

## How to run

Invoke the inventory script. Default output is a fixed-width table; pass
`--json` for machine-readable output.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-skills-audit.cjs"
```

The script walks:

- `~/.claude/skills/` — user-level skills (source `user-skills`, plus
  `archived` when the path sits under `_archived-*/` or `archived/`).
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/skills/` — every
  plugin-shipped skill (source `plugin:<plugin>`).
- `~/.claude/commands/` — user-level slash commands.
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/commands/` — every
  plugin-shipped command.

## Status values

| Status     | Meaning |
|------------|---------|
| active     | Healthy, loadable, not flagged. |
| duplicate  | Same name appears in ≥ 2 sources (e.g. `user-skills` and a plugin, or two plugins). Resolve by deleting the stale copy. |
| deprecated | SKILL.md description starts with `Deprecated`. The skill loader may still pick it up; prefer the replacement noted in the description. |
| archived   | Path contains `_archived-*/` or `archived/`. Kept for reference; should not be invoked. |

## Presenting the result

Render the table output verbatim under a `### Skills Audit (<date>)` heading
in the PR description. Follow it with the summary line the script prints
(`totals: ...` + `status: ...`). Call out any `duplicate` rows as action
items for the cleanup PR.

If a user asks for JSON (or wants to pipe the output into another tool), run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-skills-audit.cjs" --json
```

## Edge cases

- If the script exits non-zero, read stderr; the most common cause is a
  corrupt `plugin.json` or `SKILL.md` that broke the underlying
  `discoverCapabilities` walk. Surface the error to the user; do not try
  to "fix" the skill file from this command.
- If the table is empty, `~/.claude/` probably does not exist on this
  machine (e.g. running inside an ephemeral sandbox). Let the user know.
- Never use em dashes in generated output (per project style).
