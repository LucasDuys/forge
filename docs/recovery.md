# Crash Recovery and Forensic Resume

Sessions can crash. Machines can reboot. Context windows can run out mid-task. Forge handles all of these without losing work.

**Lock file heartbeat** -- every stop-hook invocation updates `.forge/.forge-loop.lock` with a fresh timestamp. After 5 minutes with no heartbeat, the lock is considered stale and can be taken over.

**Task checkpoints** -- the executor writes `.forge/progress/{task-id}.json` after each major step: spec loaded, research done, planning done, implementation started, tests written, tests passing, review pending. On resume, execution picks up from the last checkpoint step.

**Forensic recovery** -- `/forge resume` runs a recovery scan before continuing:

```
$ /forge resume

Recovery report:
  committed tasks:    T001 T002 T003 T004 T005 T006 T007
  resume point:       T008 (implementation_started)
  active checkpoints: 1 (T008)
  stale lock:         taken over from pid 14231
  orphan worktrees:   none
  session budget:     156400 / 500000 used
  warnings:           none
  needs_human:        false

Continuing execution from T008...
```

Recovery never auto-deletes user work. Orphan worktrees are flagged with warnings but require explicit action to remove.

Budget exhaustion has a dedicated recovery path: the handoff doc at `.forge/resume.md` explains why execution halted and what config change unblocks continuation.

See also: [checkpoint-schema.md](../references/checkpoint-schema.md).
