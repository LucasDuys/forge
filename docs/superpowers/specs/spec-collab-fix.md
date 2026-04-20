---
domain: collab-fix
status: approved
created: 2026-04-20
complexity: standard
linked_repos: []
supersedes: []
relates_to: docs/superpowers/specs/spec-collab.md
---

# Collab Fix Spec — Make PR #4 Actually Work Cross-Machine

## Overview

PR #4 (`feat(collab): hackathon-native multiplayer collaboration mode`) landed 15 atomic commits with 367/367 passing unit + integration tests. Hands-on verification on this branch (see `docs/audit/CLAIM_VS_REALITY.md` O004–O007) revealed three blockers that prevent the advertised cross-machine collaboration from working:

1. `.forge/` is unconditionally gitignored by `scripts/setup.sh`, so `.forge/collab/*` artifacts never propagate to teammates via git.
2. The default polling-transport IO adapter ships with no-op `writeLease` and `appendMessage` stubs. Cross-clone live test confirmed: alice publishes, bob receives zero.
3. Targeted scoping is enforced only in userland subscriber callbacks, not at the transport layer — consumers that subscribe naively leak targeted messages to every listener.

Plus two lesser issues:

4. Ably `cas` is a local-only Map mutation with fire-and-forget broadcast — two simultaneous callers can both "win".
5. The Jaccard default scorer silently misroutes any real natural-language input; the spec's "LLM classifier" acceptance criterion was never actually wired.

This spec closes those gaps. In-repo unit-test coverage stays unchanged; we add one real cross-process wire test so regressions cannot hide behind stub-backed green suites.

All work happens on `fix/collab-and-forge-audit`, landing one commit per requirement.

## Requirements

### R001: .gitignore carve-out for shared collab artifacts

`setup.sh` today writes `.forge/` to `.gitignore`. Collab's design requires `inputs-<handle>.md`, `consolidated.md`, `categories.json`, `research/<id>.md`, `questions/**`, and `flags/**` to propagate via git pull. Per-machine state (`participant.json`, `flag-emit-log-<handle>.jsonl`) must stay local.

**Acceptance Criteria:**
- [ ] `scripts/setup.sh` writes `.gitignore` rules that exclude `.forge/` except `.forge/collab/`, with a nested `.forge/collab/.gitignore` that re-ignores `participant.json` and `flag-emit-log-*.jsonl`.
- [ ] Existing checkouts have a migration helper: running `/forge:collaborate start` on a repo whose `.gitignore` still ignores `.forge/collab/` prompts the user to run a fix command that patches the rules.
- [ ] `git check-ignore .forge/collab/inputs-lucas.md` returns non-zero (not ignored) on a fresh init.
- [ ] `git check-ignore .forge/collab/participant.json` returns zero (ignored) on a fresh init.
- [ ] End-to-end integration test: two clones of the same repo; clone A runs `brainstormDump` + commits + pushes; clone B fetches + pulls; the `inputs-<handle>.md` appears on clone B.

### R002: Polling transport writes via single-commit amend plus force-with-lease

The current default IO adapter (`scripts/forge-collab.cjs:647-681`) reads origin state via `git show` but writes nothing. The fix uses git's own ref-update CAS: the `forge/collab-state` branch always holds exactly one commit, every mutation rewrites that commit with `--amend` and force-with-leases it to origin. Agents racing on writes see `git push rejected (stale info)` → re-read, re-apply, retry.

**Acceptance Criteria:**
- [ ] `_defaultPollingIo.writeLease(branch, name, next)` reads current `state.json` from `origin/<branch>`, updates the `leases[name]` field, commits `--amend` on `<branch>`, pushes with `--force-with-lease=<branch>:<sha-read>`.
- [ ] `_defaultPollingIo.appendMessage(branch, msg)` follows the same amend-push cycle appending to the `messages[]` array; writer prunes messages older than `ttl_seconds` (default 300) on each mutation.
- [ ] Push rejection on `--force-with-lease` (stale info) triggers a re-read + re-apply, up to 3 retries with 100ms linear backoff; 4th rejection returns `{ ok: false, reason: "cas_exhausted" }`.
- [ ] After N operations by one client, `git log forge/collab-state --all` shows exactly 1 commit on that ref.
- [ ] All polling-transport-using code paths (`writeLease`, `appendMessage`, and any new ones) go through `gatedPush` so the user's `auto_push` setting is honored.
- [ ] Two-process race test: two node subprocesses sharing a bare-repo remote each call `cas` on the same lease name simultaneously → exactly one returns `true`, the loser returns `false` with `reason:"cas_race_lost"`.

### R003: Messages are a bounded append queue on the same state.json

Messages share the single-commit state document with leases. Structure: `{ id: uuid, event: string, data: object, from: clientId, ts: ISO, ttl_seconds: 300 }`. Writers compact on mutation; readers deduplicate by id.

**Acceptance Criteria:**
- [ ] state.json schema: `{ leases: {name: lease}, messages: [message] }` with a JSON-schema validator at `scripts/forge-collab-schema.json`.
- [ ] `appendMessage` prunes messages where `Date.now() - Date.parse(ts) > ttl_seconds * 1000` before writing.
- [ ] Readers in `_refresh()` maintain a `seenIds` Set per process; subscribe callbacks fire exactly once per (id, subscriber) pair for the process lifetime.
- [ ] Messages array is capped at 500 entries; oldest-first eviction triggers a warning log when capacity is reached.

### R004: Targeted scoping enforced at the transport layer

R015's "non-target participants receive zero messages" acceptance criterion is violated by the current code: `subscribe(event, cb)` calls `cb` on every message matching the event, regardless of `data.target`. Userland tests pass because the subscriber callbacks manually check `m.data.target === handle`.

**Acceptance Criteria:**
- [ ] `subscribe(event, cb)` signature becomes `subscribe(event, cb, { clientId })` or reads `clientId` from the transport factory options.
- [ ] Transport filters messages server-side before invoking `cb`: when `data.target` is set and `data.target !== clientId`, `cb` never fires.
- [ ] `sendTargeted(handle, event, data)` contract documented: only `handle` will ever receive it; all other connected clients see zero invocations of their `cb` for that message.
- [ ] Broadcast path unchanged: `publish(event, data)` with no `target` delivers to every subscriber.
- [ ] Existing R015 userland test (`tests/forge-collab.test.cjs:663`) updated to remove its application-layer filter and still pass on transport-layer filter alone.
- [ ] New test covers all three backends (memory, polling, ably-mocked) end-to-end.

### R005: Ably CAS is authoritative via publish-ack reconciliation

Current Ably `cas` mutates a local Map and publishes `lease-update`. Two clients racing null→lease both mutate their local Maps before the broadcast arrives — both think they won. Fix: `cas` becomes async, publishes the candidate mutation with a `cas_request_id`, waits up to 500 ms for an echoing `cas_won` from exactly one client (determined by first-ack rule), returns `true` on own ack, `false` otherwise.

**Acceptance Criteria:**
- [ ] Ably `cas(name, expected, next)` returns `Promise<boolean>`.
- [ ] Implementation publishes a `cas_propose { name, expected, next, reqId, from }` and listens for `cas_won { reqId, from }` messages.
- [ ] Deterministic winner rule: first `cas_propose` received (by `ts`) with matching `expected` state is declared winner via a `cas_won` echo from the *lease holder of record* (whoever has the lease broadcasts the ack; if no current holder, lowest `clientId` ties).
- [ ] Two simultaneous `cas(name, null, lease)` under simulated latency (100 ms) → exactly one returns `true`, other returns `false`.
- [ ] Timeout after 500 ms returns `false` with `reason:"cas_timeout"`; the `expected` state is still current on next read.

### R006: Cross-process wire test covering the real adapters

Every current collab test uses injected stubs. We need one test that runs real subprocesses with real git plumbing so stub-masked regressions cannot land.

**Acceptance Criteria:**
- [ ] New file `tests/forge-collab-wire.test.cjs` sets up a temporary bare git repo + two clones in `os.tmpdir()`.
- [ ] Test spawns two `node` subprocesses pointing at the two clones, each instantiating the polling transport with the default IO adapter.
- [ ] Subprocess A: `brainstormDump('lucas', ...)` → `claimTask('T001', 'lucas')` → `writeForwardMotionFlag({ task_id:'T001', decision:'redis', source_contributors:['sarah'] })`.
- [ ] Subprocess B: reads via `readAllInputs`, calls `claimTask('T001', 'sarah')` and asserts acquired:false with `reason:"held_by_lucas"`, subscribes to `flag-ping` and asserts at least one message received (as `source_contributor`).
- [ ] Test completes in under 30 seconds on CI.
- [ ] Cleanup: remove temp directories on test exit including failure paths.

### R007: Default scorer is LLM-backed, Jaccard becomes explicit opt-in

Spec-collab R005 AC 1 states: `scoreParticipant(text, participant)` returns "a number in [0, 1] via an LLM classification call." The shipped default is Jaccard token overlap, which returns 0 for any paraphrased or semantically-similar content. Silent misrouting is worse than a hard failure.

**Acceptance Criteria:**
- [ ] `routeToParticipant` throws with a clear message if no scorer is wired and `.forge/config.json` does not name one: `forge:collab routing requires a scorer; set collab.scorer in .forge/config.json or pass opts.scorer`.
- [ ] New file `scripts/forge-collab-scorer.cjs` exports an `llmScorer({ text, participant })` implementation that dispatches a `forge-researcher` subagent with a narrow prompt and parses the returned score.
- [ ] `.forge/config.json` template includes `"collab": { "scorer": "node scripts/forge-collab-scorer.cjs", "fallback_jaccard": false }`.
- [ ] When `fallback_jaccard: true` is explicitly set, current Jaccard behavior is preserved (for tests and offline mode).
- [ ] Integration test: a spec with contradicting contributor content ("use redis" vs "use nats") routes to the correct contributor via the LLM scorer; Jaccard would have misrouted on this input.

### R008: Collab-mode state uses an explicit .enabled marker

Currently collab mode is detected solely by `.forge/collab/participant.json` existence. If `/forge:collaborate leave` fails mid-cleanup (power loss, crash), the file lingers and the executor thinks collab is still on. Adding an explicit marker that `leave` writes atomically last prevents half-off states.

**Acceptance Criteria:**
- [ ] `/forge:collaborate start` writes `.forge/collab/.enabled` (empty file) as its final action after `participant.json`.
- [ ] `collab-mode-active` CLI and `agents/forge-executor.md` guard logic both check for `.enabled` (not `participant.json`).
- [ ] `/forge:collaborate leave` deletes `.enabled` first, then releases claims, disconnects, deletes `participant.json`.
- [ ] Crash recovery: a `/forge:collaborate recover` subcommand scans for stale state (`.enabled` missing but `participant.json` present, or the inverse) and offers to clean up.
- [ ] Unit test covers each of the four state-pair configurations (both present, both absent, each one alone).

## Future Considerations

- Presence-aware TUI (deferred from spec-collab).
- Shared token-budget accounting across participants.
- Gist-backed transport as a second opt-in fallback for repos whose policies disallow long-lived branches.
- WebRTC datachannel transport for sub-50 ms latency in same-LAN hackathon contexts.
