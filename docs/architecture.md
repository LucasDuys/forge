# Architecture

Forge runs three nested loops. Each has its own circuit breakers and progression logic.

## The Three-Tiered Loop

**Outer loop: Phase progression.** Controls which spec is active and which phase runs next. Phases: `idle` > `executing` > `reviewing_branch` > `verifying` > `idle`. New in v2.1: `budget_exhausted`, `conflict_resolution`, `recovering`, `lock_conflict`. Driven by the stop-hook state machine.

**Middle loop: Task progression.** Within a spec, tasks advance through the dependency DAG. Streaming topological dispatch: tasks start the instant their specific dependencies complete, not when the entire tier finishes. 20-40% faster than tier-gated waves.

**Inner loop: Quality iteration.** Each task cycles through `implement > test > fix (max 3) > debug > Codex rescue > redecompose > blocked`. Circuit breakers at every transition prevent infinite loops.

## The Self-Prompting Engine

The stop hook (`hooks/stop-hook.sh`) intercepts every Claude exit. It reads state from `.forge/.forge-loop.json`, calls `routeDecision()` in `forge-tools.cjs` (a 200+ line state machine), and either blocks exit with the next prompt or allows it. Claude never needs a human to tell it what to do next.

```
Claude acts > attempts exit > stop hook fires > routeDecision() > block with next prompt > repeat
```

New in v2.1: the stop hook also updates a lock-file heartbeat on every invocation (5-minute stale threshold), detects session ownership, and honors the `budget_exhausted` phase for clean exit without a blocking prompt.

Completion signal: Claude outputs `<promise>FORGE_COMPLETE</promise>` only when all tasks are complete and verified. The hook detects it, generates a summary, releases the lock, deletes the loop file, and allows exit.

## Execution Flow

```
/forge execute
      |
  ACQUIRE lock, register session
      |
  LOAD plan DAG + artifact contracts
      |
  STREAMING SCHEDULER -----> picks tasks whose deps are satisfied
      |                       scores complexity (0-20)
      |                       routes to haiku / sonnet / opus
      |                       creates task worktree
      |                       assembles context bundle
      |
      +---> RESEARCHER: deep research (official docs, papers, codebase conventions)
      |         |
      +---> EXECUTOR: implement + test (TDD at thorough depth)
      |         |  writes checkpoints at each step
      |         |  works inside task worktree
      |         |
      |     REVIEWER: spec compliance + blast radius + conventions
      |         |
      |     (optional) CODEX REVIEW: adversarial cross-model check
      |         |
      |     ARTIFACT WRITE: caveman-form structured output
      |         |
      |         +---> Pass: squash-merge worktree, atomic commit, unlock dependents
      |         +---> Fail: debug > Codex rescue > re-decompose > block
      |         +---> Conflict: transition to conflict_resolution phase
      |
      +---> BUDGET MONITOR: per-task gate at 80% warn, 100% escalate
      |
      +---> CONTEXT MONITOR: save handoff at 60%, resume in new session
      |
      v
  VERIFIER: goal-backward verification (existence > substantive > wired > runtime)
      |
  DONE: all tasks committed, branch ready, lock released
```

## Cross-Cutting Skills (v0.2.0)

Three skills that run automatically across all agents. No explicit invocation needed.

**Karpathy Guardrails** (`skills/karpathy-guardrails/SKILL.md`):
- Inlined into executor, reviewer, and planner agent definitions
- Executor: checks for ambiguity before coding, builds only what AC requires, traces every changed line
- Reviewer: flags over-engineering, scope creep, silent assumptions, goal misalignment as IMPORTANT
- Planner: rejects gold-plated tasks, enforces one concern per task

**Graphify Integration** (`skills/graphify-integration/SKILL.md`):
- Auto-detected by brainstorm, plan, and execute commands (checks for `graphify-out/graph.json`)
- Stored in `state.md` frontmatter as `knowledge_graph:` path
- Planner: aligns task boundaries with community clusters, orders by node connectivity
- Researcher: queries graph for architecture context before external docs
- Reviewer: graph-based blast radius analysis
- Executor: focused context from relevant subgraph instead of full codebase scan
- Degrades gracefully: no graph = standard behavior unchanged

**DESIGN.md Support** (`skills/design-system/SKILL.md`):
- Auto-detected by brainstorm, plan, and execute commands (checks for DESIGN.md in project root)
- Stored in `state.md` frontmatter as `design_system:` path
- Brainstorm: asks about design requirements, can generate DESIGN.md from brand catalogs
- Planner: tags UI tasks with `design:`, adds design verification task
- Executor: loads design tokens as implementation constraints
- Reviewer: design compliance pass checking palette, typography, spacing
- Degrades gracefully: no DESIGN.md = standard behavior unchanged

## Workflow Enforcement (v0.2.0)

The pipeline is strictly sequential: brainstorm -> plan -> execute. Enforced at multiple levels:
- **Spec approval gate**: Only brainstorming writes `status: approved` after explicit user approval
- **Frontier requirement**: `/forge execute` validates each spec has a frontier
- **Programmatic validation**: `validateWorkflowPrerequisites()` runs in `setup-state` before execution starts
- **State machine phases**: `brainstorming` and `planning` are formal phases
- **DESIGN.md gate** (forge-self-fixes R002): When the brainstorming Q&A identifies a brand-based aesthetic, `forge-tools brainstorm-check-design` must return exit 0 (DESIGN.md exists) before Phase 4 proposal emission. Prevents UI work from proceeding with approximated brand tokens.
- **Path-validation gate with creation-target syntax** (forge-self-fixes R001): `forge-tools forge-speccer-validator` separates preconditions (plain backticks) from creation targets (`{create:path}`). Greenfield specs no longer trip the gate on files they themselves create.
- **Structural AC verifier** (forge-self-fixes R006): `forge-tools verify-structural-acs --spec ... --artifact dist/index.html` actually executes querySelector-shaped ACs against the built output instead of trusting task-registry counts.

## Collaborative Mode (`/forge:collaborate`)

A parallel execution path that lets N>=2 participants drive the same spec from different machines without a server. The design is **files + git + a transport** — no database, no central coordinator, no invite mechanism.

### Session identity

`sessionIdFromOrigin()` in `scripts/forge-collab.cjs` derives a 12-hex code from `git remote get-url origin`. Every clone of the same repo produces the same code. Joining = running `/forge:collaborate join`; leaving = `/forge:collaborate leave`. No invite codes, no OAuth, no shared secrets.

### Transport (pick one)

Forge defines a transport interface with five methods: `read`, `cas`, `del`, `list`, plus `publish`/`subscribe`/`sendTargeted` for message delivery. Two concrete backends satisfy it:

| Backend | Latency | Setup | Mechanics |
|---|---|---|---|
| `ably` | Sub-second | `npm install ably` + `export ABLY_KEY=...` | WebSocket pub/sub; `cas_propose`/`cas_won` publish-ack election resolves claim races |
| `polling` | ~2.5s | None (zero-setup default) | Dedicated `forge/collab-state` git branch; CAS via CAS-like commit-rebase retry |

`selectTransportMode(env)` picks `ably` when `ABLY_KEY` is set, else `polling`, unless `--polling` forces it. `createTransport(mode, opts)` returns an object implementing the full interface; callers never touch the backends directly.

### Shared vs local state

The `.forge/collab/` directory is carved out of the default `.forge/` gitignore (`GITIGNORE_CARVE_OUT_BLOCK` in `forge-collab.cjs`). A nested `.gitignore` at `.forge/collab/.gitignore` re-ignores the per-machine markers.

| File | Scope | Purpose |
|---|---|---|
| `brainstorm/inputs-<handle>.md` | Shared (committed) | Per-user brainstorm dump; no merge conflict because filename is user-scoped |
| `consolidated.md`, `categories.json` | Shared (committed) | Merged spec + category breakdown, written under `consolidation` lease |
| `flags/F<id>.md` | Shared (committed) | Forward-motion flags — AI decisions that would normally block |
| `questions/Q<id>.md` | Shared (committed) | Clarifying questions routed to a specific participant |
| `participant.json` | Local | `{handle, session_id, started}`; ignored in nested .gitignore |
| `.enabled` | Local | Atomic "collab mode on" marker |
| `flag-emit-log-<handle>.jsonl` | Local | Append-only log of flags this participant emitted |

### Lifecycle ordering invariants

**Start order** (`/forge:collaborate start`):
1. Ensure `.forge/collab/` exists.
2. Write `participant.json` with handle + session ID + start time.
3. Write `.enabled` as the LAST filesystem action (atomic flip).

If step 2 succeeds but step 3 fails, classifier returns `stale_participant` — recoverable by `/forge:collaborate recover` (resets the partial state).

**Leave order** (`/forge:collaborate leave`):
1. Delete `.enabled` FIRST (atomic "collab off" flip).
2. Release every active claim held by this handle.
3. Disconnect transport.
4. Delete `participant.json` LAST.

If step 1 succeeds but step 4 fails, classifier returns `stale_enabled` — recoverable. A crash between 1 and 4 is always safe because the executor guard reads `.enabled` first.

### Claim queue

`claimTask(transport, taskId, claimant, opts)` is a thin wrapper around `tryAcquireLease` with a 120s TTL default. Two parallel calls on the same taskId resolve via:

- **Ably**: publish `cas_propose`, every client queues proposals, the authoritative echoer publishes `cas_won` after a 150ms election window. Sorted by (ts asc, clientId asc) — ties go to the alphabetically lowest clientId.
- **Polling**: commit-rebase retry loop on `forge/collab-state`. Whoever lands the commit first wins; losers see the non-fast-forward, rebase, and re-propose against the updated state.

Exactly one proposal wins. The loser gets `{acquired:false, reason:'lost_race', holder:<winner-lease>}`. Heartbeats refresh the lease every 30s via `heartbeatTaskClaim`; an expired lease (no heartbeat for TTL) returns the task to the claimable pool.

Important: as of forge-self-fixes-2 R010, `tryAcquireLease` / `refreshLease` / `releaseLease` are `async` and `await` the transport's `cas`/`del`. The prior sync-assignment bug (treating Ably's Promise return as a truthy win) is fixed. See `tests/collab-claim-race.test.cjs` for the regression coverage.

### Forward-motion flags

During `/forge:execute`, any decision the AI would normally pause on (library choice, architectural tiebreaker, ambiguous requirement) becomes a **flag** instead:

1. AI picks the best default it can defend.
2. Writes `.forge/collab/flags/F<id>.md` with `{phase, task_id, author, decision, alternatives, rationale, source_contributors}`.
3. `git commit` + `git push` per the project's `auto_push` config.
4. Appends one line to `flag-emit-log-<handle>.jsonl` (local audit trail).
5. Executor continues with the chosen default.

Teammates review with `/forge:collaborate flags` and override with `/forge:collaborate override F<id> "<new decision>"`. Overriding marks the flag `overridden` and re-triggers the dependent task on the next execute iteration. The AI never blocks on a sleeping teammate.

Flag routing (`routeClarifyingQuestion`) uses a lightweight Jaccard scorer over participant `contributions` text vs the flag's decision text; sends a targeted `flag-ping` via `sendTargeted` to the most-relevant participant; falls back to broadcast only when no participant scores above the epsilon threshold. This is the `spec-collab R015` targeted-delivery guarantee.

### Polling-branch resolution

`_resolvePollingBranch(cwd)` (forge-self-fixes-2 R011) reads the repo's actual upstream:
1. `git symbolic-ref --short refs/remotes/origin/HEAD` → `origin/<default>` → strip prefix
2. `git rev-parse --abbrev-ref HEAD@{upstream}` → `origin/<tracking>` → strip prefix
3. `git rev-parse --abbrev-ref HEAD` → current branch
4. Literal `main` as last resort

`lateJoinBootstrap` and `squashMergeAndPush` route through this helper. Repos with `master`, `trunk`, or any non-`main` default now work without caller intervention.

### Recovery

`classifyCollabState('.forge', {cwd})` returns one of:
- `inactive` — both markers absent, no collab
- `healthy` — both markers present, session ID matches origin
- `stale_participant` — `participant.json` exists, `.enabled` missing (start crashed before flip, OR leave partial)
- `stale_enabled` — `.enabled` exists, `participant.json` missing (leave crashed mid-way)
- `session_mismatch` — both present but participant's recorded session ID differs from current origin's hash (repo re-pointed)

`recoverCollabState('.forge', {apply:true})` applies the appropriate remedy per class. Never destructive without the `apply:true` flag; dry-run returns the intended `actions` array for user confirmation.

### When to use which mode

- **Solo mode** (`/forge:brainstorm` → `/forge:plan` → `/forge:execute`): single contributor, tightest loop, no consolidation overhead. Recommended default.
- **Team mode** (`/forge:collaborate`): 2+ participants on the same feature, or a scenario where async override-after-the-fact is better than sync wait-for-approval. Execute never blocks on a human.

Hybrid is supported: collaborative brainstorm + solo execute, or solo brainstorm + collaborative execute. The phase enforcement is symmetric.

See also: [state-machine.md](../references/state-machine.md) for full phase transition diagram. Subcommand reference in [collaborate.md](collaborate.md).
