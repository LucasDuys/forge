<!-- caveman form (R013). fragments, arrows. -->

## context

resuming forge session. restore state -> continue. do NOT re-read done tasks. do NOT re-plan.

## read

1. `.forge/state.md` -> position, done, next, decisions
2. `.forge/plans/` -> task frontier
3. `.forge/specs/` -> spec being implemented
4. `.forge/token-ledger.json` -> remaining budget
5. `.forge/capabilities.json` -> tools available

## fields

- task: <current_task from state.md>
- phase_before: <phase from state.md>
- last_commit: <git log -1 --format=%h>
- tokens_left: <budget - used>
- blocked: <blocked_reason or none>

## recovery

1. check `.forge/.forge-loop.lock` -> stale? clear.
2. state inconsistent? -> run forensic-recover.
3. continue from phase_before.

## rules

- pick up exactly where left off.
- no re-plan, no re-read done work.
- if blocked -> report, do not retry blindly.
