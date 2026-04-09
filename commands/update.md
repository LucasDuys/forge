---
description: "Pull the latest Forge from upstream"
argument-hint: "[--check] [--force] [--plugin-root PATH]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-update.cjs:*)", "Read(*)", "Bash(git:*)"]
---

# Forge Update

Pull the latest Forge from upstream. Detects how the plugin is installed (git checkout vs marketplace cache vs custom `--plugin-dir`), runs the appropriate update mechanism, and reports the version delta. Safe to run repeatedly.

## What it does

The command shells out to `scripts/forge-update.cjs` which:

1. **Locates the plugin install** — uses `$CLAUDE_PLUGIN_ROOT` if set, otherwise walks up from the script directory looking for `.claude-plugin/plugin.json`. Override with `--plugin-root PATH`.
2. **Reads the current version** from `.claude-plugin/plugin.json`.
3. **Detects the install method**:
   - **git checkout** (`.git/` present) — fetches origin, fast-forwards the current branch, refuses if the working tree is dirty unless `--force` is given
   - **marketplace cache** (path contains `plugins/cache/`) — prints the manual `claude plugin marketplace update` instructions and exits with code 2 (those steps must be run from the user's terminal, not from inside Claude Code)
   - **unknown** — prints diagnostics and exits with code 2
4. **Runs the update** (or just shows what would change if `--check` is passed).
5. **Reports the version delta** and prompts the user to run `/reload-plugins`.

## Pre-flight Check

Run the script with `--check` first to see what would change before applying:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-update.cjs" --check
```

If updates are available, ask the user whether to proceed. If they say yes, run without `--check`.

If the user passed `--check` themselves, stop after the check report and tell them to re-run without `--check` when ready.

## Parse Arguments

Parse flags from `$ARGUMENTS`:

| Flag | Default | Description |
|------|---------|-------------|
| `--check` | off | Report only — show incoming commits, do not modify the working tree |
| `--force` | off | Stash uncommitted local changes before pulling (and pop them after) |
| `--plugin-root PATH` | auto | Override automatic plugin install discovery |

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-update.cjs" $ARGUMENTS
```

Capture the exit code.

## Exit Codes

| Code | Meaning | Next step |
|------|---------|-----------|
| 0 | Up to date or successfully updated | Tell user to run `/reload-plugins` |
| 1 | Update failed (network, merge conflict, dirty tree without `--force`) | Show the script's stderr to the user — it includes a remediation hint |
| 2 | Marketplace cache install or unknown method | Show the manual instructions printed to stdout |
| 3 | Pre-flight check failed (no `plugin.json` found) | Show stderr; user may need to pass `--plugin-root` |

## Output

If the update succeeds, present:

```
Forge Update — Complete
---
Previous: forge {old_version}
Updated:  forge {new_version}
Branch:   {git_branch}
Commits:  {N}

Run /reload-plugins to pick up the new version.
```

If already up to date, present a one-liner: `Forge is already up to date.`

If the user passed `--check`, present the incoming commit list and prompt them to re-run without `--check` when ready.

## Safety

- This command **never force-pushes**, never resets, never overwrites uncommitted work without `--force`.
- The script uses `git merge --ff-only`, which refuses if the local branch has diverged from upstream — surfacing the conflict to the user instead of silently merging.
- With `--force`, local uncommitted changes are stashed before the update and popped after. If the pop fails, the script reports the stash entry so the user can recover manually with `git stash list` / `git stash pop`.
- Marketplace cache installs are intentionally NOT touched — those are managed by Claude Code itself and the script only prints instructions.

## Why not just `git pull`?

The script wraps `git` with three guarantees this command's users care about:
1. Works on Windows where `git` is often not on `PATH` (the script resolves the `git.exe` path automatically).
2. Works for both git checkouts and marketplace installs (one command to learn, two install methods covered).
3. Reports the version delta from `plugin.json` so the user knows what changed at a glance, not just SHAs.
