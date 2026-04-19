---
spec: collab
total_tasks: 13
estimated_tokens: 90000
depth: standard
---

# Collab Frontier — Hackathon-Native Multiplayer Forge

## Tier 1 (parallel — no dependencies)
- [T001] Auto-join session ID + scripts/forge-collab.cjs scaffold | est: ~5k tokens | repo: - | maps: R001
- [T002] Similarity routing primitive (TDD) | est: ~7k tokens | repo: - | maps: R005
- [T003] Distributed claim queue + consolidation-lease primitive (TDD) | est: ~9k tokens | repo: - | maps: R006, R016 | provides: claim-queue, consolidation-lease
- [T004] Transport layer: Ably + polling fallback + targeted-delivery primitive (TDD) | est: ~9k tokens | repo: - | maps: R013, R015 | provides: transport, targeted-send
- [T005] Declare ably peerDependency in package.json | est: ~2k tokens | repo: - | maps: R013
- [T006] Single-writer discipline utilities: UUID flag IDs + user-scoped append logs (TDD) | est: ~4k tokens | repo: - | maps: R016 | provides: flag-id-gen, user-scoped-log

## Tier 2 (depends on Tier 1)
- [T007] Brainstorm chat mode + lease-gated consolidate + categorize with type field + routed clarifying questions | est: ~11k tokens | repo: - | depends: T001, T003, T004 | consumes: consolidation-lease, transport, targeted-send | maps: R002, R003, R004, R014, R015, R016
- [T008] Per-task branches pushed to origin with checkpoint updates | est: ~6k tokens | repo: - | depends: T001, T003 | consumes: claim-queue | maps: R007

## Tier 3 (depends on Tier 2)
- [T009] Research-type task execution + streaming results to .forge/collab/research/ | est: ~6k tokens | repo: - | depends: T003, T007, T008 | consumes: claim-queue | maps: R014
- [T010] Forward-motion decision flags + review/override UX + targeted flag notifications | est: ~9k tokens | repo: - | depends: T003, T004, T006, T008 | consumes: flag-id-gen, targeted-send, user-scoped-log | maps: R008, R009, R015, R016
- [T011] Per-agent squash-merge with race-retry (TDD) | est: ~7k tokens | repo: - | depends: T008 | maps: R010
- [T012] Push-config inheritance + late-join mid-session | est: ~6k tokens | repo: - | depends: T003, T008, T011 | maps: R011, R012

## Tier 4 (integration review)
- [T013] End-to-end collab integration review | est: ~9k tokens | repo: - | depends: T007, T009, T010, T011, T012 | maps: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R013, R014, R015, R016

## Coverage
- R001 -> T001, T013
- R002 -> T007, T013
- R003 -> T007, T013
- R004 -> T007, T013
- R005 -> T002, T013
- R006 -> T003, T013
- R007 -> T008, T013
- R008 -> T010, T013
- R009 -> T010, T013
- R010 -> T011, T013
- R011 -> T012, T013
- R012 -> T012, T013
- R013 -> T004, T005, T013
- R014 -> T007, T009, T013
- R015 -> T004, T007, T010, T013
- R016 -> T003, T006, T007, T010, T013

## Task Notes

### T001 — Auto-join session ID + scaffold (R001)
Creates `scripts/forge-collab.cjs` with `sessionIdFromOrigin()` returning first 12 hex chars of SHA-256 of `git remote get-url origin`. Errors with clear message when no origin remote. Establishes module structure that T002–T012 extend. Includes two-clone integration test.

### T002 — Similarity routing primitive (R005, TDD)
Tests first. Implements `scoreParticipant(text, participant)` (LLM classifier, 0–1), `routeToParticipant(text, participants)` with formula `similarity × (1 / (1 + active_tasks_on_machine))`, epsilon broadcast threshold read from `.forge/config.json` `collab.route.epsilon` (default 0.05), deterministic tiebreak. Zero-contribution participant scores exactly 0.

### T003 — Claim queue + consolidation-lease primitive (R006, R016, TDD)
Tests first. Two primitives sharing the same transport-gated lease mechanism:
- **Claim queue**: Claim messages `{task_id, claimant, lease_expiry}`. TTL from config (`collab.claim_lease_seconds` default 120, `collab.heartbeat_seconds` default 30). Heartbeat refresh, stale reclaim.
- **Consolidation-lease** (R016): Generic short-lived single-writer lease (TTL <= 30s) over the transport channel, keyed by lease name (e.g. `"consolidation"`). Exposes `acquireLease(name, ttl)`, `releaseLease(name)`, `withLease(name, ttl, fn)` that defers/aborts cleanly when lease is already held.
Tests: two-agent claim race asserts exactly one winner; two-agent lease contention asserts exactly one holder, the other defers gracefully.

### T004 — Transport layer + targeted-delivery primitive (R013, R015, TDD)
Tests first. `createTransport()` picks Ably when `ABLY_KEY` present, else prints setup guide and exits unless `--polling`. Polling mode uses `forge/collab-state` branch with 2–3s commit poll. Ably imported lazily (`require('ably')` inside the Ably branch only).
Adds `sendTargeted(handle, message)` primitive (R015): Ably private channel when Ably transport active; append to `forge/collab-state` polling branch tagged with `target: <handle>` when polling. Tests assert non-target participants receive zero messages.

### T005 — package.json peerDependency (R013)
Adds `"peerDependencies": { "ably": "^2.0.0" }` and `"peerDependenciesMeta": { "ably": { "optional": true } }`. No hard dependency. Verify `npm install` still works with zero deps.

### T006 — Single-writer discipline utilities (R016, TDD)
Tests first. Small utility task splitting R016 into two standalone pieces that don't require transport:
- `generateFlagId()`: UUID v4 generator (pure, no transport) so two agents writing flags simultaneously never collide on the filesystem. Alternative path via transport-coordinated monotonic counter noted but UUID is the default.
- `userScopedLogPath(kind, handle)`: returns e.g. `.forge/collab/routing-log-<handle>.jsonl` so append-only coordination logs are per-user, eliminating cross-user append races. `appendToUserScopedLog(kind, handle, entry)` wrapper used by T007 (brainstorm-question log) and T010 (flag-emit log).
Tests assert two concurrent `generateFlagId()` calls produce distinct paths, and two concurrent `appendToUserScopedLog` calls with different handles don't collide.

### T007 — Brainstorm + consolidate + categorize + routed clarifying questions (R002, R003, R004, R014, R015, R016)
All three document-pipeline stages merged because they share parsing/schema code; extended for R014/R015/R016:
- `brainstorm` (R002): interactive loop, requires explicit "accept", writes `inputs-<handle>.md` with frontmatter, auto-push per T012. **Clarifying-question routing (R015)**: for each round-1 clarifying question, compute `routeToParticipant(question, participants)` over the in-progress brain-dump and publish a targeted transport message via `sendTargeted` containing `{question_text, source_section, on_disk_path}`. Logged via `appendToUserScopedLog("routing", handle, ...)` from T006.
- `consolidate` (R003): reads all `inputs-*.md`, produces `consolidated.md` with multi-contributor annotations. **Lease-gated (R016)**: wraps write in `withLease("consolidation", 30, fn)` from T003; concurrent invocation defers.
- `categorize` (R004, R014): writes `categories.json` with `{id, title, category, source_contributors, is_decision, type}`. `type` is `"coding"` or `"research"`. Maximal split, contradictions -> decision tasks. **Lease-gated (R016)** same mechanism as consolidate.
Tests: scripted brainstorm acceptance + targeted question message to expected participant with zero other recipients; three-input multi-contributor consolidation with two agents racing asserts exactly one write lands; three-topic categorization produces correct `type` field per task.

### T008 — Per-task branches (R007)
On task start, push worktree branch as `forge/task/<task-id>`. Push after each Forge checkpoint step (hook into existing checkpoint writer). Delete origin branch on successful squash-merge. Integration test asserts mid-execution branch presence and post-completion absence. Consumes `claim-queue` to learn task_id on claim.

### T009 — Research-type task execution (R014)
When an executing agent claims a task with `type: "research"` (from T007 categorization), it runs the research workflow (uses existing `forge:researcher` agent patterns) and streams the result to `.forge/collab/research/<task-id>.md` as sections complete, each section commit-and-pushed (respecting R011/T012 push config). Coding-type tasks continue through the existing execute pipeline unchanged. Test: mixed categorization with one coding and one research task asserts both claim and complete through the same claim queue; research file appears on origin with expected content.

### T010 — Flags + review/override UX + targeted flag notifications (R008, R009, R015, R016)
Merged because flag write, override, and targeted routing all operate on the same `.forge/collab/flags/F<id>.md` document. Extended for R015/R016:
- **Forward-motion flag write (R008)**: phase guard (only `executing` and sub-phases); other phases unchanged. Flag filename uses `generateFlagId()` from T006 (R016) — UUID suffix, not sequential, to avoid collision.
- **Targeted notification on flag write (R015)**: after writing the flag, compute `routeToParticipant(flag.title + flag.rationale, task.source_contributors)` and `sendTargeted` the notification. Non-target participants receive no message.
- **Review/override (R009)**: `/forge:collaborate flags` lists all with status; `/forge:collaborate override <id> <decision>` updates flag and re-triggers dependent tasks.
- **User-scoped flag-emit log (R016)**: each flag write appends to `.forge/collab/flag-log-<handle>.jsonl` via T006 helper.
Tests: decision during execute writes flag with UUID path + continues; override re-runs dependent task; flag for `source_contributors: [daniel]` produces exactly one targeted message to daniel; two agents producing flags simultaneously land at distinct filesystem paths.

### T011 — Squash-merge race-retry (R010, TDD)
Tests first. On verify-pass, executing agent squash-merges and pushes `origin/main`. On rejection, `git pull --rebase origin main` + retry up to 3 with linear backoff. No global merge-tier command. Two-agent near-simultaneous completion test asserts both land cleanly.

### T012 — Push-config inheritance + late-join (R011, R012)
Merged because both gate on the same push-config check path. Read existing `.forge/config.json` auto-push flag; silent push when enabled, prompt when disabled. Disabling auto-push gates only git push steps, not lease heartbeats, flag writes, or targeted transport sends. Late-join: on `/forge:collaborate` activation, `git pull` first, subscribe to transport, read claims snapshot, skip already-claimed, claim next unblocked. Tests cover both auto-push branches and late-join mid-execute.

### T013 — Integration review
Final review pass against all 16 R's. Exercises the full `/forge:collaborate` loop with 2–3 simulated participants end-to-end across both transports and both task types (coding + research). Asserts targeted routing is not broadcast, consolidation lease prevents concurrent writes, flag IDs never collide, user-scoped logs have no cross-user contention. No new feature code; catches cross-requirement regressions missed by per-task tests.
