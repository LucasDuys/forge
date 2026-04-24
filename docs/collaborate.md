# Collaborative Mode

`/forge:collaborate` is the opt-in multiplayer execution path. Two or more participants drive the same spec from different machines without a central server, without invite links, without a shared secret. Coordination is files + git + a transport.

For the architectural overview see [architecture.md § Collaborative Mode](architecture.md#collaborative-mode-forgecollaborate). This page is the operational reference.

## Prerequisites

Pick one transport before running `/forge:collaborate start`:

| Transport | Latency | Setup |
|---|---|---|
| **Polling** (default) | ~2.5s | None |
| **Ably** (realtime) | Sub-second | `npm install ably` + `export ABLY_KEY=...` |

`ably` is declared an OPTIONAL peerDependency in the plugin's `package.json` — only required when `ABLY_KEY` is in env and `--polling` is not passed. Free Ably tier (6M messages/month, 200 peak connections) covers typical team use. Sign up at [ably.com/sign-up](https://ably.com/sign-up).

## Subcommands

| Command | What it does |
|---|---|
| `/forge:collaborate start [--polling]` | Initialize session, write `participant.json` then `.enabled` atomically, report session code + transport mode |
| `/forge:collaborate join` | Sync with existing session (git pull, transport connect, list claimable tasks) |
| `/forge:collaborate brainstorm` | Chat-mode brain-dump; writes `.forge/collab/brainstorm/inputs-<handle>.md` on accept |
| `/forge:collaborate consolidate` | Merge all participant inputs into `consolidated.md` + `categories.json` under lease |
| `/forge:collaborate status` | Show participants, active claims, open flags, claimable tasks |
| `/forge:collaborate claim <taskId>` | Explicitly reserve a task (120s lease with heartbeat) |
| `/forge:collaborate flags` | List open forward-motion flags |
| `/forge:collaborate override <flagId> <decision>` | Override an AI decision; re-triggers the dependent task |
| `/forge:collaborate leave` | Release claims, disconnect, delete markers in the safe order |
| `/forge:collaborate recover` | Classify and repair stale state from a crashed start/leave |

## Typical day

```bash
# Lucas on Mac
/forge:collaborate start                  # session 795fec3b7abe, transport: polling
/forge:collaborate brainstorm             # 3-5 questions, writes inputs-lucas.md
git push                                  # other machines see your input

# Daisy on Windows, same repo
git pull
/forge:collaborate join                   # same origin = same session
/forge:collaborate brainstorm             # writes inputs-daisy.md

# Whoever's ready first
/forge:collaborate consolidate            # merges both inputs under 30s lease
/forge:plan                               # deterministic from the consolidated spec

# Both machines, simultaneously
/forge:execute --autonomy full
# -> Lucas claims T001, Daisy claims T002 (exactly one winner per task)
# -> AI decisions become flags, both machines see them and can override
```

## When to use `/forge:collaborate` vs solo

**Solo is right when:**
- You are the only contributor on this feature
- You want the tightest loop (no consolidation step)
- Every decision should wait for you, not continue with a default

**Team is right when:**
- 2+ participants are building the same feature concurrently
- AI decisions should not block execution — a flag you can override later is better than a pause
- You want a durable audit trail of who did what

**Hybrid is right when:**
- One person writes the spec, multiple execute it (solo brainstorm → team execute)
- Multiple people consolidate requirements, one person builds (team brainstorm → solo execute)

The phase enforcement is symmetric — you opt into `/forge:collaborate` per phase, not all-or-nothing.

## What's shared, what's local

Committed to git (propagate via push/pull):

- `.forge/collab/brainstorm/inputs-<handle>.md`
- `.forge/collab/consolidated.md`
- `.forge/collab/categories.json`
- `.forge/collab/flags/F<id>.md`
- `.forge/collab/questions/Q<id>.md`

Local per-machine (re-ignored by `.forge/collab/.gitignore`):

- `participant.json`
- `.enabled`
- `flag-emit-log-<handle>.jsonl`

The carve-out is detected and patched by `detectLegacyGitignore` + `patchGitignore`. Old checkouts predating the carve-out get a prompt to migrate.

## Session identity

`sessionIdFromOrigin()` hashes `git remote get-url origin` into a 12-hex code. Two properties follow:

1. **Every clone of the same repo derives the same code.** No invite flow needed.
2. **Re-pointing origin creates a new session.** `classifyCollabState` detects this as `session_mismatch` and offers migration.

If your repo has no `origin` remote, `/forge:collaborate start` stops with instructions to add one. There is no "local" mode without a remote because the whole design turns the remote into the coordination substrate.

## Claim queue mechanics

Every task claim acquires a lease at `claim:<taskId>` with a 120s TTL. Heartbeats refresh the lease every 30s. If a laptop closes mid-task, the lease expires and the task returns to the claimable pool.

Parallel claims on the same taskId resolve as follows:

- **Ably**: publish `cas_propose` → 150ms election window → authoritative `cas_won` broadcast → loser gets `acquired:false, reason:'lost_race', holder:<winner>`.
- **Polling**: commit-rebase retry on `forge/collab-state` branch → first commit wins → loser rebases against updated state and re-proposes.

Either way **exactly one claim wins**. The `tryAcquireLease` function is `async` and awaits the transport's CAS Promise — see `tests/collab-claim-race.test.cjs` for the regression test that locks this in.

## Forward-motion flags

Whenever the AI would normally pause for input during `/forge:execute`, it instead:

1. Picks the best defendable default.
2. Writes `flags/F<id>.md` with `phase`, `task_id`, `author`, `decision`, `alternatives`, `rationale`, `source_contributors`.
3. Commits + pushes.
4. Executes with the chosen default.

Review + override flow:

```bash
/forge:collaborate flags
# F0123abc  T005  decision="use redis pubsub"       status=open  author=daisy
# F0456def  T008  decision="retry with exponential" status=open  author=lucas

/forge:collaborate override F0123abc "use nats instead"
# Marks F0123abc overridden; T005 re-triggers on next execute iteration.
```

Flag routing is Jaccard-scored: the flag's decision text is compared against each participant's `contributions` text. A targeted `flag-ping` goes to the best match (above epsilon threshold). Broadcast is the fallback when no participant scores high enough.

## Recovery

Crashes between `start` and `leave` leave a partial state. `/forge:collaborate recover` classifies the state and offers the remedy:

| Class | State | Remedy |
|---|---|---|
| `inactive` | Neither marker present | Nothing to recover |
| `healthy` | Both markers, session matches origin | No action needed |
| `stale_participant` | `participant.json` present, `.enabled` missing | Reset (delete participant.json) |
| `stale_enabled` | `.enabled` present, `participant.json` missing | Repair (re-derive participant from git config) |
| `session_mismatch` | Both present but session_id differs from current origin | Migrate participant to new session |

`recoverCollabState` is non-destructive without `apply:true` — dry-run returns the intended action list for user confirmation.

## Configuration

Relevant keys in `.forge/config.json`:

```json
{
  "collab": {
    "auto_push": true,
    "polling_interval_ms": 2500,
    "epsilon": 0.15,
    "consolidation_ttl_seconds": 30,
    "claim_ttl_seconds": 120,
    "heartbeat_seconds": 30
  }
}
```

See [configuration.md](configuration.md) for the full schema.

## Internals

- Primitives: `scripts/forge-collab.cjs` (~3000 lines, pure JS, CJS)
- Skill: `skills/collaborating/SKILL.md` (subcommand dispatch + invariants)
- Command: `commands/collaborate.md` (preflight + skill invocation)
- Tests: 14 collab suites covering lease primitives, transports, routing, flag lifecycle, enabled-marker invariants, gitignore carve-out, cross-process wire

## Known gaps and future work

- **Real Ably CI run**: the deterministic async-CAS mock in `tests/collab-claim-race.test.cjs` catches the claim-mutex bug but does not exercise live WebSocket network behavior. A nightly-CI Ably run against a scratch app would add confidence.
- **Preflight probe for `ably`**: surfacing the `npm install ably` instruction BEFORE `createAblyTransport` is called (so users don't see the bare error). The skill already does this after forge-self-fixes-2 R013, but a dedicated `/forge:collaborate doctor` command would be cleaner.
