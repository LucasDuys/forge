# Forge State Machine

The Forge loop engine is a finite state machine. The current state lives in
`.forge/state.md` under the `phase` frontmatter field. The stop hook reads this
field on every Claude Code stop event and routes to the next action.

This document is the authoritative reference for valid phases and transitions.
Tests in `tests/state-machine/` should encode each transition listed here.

## Phases

| Phase                 | Category    | Agent active | Terminal? |
|-----------------------|-------------|--------------|-----------|
| `idle`                | stable      | none         | no        |
| `executing`           | stable      | executor     | no        |
| `reviewing_branch`    | stable      | reviewer     | no        |
| `verifying`           | stable      | verifier     | no        |
| `budget_exhausted`    | new         | none         | yes (until resume)   |
| `conflict_resolution` | new         | none         | no (auto-recovers)   |
| `recovering`          | new         | none         | no (auto-routes)     |
| `lock_conflict`       | new         | none         | yes (until lock free)|

## Transition Diagram

```
                        +---------+
                        |  idle   |<-------------------+
                        +---------+                    |
                             |                         |
                  /forge execute                       |
                             |                         |
                             v                         |
                       +-----------+                   |
        +------------->| executing |-------------------+
        |              +-----------+   frontier empty
        |                    |
        |                    | commit
        |                    v
        |            +------------------+
        |            | reviewing_branch |
        |            +------------------+
        |               |          |
        |      review   |          | review
        |        pass   |          | fail
        |               v          v
        |         +-----------+   (back to executing
        |         | verifying |    with reviewer notes)
        |         +-----------+
        |             |    |
        |    verify   |    | verify fail
        |    pass     |    v
        +-------------+    (back to reviewing_branch)
              next task

   --- Cross-cutting transitions (from any active phase) ---

   any phase  --(token budget hit)-->  budget_exhausted
                                            |
                                            | /forge resume + new budget
                                            v
                                       recovering --> executing | idle

   executing  --(parallel merge fails)--> conflict_resolution
                                            |
                                            | linearize + re-dispatch
                                            v
                                        executing

   startup    --(loop.lock held by live PID)--> lock_conflict
                                            |
                                            | lock released
                                            v
                                          idle

   /forge resume --(state.md missing/stale)--> recovering
                                            |
                                            | rebuild from lock + checkpoints + git
                                            v
                                  executing | reviewing_branch | verifying | idle
```

## Transition Table

### Stable transitions

| From               | Trigger                          | To                 |
|--------------------|----------------------------------|--------------------|
| `idle`             | `/forge execute`                 | `executing`        |
| `executing`        | task committed                   | `reviewing_branch` |
| `executing`        | frontier empty                   | `idle`             |
| `reviewing_branch` | review pass                      | `verifying`        |
| `reviewing_branch` | review fail                      | `executing`        |
| `verifying`        | verify pass, more tasks          | `executing`        |
| `verifying`        | verify pass, frontier empty      | `idle`             |
| `verifying`        | verify fail                      | `reviewing_branch` |

### New transitions

| From            | Trigger                                          | To                    |
|-----------------|--------------------------------------------------|-----------------------|
| any active      | `tokens_used >= tokens_budget`                   | `budget_exhausted`    |
| `budget_exhausted` | `/forge resume` with raised budget            | `recovering`          |
| `executing`     | parallel worktree merge conflict                 | `conflict_resolution` |
| `conflict_resolution` | tasks linearized, re-dispatched            | `executing`           |
| startup         | `.forge/loop.lock` held by live PID              | `lock_conflict`       |
| `lock_conflict` | lock released or cleared by user                 | `idle`                |
| `/forge resume` | `state.md` missing, stale, or inconsistent       | `recovering`          |
| `recovering`    | reconstruction complete, work in flight          | `executing`           |
| `recovering`    | reconstruction complete, mid-review              | `reviewing_branch`    |
| `recovering`    | reconstruction complete, mid-verify              | `verifying`           |
| `recovering`    | reconstruction complete, nothing pending         | `idle`                |

## Invariants

1. **Single writer**: only the loop engine (stop hook) writes the `phase`
   field. Agents may write other frontmatter fields (e.g. `task_status`,
   `tokens_used`) but never `phase`.
2. **Lock-guarded**: any phase change must be made while holding
   `.forge/loop.lock`. The `lock_conflict` phase exists precisely because two
   processes cannot legally write `phase` at the same time.
3. **Backward compatible**: a state.md authored before the new phases were
   added (lacking `lock_holder` and `checkpoint_id` fields) is still valid.
   Missing fields default to null, and the legacy idle/executing/reviewing/
   verifying loop runs unchanged.
4. **Terminal phases require external input**: `budget_exhausted` and
   `lock_conflict` cannot exit on their own. The stop hook must observe an
   external change (resume command, lock release) before transitioning.
5. **Recovery is idempotent**: running `/forge resume` multiple times must
   converge on the same reconstructed phase.

## Caveman-Form Migration Note (T028, R013)

The `templates/state.md` template was rewritten in caveman form to cut tokens
on every state machine read/write. The parser in `forge-tools.cjs`
(`parseFrontmatter`) only reads YAML frontmatter and treats the markdown body
as opaque -- it does not care whether section content is verbose prose or
caveman fragments. As a result:

- Older verbose `state.md` files (pre-T028) are still fully readable. The
  parser extracts the same frontmatter keys regardless of body style.
- New `state.md` files written by `writeState` will be in caveman form going
  forward (T029 makes the writer produce caveman output).
- Section headers (`## done`, `## in-flight`, `## next`, `## decisions`) stay
  parseable because they are markdown ATX headings, identical in both styles.
- Phase doc section reduced from ~2200 chars to ~1195 chars (~46% cut).
  Total template reduced from 3263 to ~2000 chars (~21% cut).

## Test Hooks

Each row in the transition tables above corresponds to at least one test case
in `tests/state-machine/`. Add a test when adding a new transition. Tests
should:

- Set up a state.md with the source phase
- Apply the trigger (mock token usage, plant a lock file, etc.)
- Run the loop engine entry point
- Assert the resulting phase matches the table
