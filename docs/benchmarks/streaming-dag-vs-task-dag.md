---
benchmark: streaming-dag-vs-task-dag
spec: forge-v03-gaps R006
date: 2026-04-21
branch: fix/collab-and-forge-audit
---

# Streaming DAG vs Task-level DAG

Comparison of Forge 0.2 (tier-by-tier, task-level dependencies) versus Forge 0.3 (per-acceptance-criterion streaming DAG with provisional/verified states).

Not a comparison against serial execution — that comparison isn't interesting since Forge 0.2 already parallelised within tiers. The real question is: how much does AC-level granularity buy us on top of what the old DAG already did?

## Model

Task timing is the Forge executor's 8-checkpoint lifecycle, based on observed cadence during this cycle:

| Step | Duration | Cumulative |
|------|----------|------------|
| spec_loaded | 0.5 min | 0.5 |
| research_done | 1.5 min | 2.0 |
| planning_done | 1.0 min | 3.0 |
| implementation_started | 2.5 min | **5.5 — first code lands** |
| tests_written | 1.5 min | 7.0 |
| tests_passing | 3.0 min | **10.0 — tests green tail** |
| review_pending | 0.5 min | 10.5 |
| review_passed | 1.5 min | **12.0 — task DONE** |

Typical AC fire times within a task:

| AC | Fires at | Meaning |
|----|----------|---------|
| R001.AC1 | 5.5 min | function scaffolded + compiles |
| R001.AC2 | 5.5 min | exports wired, callable from downstream |
| R001.AC3 | 10 min | tests passing |
| R001.AC4 | 12 min | review passed (same as DONE) |

## Results — 5-task chain where downstream needs upstream.R001.AC2

Chain pattern: `T001 → T002 → T003 → T004 → T005`. Each downstream only needs the upstream's function to exist (AC2), not its test tail.

**Old DAG (task-level `depends: T00n`, wait for full DONE):**
```
T001 starts at t=0
T002 starts at t=12
T003 starts at t=24
T004 starts at t=36
T005 starts at t=48
Total wall-clock: 60 min
```

**New DAG (AC-level `depends: T00n.R001.AC2`, streaming provisional):**
```
T001 starts at t=0
T002 starts at t=5.5
T003 starts at t=11
T004 starts at t=16.5
T005 starts at t=22
Total wall-clock: 34 min
```

**Saved: 26 min (43.3% faster).**

## Sensitivity — where in the task lifecycle does the depended-on AC fire?

Same 5-task chain, varying the AC position.

| AC position | N=3 | N=5 | N=10 | N=20 | Speedup vs old DAG |
|---|---|---|---|---|---|
| Early (t=2, type-defs ready) | 16 | 20 | 30 | 50 | 56% → 79% |
| Mid (t=5.5, function exists) | 23 | 34 | 61.5 | 116.5 | 36% → 51% |
| Late (t=10, tests passing) | 32 | 52 | 102 | 202 | 11% → 16% |
| End (t=12, same as full DONE) | 36 | 60 | 120 | 240 | 0% (equivalent to old) |

All times in minutes of total wall-clock.

## Conditions under which streaming DAG DOES NOT help

- **Downstream deps point at upstream.R_final.AC_last** — equivalent to old task-level DONE. Scheduler behaves identically.
- **Planner wrote only task-level edges** (`depends: T001`) with no AC granularity. Back-compat path treats the whole task as a single AC. Zero speedup, zero regression.
- **Chain length 1** (no downstream) — nothing to speculate on.

## Conditions under which streaming DAG pays off

- **Long chains (N=5 to 20)** where downstream needs early artifacts (function signatures, type definitions, exports, interface shapes) but does not care about the upstream's test tail or review cycle.
- **Fan-out patterns** where one upstream produces an AC consumed by 3-5 downstream tasks that can all start provisionally.
- Concrete example from this cycle: the Spec A collab chain (T001 → T013 → T019 → T022 → T024 → T026 → T027 → T028). 8 tasks serial on `scripts/forge-collab.cjs`. If we had written AC-level deps on the chain, wall-clock would have dropped from ~96 min to ~55 min (43% saved). We did not use AC-level deps in this cycle, so the cycle itself did not benefit — the feature is shipped for future frontiers.

## Safety costs

The streaming scheduler carries three bounded costs:

1. **Provisional work cap**: maximum 3 in-flight provisional downstream tasks per upstream chain. Exceeding the cap waits.
2. **Rollback cost**: if upstream regresses an AC that downstream consumed, the downstream task is marked STALE and fully redone. Worst-case redo = 12 min per task at this timing model.
3. **Fallback-to-sequential**: after 2 verification failures on a chain, streaming is disabled for that spec (`streaming_disabled: max_failures_exceeded` logged) and the chain falls back to task-level DONE gating.

Net expected overhead from rollback is low because (a) worktree isolation keeps provisional work off main, (b) the planner constrains parallel tasks to disjoint file sets, so AC regressions are rare when they do happen.

## How to reproduce

```bash
node -e "
const dag = require('./scripts/forge-streaming-dag.cjs');
// See scripts/forge-streaming-dag.cjs for the scheduler interface.
// simulate() functions live at docs/benchmarks/scripts/ (future work).
"
```

The scheduler core (`scripts/forge-streaming-dag.cjs`) has 16 passing tests at `tests/streaming-dag.test.cjs` that exercise every state transition. The numbers in this doc are derived from applying the timing model to the scheduler's dispatch decisions; no real `/forge:execute` run has been measured yet. A real-execution benchmark is future work.

## Caveats

1. Timing model is from observed Forge cadence during this cycle, not a formal measurement across many runs.
2. Benchmarks assume no rollback — real-world speedup is bounded below by the rollback frequency.
3. The comparison assumes the planner emits AC-level edges where appropriate. If planners keep defaulting to task-level edges, streaming is a no-op.
