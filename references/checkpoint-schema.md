# Checkpoint Schema for Resumable Tasks

This document defines the JSON schema for task checkpoints written to `.forge/progress/{task-id}.json`. Checkpoints let Forge resume in-flight work after a context reset, crash, or explicit pause without losing state.

Covers requirement R008 of the gsd2-caveman-integration spec.

## Purpose

A checkpoint captures the minimum state required to resume a task without re-reading the entire spec, re-running research, or repeating completed work. The executor (and `/forge resume`) treats the checkpoint as the source of truth for "where am I in this task right now."

## File Location

```
.forge/progress/{task-id}.json
```

One file per in-flight task. Files are created when execution begins and deleted on successful completion. Surviving files indicate interrupted work.

## Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_id` | string | yes | Task identifier such as `"T001"`. Must match the frontier task ID. |
| `task_name` | string | yes | Human readable task name pulled from the frontier. |
| `spec_domain` | string | yes | Spec the task belongs to, for example `"gsd2-caveman-integration"`. Used by resume to locate the spec file. |
| `started_at` | string (ISO 8601) | yes | Timestamp of first checkpoint write. Never updated after creation. |
| `last_updated` | string (ISO 8601) | yes | Timestamp of the most recent checkpoint write. Updated on every write. |
| `current_step` | string (enum) | yes | Step the executor most recently completed. See enum values below. |
| `next_step` | string (enum) | yes | Step that should run next on resume. See enum values below. |
| `artifacts_produced` | array of strings | yes | Absolute or repo-relative paths of files written so far. Empty array if none. |
| `context_bundle` | object | yes | Key facts the executor needs to resume. Free-form keys but typically contains `icp`, `decisions`, `constraints`, `dependencies_consumed`, and `notes`. |
| `worktree_path` | string or null | yes | Path to the git worktree if the task runs in one, otherwise `null`. |
| `depth` | string (enum) | yes | Execution depth: `"quick"`, `"standard"`, or `"thorough"`. |
| `token_usage` | number | yes | Total tokens consumed on this task across all resume sessions. Integer. |
| `error_log` | array of objects | yes | Failures encountered. Each entry has `timestamp` (ISO 8601), `step` (enum), `message` (string), and optional `stack` (string). Empty array if none. |

### Enum: `current_step` and `next_step`

Both fields draw from the same ordered enum:

1. `spec_loaded` -- spec read, requirements parsed
2. `research_done` -- forge-researcher completed (or skipped)
3. `planning_done` -- implementation approach decided
4. `implementation_started` -- first code written
5. `tests_written` -- test cases authored
6. `tests_passing` -- targeted tests green
7. `review_pending` -- ready for forge-reviewer
8. `review_passed` -- review complete with no blocking issues
9. `verification_pending` -- final acceptance criteria check queued
10. `complete` -- task done, checkpoint will be deleted

### Valid Transitions

`next_step` must be reachable from `current_step` along this graph. Skips are allowed where the depth profile permits (e.g. `quick` may skip `research_done` and `review_pending`).

| current_step | allowed next_step values |
|--------------|--------------------------|
| `spec_loaded` | `research_done`, `planning_done` |
| `research_done` | `planning_done` |
| `planning_done` | `implementation_started` |
| `implementation_started` | `tests_written`, `tests_passing` |
| `tests_written` | `tests_passing` |
| `tests_passing` | `review_pending`, `verification_pending` |
| `review_pending` | `review_passed` |
| `review_passed` | `verification_pending` |
| `verification_pending` | `complete` |
| `complete` | (terminal, file is deleted) |

Backward transitions are permitted only when an `error_log` entry is appended in the same write. For example, a failing review may move `current_step` from `review_pending` back to `implementation_started` with an error entry explaining why.

## Lifecycle

1. **Create** -- The executor writes the initial checkpoint immediately after loading the spec, with `current_step: "spec_loaded"` and `started_at == last_updated`.
2. **Update** -- After each major step, the executor rewrites the file atomically (write to temp, rename) with a new `last_updated` timestamp, an updated `current_step`, the next intended `next_step`, and any new `artifacts_produced`, `token_usage`, or `error_log` entries.
3. **Read on resume** -- `/forge resume` scans `.forge/progress/` for any files, picks the task whose `last_updated` is most recent (or follows frontier order), loads the `context_bundle`, and starts execution at `next_step`.
4. **Read on status** -- `/forge status` enumerates `.forge/progress/` to list every in-flight task with `task_id`, `current_step`, `last_updated`, and `token_usage` for visibility.
5. **Delete** -- On successful completion (`current_step == "complete"`), the executor deletes the checkpoint file as the final action of the task. The presence of a checkpoint file always indicates incomplete or interrupted work.

## Example

A standard-depth task partway through implementation, after tests have been written but before they pass:

```json
{
  "task_id": "T012",
  "task_name": "Implement worktree pool manager",
  "spec_domain": "gsd2-caveman-integration",
  "started_at": "2026-04-05T09:14:22Z",
  "last_updated": "2026-04-05T09:47:08Z",
  "current_step": "tests_written",
  "next_step": "tests_passing",
  "artifacts_produced": [
    "src/worktree/pool.ts",
    "src/worktree/lease.ts",
    "src/__tests__/worktree-pool.test.ts"
  ],
  "context_bundle": {
    "icp": "Forge users running parallel tasks across 4 to 8 worktrees on a single machine",
    "decisions": [
      "Use file-based locking via .forge/worktree-locks/{id}.lock to avoid a daemon process",
      "Pool size defaults to min(8, cpu_count) and is configurable in .forge/config.json"
    ],
    "constraints": [
      "Must work on Windows without symlinks",
      "Lease timeout fixed at 30 minutes per task"
    ],
    "dependencies_consumed": ["T009: progress-store API", "T011: config loader"],
    "notes": "Lease renewal logic deferred to T013 per planner guidance"
  },
  "worktree_path": "C:/Users/20243455/.forge-worktrees/T012",
  "depth": "standard",
  "token_usage": 18420,
  "error_log": [
    {
      "timestamp": "2026-04-05T09:31:55Z",
      "step": "implementation_started",
      "message": "Initial lock acquisition raced with sibling test; switched to proper-lockfile package"
    }
  ]
}
```

## Machine Parseability Notes

Downstream code in T009 (progress store) will read and write these files. To keep parsing trivial:

- All timestamps are ISO 8601 with `Z` suffix (UTC). No local time, no offsets.
- Enums are lowercase snake_case strings, never localized.
- Numbers are plain integers or floats, no string-encoded numbers.
- `null` is only valid for `worktree_path`. Every other field uses an empty string, empty array, or empty object instead of `null`.
- Files must be valid JSON (no trailing commas, no comments). Pretty-printing with two-space indentation is recommended for human inspection.
- Writes must be atomic: write to `.forge/progress/{task-id}.json.tmp` then rename, so a crash mid-write never leaves a partial file.
