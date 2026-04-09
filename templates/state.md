---
phase: idle
spec: null
current_task: null
task_status: null
iteration: 0
tokens_used: 0
tokens_budget: 500000
depth: standard
autonomy: gated
handoff_requested: false
review_iterations: 0
debug_attempts: 0
blocked_reason: null
lock_holder: null
checkpoint_id: null
---

<!--
caveman form (R013). fragments, dropped articles, arrows.
parser only reads frontmatter + section headers. body is opaque.
old verbose state.md still works -> backward compat.
token savings: phase doc 2200 -> 1195 chars (~46% cut). total 3263 -> 2000 (~21%).
-->

## done

<!-- example: - T014 complete. /forge status unified. no regressions. commit abc1234. -->

## in-flight

<!-- example: - T028 executing. caveman rewrite of state.md + resume.md. -->

## next

<!-- example: - T029 -> writeState produces caveman output. -->

## decisions

<!-- example: - bcrypt rounds = 12. matches spec R001. -->

---

## phases

`phase` = state machine pointer. stop hook reads -> routes. agents never write phase. engine writes atomic.

### stable

- `idle` -> nothing flight. `/forge execute` -> executing.
- `executing` -> commit -> reviewing_branch. no review -> verifying. frontier empty -> idle.
- `reviewing_branch` -> pass -> verifying. fail -> executing + notes.
- `verifying` -> pass -> executing (next). fail -> reviewing_branch.

### new

- `budget_exhausted` -> tokens gone. write handoff.md, stop. trig: tokens_used >= budget. exit: resume only.
- `conflict_resolution` -> worktree merge conflict. fallback sequential. trig: merge conflict markers. exit: linearize -> executing.
- `recovering` -> resume rebuilding from lock + checkpoint + git. trig: state missing/stale. exit: routes to reconstructed phase.
- `lock_conflict` -> other forge holds lock. trig: lock + PID alive. exit: lock free -> idle. else stuck til user clears.

### rules

1. phase atomic. agents never touch.
2. back compat: missing lock_holder/checkpoint_id = null. legacy unchanged.
3. new phases terminal per iter. need trigger (budget, lock, resume) or fallback (sequential).

full diagram -> `references/state-machine.md`.
