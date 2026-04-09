# Worktree Isolation

Each task runs in its own git worktree at `.forge/worktrees/{task-id}/`. On success, the worktree's commits are squash-merged into the parent branch with an atomic commit message:

```
forge(auth): implement JWT refresh rotation [T007]
```

On failure, the worktree is removed without touching the parent branch. Your main branch only ever sees green, reviewed, verified code.

Worktree creation is skipped for tasks that don't need it:
- `depth: quick` with a single file change
- Pure research or spec tasks with zero files touched
- Configured opt-out via `use_worktrees: false`

Merge conflicts trigger a transition to `conflict_resolution` phase. The worktree is preserved for human inspection. The scheduler falls back to sequential execution for the remaining tier.

Parallel tasks with overlapping file targets are automatically serialized. Disjoint tasks run truly parallel in separate worktrees.

See also: [benchmarks/worktree-overhead.md](benchmarks/worktree-overhead.md).
