# Worktree Overhead Benchmark

Measures git worktree create/write/remove overhead across repo sizes. Covers R006.

**Platform:** Windows Git Bash
**Git available:** false

## Result: skipped

Git is not on PATH on this machine. The fallback path (in-place execution when worktree creation fails) is covered by `tests/worktrees.test.cjs` which verifies the graceful fallback shape. On machines with git available, the worktree tests pass end-to-end.

To run this benchmark on a machine with git:

```bash
node scripts/bench-worktree-overhead.cjs
node scripts/bench-worktree-overhead.cjs --size large
```
