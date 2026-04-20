---
domain: collab
status: approved
created: 2026-04-19
complexity: complex
linked_repos: []
---

# Collab Spec — Hackathon-Native Multiplayer Forge

## Overview

Introduces the opt-in `/forge:collaborate` mode, designed as the best-practice way for hackathon teams (3–10 people) to work with Forge on a shared repo. The design embodies six principles: no meetings (brain-dump + AI categorization replace whiteboarding), AI auto-parallelization (similarity routing decides assignments), ambient visibility (per-task branches pushed to origin), decisions as hypotheses (during execute the agent picks + flags, never blocks), forward motion always (execute never waits for a human), and zero setup (auto-join by repo hash). Realtime Ably is the primary transport; git polling on a coordination branch is the zero-setup fallback. Default single-user Forge behavior is unchanged when the mode is never activated. This spec supersedes the archived `spec-collab-{routing,brainstorm,research,execute}.md` set.

## Requirements

### R001: Zero-config auto-join by repo hash
Session identity derives deterministically from the repository origin URL so any participant who clones the repo and runs `/forge:collaborate` joins the same session without exchanging codes.

**Acceptance Criteria:**
- [ ] Session ID is computed as a stable short hash of the `origin` remote URL (first 12 hex chars of SHA-256).
- [ ] Running `/forge:collaborate` in the same repo on two machines produces identical session IDs.
- [ ] Running `/forge:collaborate` in two different repos produces different session IDs.
- [ ] If the repo has no `origin` remote, the command errors with a clear message explaining the dependency.
- [ ] An integration test with two simulated clones asserts they join the same session.

### R002: Chat-mode brain-dump producing structured per-user docs
`/forge:collaborate brainstorm` launches a plan-mode-style conversation between the user and their local agent; on acceptance, the agent writes a structured, author-tagged input file and pushes it to git.

**Acceptance Criteria:**
- [ ] `/forge:collaborate brainstorm` enters an interactive loop where the agent asks clarifying questions and helps structure the user's raw thoughts.
- [ ] User exits the loop by signaling acceptance (e.g., "accept", "looks good"); the agent does not proceed to write without explicit acceptance.
- [ ] Accepted output is written to `.forge/collab/inputs-<handle>.md` with frontmatter `author: <github-handle>` and `timestamp: <ISO>`.
- [ ] The file is committed and pushed automatically (respecting R011 push config).
- [ ] A test simulates the loop with a scripted user, verifies an `inputs-<handle>.md` is produced only after acceptance.

### R003: AI consolidation of all inputs into unified brainstorm
A consolidation step reads every `.forge/collab/inputs-*.md` and produces `.forge/collab/consolidated.md` where each idea is annotated with its contributor(s).

**Acceptance Criteria:**
- [ ] `.forge/collab/consolidated.md` is produced from all present `inputs-*.md` files.
- [ ] Related ideas across authors are merged into unified topics.
- [ ] Every idea in the consolidation is annotated with at least one contributor handle.
- [ ] Multi-contributor sections list every contributor whose input supports that idea, not just one.
- [ ] A test with three overlapping-topic inputs produces a consolidation with correct multi-contributor annotations.

### R004: AI categorization of consolidated brainstorm into discrete tasks
The consolidated brainstorm is split into maximally granular tasks, each tagged with source contributors and marked as a decision task when it represents a contradiction.

**Acceptance Criteria:**
- [ ] Output is written to `.forge/collab/categories.json` as an array of task objects.
- [ ] Each task object contains: `id`, `title`, `category`, `source_contributors` (array of handles), `is_decision` (boolean).
- [ ] Categorization attempts a maximal split — a single input topic produces separate tasks where it supports them.
- [ ] Contradictions between contributors produce `is_decision: true` tasks listing all conflicting contributors.
- [ ] A test with a known three-topic brainstorm produces at least three distinct categories.

### R005: Similarity routing primitive
A shared function `routeToParticipant(text, participants)` scores each participant by similarity between the text and that participant's brain-dump contributions (LLM-as-classifier), combines with active-load balance, and returns a single handle or the sentinel `broadcast` on near-tie.

**Acceptance Criteria:**
- [ ] `scoreParticipant(text, participant)` returns a number in [0, 1] via an LLM classification call.
- [ ] A participant with no contributions scores exactly 0.
- [ ] Combined score uses the formula `similarity × (1 / (1 + active_tasks_on_machine))`.
- [ ] When the top two combined scores are within epsilon (default 0.05, configurable in `.forge/config.json`), the function returns `"broadcast"`.
- [ ] No seniority or role weighting exists; reordering participants does not change the winner except on exact ties (deterministic tiebreak).
- [ ] A test with three mock participants and a clearly-related target returns the highest-scoring expected participant.

### R006: Distributed claim queue with TTL lease
Tasks from the plan frontier are claimable by participants via the transport channel (Ably or polled git branch). Claims carry a TTL lease, are refreshed via heartbeat, and become reclaimable once stale.

**Acceptance Criteria:**
- [ ] Claim messages contain `task_id`, `claimant` (handle), and `lease_expiry` (ISO timestamp).
- [ ] Default lease TTL is 120 seconds; heartbeat cadence is 30 seconds. Both configurable in `.forge/config.json`.
- [ ] An agent treats a task as claimable only when no unexpired claim from another participant exists.
- [ ] A claim whose heartbeat has lapsed past `lease_expiry` is reclaimable without manual intervention.
- [ ] A test with two simulated agents racing for the same task asserts exactly one wins.

### R007: Per-task branches pushed to origin
Each active worktree is mirrored on origin under `forge/task/<task-id>` and updated after each checkpoint step so teammates observe in-flight code without waiting for merges.

**Acceptance Criteria:**
- [ ] On task start, the worktree branch is pushed to origin under the naming convention above.
- [ ] The branch is updated on origin after each Forge checkpoint step, not only on task completion.
- [ ] A teammate can `git fetch && git checkout forge/task/<task-id>` and observe the in-flight code.
- [ ] On task completion (successful squash-merge), the `forge/task/<task-id>` branch is deleted from origin.
- [ ] A test asserts the branch exists on origin mid-execution and is absent after completion.

### R008: Forward-motion decisions during execute
During the execute phase only, when the agent encounters a non-trivial decision point it selects the best option and writes a flag instead of blocking on a human. Brainstorm, plan, review, and verify phases retain their current blocking behavior.

**Acceptance Criteria:**
- [ ] Forward-motion decision logic is active only when the current phase is `executing` or its sub-phases.
- [ ] On a decision point, the agent writes a flag file at `.forge/collab/flags/F<num>.md` containing: the decision made, alternatives considered, rationale, task_id, timestamp.
- [ ] The agent continues execution without pause after writing the flag.
- [ ] During brainstorm, plan, reviewing_branch, and verifying phases, the agent's existing blocking behavior is unchanged.
- [ ] A test simulates a decision point during execute and verifies both the flag write and immediate continuation.

### R009: Flag review and override UX
Participants can list all open flags and override any of them; overriding propagates the updated decision to dependent tasks (triggering rework when the override invalidates prior assumptions).

**Acceptance Criteria:**
- [ ] `/forge:collaborate flags` lists all flags with status (`open`, `acknowledged`, `overridden`), decision, alternatives, and task id.
- [ ] `/forge:collaborate override <flag-id> <new-decision>` updates the flag and marks it `overridden`.
- [ ] Tasks that depend on an overridden flag are re-triggered for rework with the new decision.
- [ ] A test creates a flag, overrides it, asserts the dependent task reruns with the new decision.

### R010: Per-agent squash-merge with race-retry
Each executing agent squash-merges its own completed task to main (extending Forge's existing per-task squash-merge behavior); push rejection triggers pull + rebase + retry without user intervention.

**Acceptance Criteria:**
- [ ] On task verify-pass, the executing agent squash-merges to main and pushes origin/main.
- [ ] If `git push origin main` is rejected because another agent merged first, the agent runs `git pull --rebase origin main` and retries the push (up to three retries with linear backoff).
- [ ] No global `merge-tier` coordination command is introduced.
- [ ] A test with two simulated agents completing near-simultaneously asserts both merges land on main cleanly.

### R011: Inherit Forge push configuration
Push behavior for per-task branches and main merges follows Forge's existing auto-push configuration; collab mode introduces no new push semantics.

**Acceptance Criteria:**
- [ ] When `.forge/config.json` has auto-push enabled, per-task branch pushes and main merges occur without user prompt.
- [ ] When auto-push is disabled, the agent prompts the user on the executing machine before each push.
- [ ] Disabling auto-push does not change any collab coordination behavior (lease heartbeats, flag writes, etc.) — only the git push step is gated.
- [ ] A test with auto-push enabled confirms silent pushes; with disabled, confirms a prompt is issued.

### R012: Late-join mid-session
A participant who activates `/forge:collaborate` after the session has progressed pulls current state via git and subscribes to the transport channel, then can claim unclaimed tasks without extra coordination.

**Acceptance Criteria:**
- [ ] On activation, the session runs `git pull` on the current branch before any claim attempt.
- [ ] The session subscribes to the transport channel and reads the current claims snapshot before proposing its own claims.
- [ ] The new participant's agent skips already-claimed tasks and claims only the next available unblocked one.
- [ ] A test simulates a late-join mid-execute and asserts the new machine successfully claims the next unblocked task.

### R013: Realtime Ably default with polling fallback
The primary transport is Ably (sub-second latency). If `ABLY_KEY` is not set, the user is shown a short setup guide and offered a `--polling` fallback that uses a dedicated coordination branch on origin.

**Acceptance Criteria:**
- [ ] When `ABLY_KEY` is present in the environment, collab mode uses Ably for presence, claims, and flag notifications.
- [ ] When `ABLY_KEY` is absent, `/forge:collaborate` prints a setup guide (Ably signup URL, env-var instructions) and exits unless `--polling` was passed.
- [ ] The `--polling` mode uses a dedicated `forge/collab-state` branch on origin as the substrate: claims, presence, and flag pings are written as commits, polled every 2–3 seconds.
- [ ] `ably` is declared as a `peerDependency` (not a hard `dependency`); the module is imported only when realtime mode is active.
- [ ] A test exercises both transport paths, exchanging a claim message end-to-end and verifying receipt.

### R014: Research tasks distributed via the same claim queue as coding tasks
Categorization distinguishes research-type from coding-type tasks; both types flow through the same similarity-routed claim queue. Research outputs stream to git as they complete, visible to all participants.

**Acceptance Criteria:**
- [ ] Each task in `.forge/collab/categories.json` carries a `type` field with value `coding` or `research`.
- [ ] Research-type tasks are claimable via the same claim queue as coding tasks (R006 mechanism unchanged).
- [ ] When a research-type task completes, its result is written to `.forge/collab/research/<task-id>.md` and committed and pushed (respecting R011 push config).
- [ ] Peers running `git pull` see new research results without any extra sync mechanism.
- [ ] A test with mixed coding and research tasks in one categorization asserts both types successfully claim and complete through the same pipeline.

### R015: Active routing of questions and flags to targeted humans
Whenever the AI needs human input — round-1 clarifying questions during brainstorm, flag notifications during execute — the notification is actively delivered to the targeted human(s) via the transport channel, not only written to disk.

**Acceptance Criteria:**
- [ ] Each clarifying-question event during brainstorm publishes a transport message to the routed participant containing: question text, source section, link to the on-disk question file.
- [ ] Each flag write under R008 publishes a transport message to the target participants selected via `routeToParticipant` using the task's `source_contributors`.
- [ ] The message is delivered via Ably when the active transport is Ably; otherwise an append to the `forge/collab-state` polling branch serves as the equivalent delivery.
- [ ] Non-target participants receive no notification (routing is scoped, not broadcast).
- [ ] A test asserts that a flag write for a task with `source_contributors: [daniel]` produces exactly one targeted message addressed to `daniel` and no messages addressed to other participants.

### R016: Single-writer discipline for shared coordination state
Files that multiple agents could produce concurrently — the consolidated brainstorm, the categories file, flag IDs, routing logs — are either gated by a short-lived single-writer lease or restructured to eliminate contention entirely. This closes the one remaining merge-conflict surface for coordination state.

**Acceptance Criteria:**
- [ ] Writing `.forge/collab/consolidated.md` and `.forge/collab/categories.json` requires the calling agent to hold a transport-channel "consolidation-lease" (TTL ≤ 30s); concurrent attempts defer or abort cleanly rather than overwrite.
- [ ] Flag IDs are generated via a transport-coordinated monotonic counter or via UUIDs such that two agents producing flags simultaneously never collide on the filesystem.
- [ ] Append-only coordination logs are user-scoped by filename (e.g. `routing-log-<handle>.jsonl`) rather than a single shared file, eliminating cross-user append races entirely.
- [ ] A test simulating two agents attempting consolidation simultaneously asserts exactly one succeeds and the other defers gracefully.
- [ ] A test simulating two agents producing flags simultaneously asserts each flag lands at a distinct filesystem path.

## Future Considerations
- Presence-aware `/forge:watch` TUI showing who is online and on what task.
- Explicit hot-handoff (`/forge:collaborate handoff T004 lucas`) without waiting for TTL.
- Shared token-budget accounting across participants.
- Optional per-participant expertise tags as a boost factor on top of similarity routing.
- Structured per-user input templates to improve categorization accuracy.
