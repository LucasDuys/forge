---
description: "Opt-in multiplayer mode -- brain-dump together, claim tasks across machines, flag decisions async"
argument-hint: "[start|join|brainstorm|status|claim|flags|override|leave] [args]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh:*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs:*)", "Bash(node -e *)", "Bash(git:*)", "Bash(gh:*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Agent(*)"]
---

# Forge Collaborate

Activates hackathon-native multiplayer mode: N users on different machines brain-dump ideas, AI consolidates into categorized tasks, tasks dispatch across machines via a distributed claim queue, each agent squash-merges its own completed task. Forward-motion during execute: AI picks + flags decisions, humans override async.

## Subcommands

| Command | What it does |
|---|---|
| `/forge:collaborate start` | Initialize collab state, print session code derived from repo's origin URL |
| `/forge:collaborate join` | Sync with existing session in this repo (git pull + subscribe) |
| `/forge:collaborate brainstorm` | Enter chat-mode brain-dump; agent iterates with you and writes `.forge/collab/brainstorm/inputs-<handle>.md` on accept |
| `/forge:collaborate status` | Show participants online, active claims, open flags |
| `/forge:collaborate claim <taskId>` | Explicitly reserve a specific task |
| `/forge:collaborate flags` | List all forward-motion flags with status |
| `/forge:collaborate override <flagId> <new-decision>` | Override an AI decision, mark flag overridden |
| `/forge:collaborate leave` | Release claims and disconnect |

## Step 1: Pre-flight

Verify `.forge/` exists. If not:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" .
```

Verify a git `origin` remote exists. If not, tell the user to set one and stop:

> `/forge:collaborate` needs a git `origin` remote to derive the session ID. Run `git remote add origin <url>` first.

**Gitignore migration check (R001).** Before any `start` subcommand writes
participant state, detect whether this checkout predates the collab
carve-out rules. If so, prompt the user to patch them; silently ignoring
this step would cause every brainstorm dump and flag write to be swallowed
by the legacy `.forge/` rule.

```bash
node -e "const c=require('${CLAUDE_PLUGIN_ROOT}/scripts/forge-collab.cjs');const r=c.detectLegacyGitignore({cwd:process.cwd()});console.log(JSON.stringify(r));"
```

If `needsPatching` is `true` on a `start` subcommand, surface the detection
`reason` to the user and offer to run:

```bash
node -e "const c=require('${CLAUDE_PLUGIN_ROOT}/scripts/forge-collab.cjs');console.log(JSON.stringify(c.patchGitignore({cwd:process.cwd()})));"
```

On confirmation, run the patch. On decline, stop with a clear message:
collab cannot proceed until `.gitignore` allows `.forge/collab/` through.
For non-`start` subcommands (status, claim, flags, ...) the check may be
informational only -- those paths do not depend on git-tracked artifacts
being propagated.

## Step 2: Parse subcommand

Read the first word of the user's arguments. Default to `status` if empty.

## Step 3: Invoke the collaborating skill

Invoke the **forge:collaborating** skill with:
- The resolved subcommand
- Any remaining arguments (task id, flag id, decision text)
- The path to `scripts/forge-collab.cjs` primitives
- Current working directory so the skill can read/write `.forge/collab/`

The skill drives the actual logic. Never write to `.forge/collab/` directly from this command; always go through the skill so the invariants (phase guard, lease discipline, user-scoped logs) are respected.

## Step 4: Report

After the skill returns, present a concise summary of what changed:

- For `start`: session code + setup guidance (Ably or polling).
- For `brainstorm`: path of the written inputs file + "pushed to origin".
- For `status`: participants, claims, open flags.
- For `claim`: task reserved + who previously held it (if anyone).
- For `flags`: table of flag id, task, decision, status.
- For `override`: confirmation + previous decision + re-run of dependent tasks.
- For `leave`: claims released.

If the skill reports an error (e.g., lease held by another agent), surface it clearly and suggest what to do next.
