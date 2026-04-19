---
name: collaborating
description: Hackathon-native multiplayer collaboration mode -- brain-dump together, claim tasks across machines, flag decisions async. Drives the subcommands of /forge:collaborate.
---

# Collaborating Skill

You are driving `/forge:collaborate`. The primitives live in
`scripts/forge-collab.cjs` (exported by `require` into a local Node script
or invoked via `node -e`). This skill translates user intent into calls
against those primitives, honoring the invariants from spec-collab:

- Session ID is derived from `git remote get-url origin`; all participants
  in the same repo auto-join the same session.
- During the `executing` phase, AI decisions never block humans: they
  become flags that humans can review and override async.
- Writes to shared coordination state (consolidated.md, categories.json)
  are gated by a short-lived `consolidation` lease to prevent concurrent
  overwrites.
- All brainstorm + consolidated + categories + questions + flags
  artifacts live under `.forge/collab/` and are committed to git so late
  joiners get full context via `git pull`.

## Subcommand Dispatch

Read the first word of the user's arguments. Route to the matching phase
below. If no subcommand is given, default to `status`.

---

### `start` -- initialize a session

1. Derive the session ID by calling `sessionIdFromOrigin()` via a small
   inline Node script:
   ```bash
   node -e "console.log(require('./scripts/forge-collab.cjs').sessionIdFromOrigin())"
   ```
   If this throws because there is no `origin` remote, tell the user to
   add one and stop.

2. Resolve the participant handle: prefer `gh api user --jq .login`,
   fall back to `git config user.email`, finally `$USER`.

3. Ensure `.forge/collab/` exists (`mkdir -p .forge/collab`).

4. Write `.forge/collab/participant.json` with `{handle, session_id,
   started: <iso>}`.

5. Resolve the transport mode. Call `selectTransportMode` with
   `process.env` and any `--polling` flag the user passed. Report:
   - `ably`: "Realtime transport will use Ably (ABLY_KEY detected)."
   - `polling`: "Zero-setup mode via git polling on forge/collab-state
     branch every ~2.5s."
   - `setup-required`: print the setup guide returned by `renderSetupGuide()`
     and exit (unless `--polling` was passed).

6. Report the session code (the full 12-hex session ID) and tell the user
   to share it out-of-band with teammates (though strictly speaking any
   teammate with the repo will derive the same code automatically).

---

### `join` -- sync with an existing session

Call `lateJoinBootstrap` with the transport and the current unblocked
task IDs (read from `.forge/plans/*-frontier.md`):

1. Do a git pull on the current branch.
2. Read the plan frontier to list task IDs.
3. Call `lateJoinBootstrap({ transport, unblockedTaskIds: ids, cwd })`
   to get the list of claimable task IDs.
4. Print a tidy status: how many tasks total, how many already claimed
   by others, how many available for this joiner.

---

### `brainstorm` -- chat-mode brain-dump

This is the interactive loop that replaces the single-user brainstorm.
Runs in place in the current session.

1. Greet: "Starting a collaborative brain-dump. I'll ask questions to
   help you structure your thoughts. When you're happy, say 'accept' and
   I'll write your refined input to `.forge/collab/brainstorm/`."

2. Ask 3-5 clarifying questions one at a time to draw out the user's
   ideas, priorities, and constraints. Match the tone of
   `/forge:brainstorm` but scope to the user's own section -- don't try
   to design the whole product; the AI-driven consolidation across users
   will merge everyone's ideas later.

3. After each answer, summarize what you've captured.

4. When the user says `accept` (or "looks good", "write it", etc.), call
   the primitive via an inline Node script:
   ```bash
   node -e "const c = require('./scripts/forge-collab.cjs'); \
     const p = c.brainstormDump('.forge/collab', process.env.FORGE_HANDLE, \
     process.env.FORGE_BRAIN_DUMP); console.log(p);"
   ```
   (Or just use `Write` against `.forge/collab/brainstorm/inputs-<handle>.md`
   directly with the standard frontmatter -- either path is equivalent.)

5. Stage + commit + push the new file per the project's auto_push
   setting (read via `readAutoPushConfig('.forge')`).

6. If a consolidated.md already exists, tell the user "Your input has
   joined the brainstorm. When all contributors are in, run
   `/forge:collaborate consolidate` to merge everyone's input."

---

### `consolidate` -- run consolidation + categorization under lease

Optional subcommand for whoever takes the consolidation step. Calls
`writeConsolidatedUnderLease(transport, '.forge/collab', handle, inputs,
opts)` where `inputs` is the result of `readAllInputs('.forge/collab')`.

- If the call returns `{ held: true }`: report the task count and
  categories breakdown (coding vs research vs decision).
- If `{ held: false, holder }`: tell the user "Consolidation in progress
  by `<holder>`. Try again in a moment."

---

### `status` -- show session state

Call the primitives to build a status report:

- `listActiveTaskClaims(transport, {now: Date.now()})` -> active claims
- `listFlags('.forge/collab', {status: 'open'})` -> open flags
- Read `.forge/collab/participant.json` -> current handle
- Read `.forge/collab/categories.json` if it exists -> task count

Print a tidy summary:

```
Session: <sessionId>
Mode:    ably | polling
You:     <handle>

Claims:
  T004  daniel  (expires in 85s)
  T007  lucas   (expires in 43s)

Open flags (3):
  F0123abc  T005  "use redis pubsub"   (daniel)
  F0456def  T008  "retry with backoff" (sarah)

Next claimable:
  T009, T011, T012
```

---

### `claim <taskId>` -- explicit claim

Call `claimTask(transport, taskId, handle, { ttlSeconds: 120 })`.
Report the outcome:
- `{ acquired: true }`: "Reserved T004 for you. Lease expires in 120s;
  heartbeats auto-refresh while you work."
- `{ acquired: false, holder }`: "T004 is already held by `<holder>`.
  Wait for them to finish or run `/forge:collaborate status` to see
  what else is claimable."

---

### `flags` -- list forward-motion flags

Call `listFlags('.forge/collab', { status })` with an optional status
filter. Print a table.

---

### `override <flagId> <new-decision>` -- override an AI decision

Call `overrideFlag('.forge/collab', flagId, newDecision, { author: handle })`.

- `{ overridden: true, previousDecision }`: confirm, note previous
  decision, and tell the user that dependent tasks will be re-triggered
  on the next execute iteration.
- `{ overridden: false, reason }`: surface the reason (`not_found`,
  `already_overridden`, `malformed`) so the user can diagnose.

---

### `leave` -- release claims and disconnect

1. Read `.forge/collab/participant.json` for the handle.
2. List all active claims via `listActiveTaskClaims(transport)` and
   filter for `claimant === handle`.
3. For each such claim, call `releaseTaskClaim(transport, taskId, handle)`.
4. If the transport has a `disconnect()` method, call it.
5. Delete `.forge/collab/participant.json`.
6. Report: "Released <N> claims. Disconnected from session."

---

## Invariants to Respect

- **Never write flag files outside the executing phase.** The primitive
  enforces this, but the skill should not even try to call
  `writeForwardMotionFlag` in brainstorm or plan contexts.
- **Never bypass the consolidation lease.** Every write to
  `consolidated.md` or `categories.json` must go through
  `writeConsolidatedUnderLease`.
- **Always inherit push behavior from `.forge/config.json`.** Use
  `gatedPush` when pushing from this skill, never a raw `git push`.
- **Never broadcast a targeted message.** When routing a question or flag
  notification, check that `routeToParticipant` returned a specific
  handle before calling `sendTargeted`. Fall back to `publish` only when
  the routing explicitly returned `"broadcast"`.

## Key Principles

- One subcommand per invocation. Don't chain.
- If the user's intent is ambiguous, ask one clarifying question, not
  three.
- Always print a short summary at the end of each subcommand so the user
  knows what actually happened.
