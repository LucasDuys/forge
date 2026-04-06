# Verification and Circuit Breakers

## Goal-Backward Verification

The verifier works backwards from the spec, not forwards from the tasks. Four levels:

| Level | Checks |
|-------|--------|
| **Existence** | Do expected files, functions, routes, migrations exist? |
| **Substantive** | Real code, not stubs? Detects TODO, hardcoded returns, empty catch, skipped tests, placeholder components. |
| **Wired** | Module imported where used? Route registered? Middleware applied? Dead code = not satisfied. |
| **Runtime** | If Playwright: E2E tests. If Stripe: webhook handlers. If Vercel: deploy preview. If gh: CI status. |

## Circuit Breakers

Seven levels of circuit breakers prevent infinite loops and runaway spending. Each escalates to the next when exhausted.

| Level | Trigger | Threshold | Action |
|-------|---------|-----------|--------|
| 1 | Test failures | 3 consecutive | Enter DEBUG mode |
| 2 | Debug attempts | 2 failures | Codex rescue (different model, fresh perspective) |
| 3 | Debug exhaustion | 3 total | Re-decompose task into sub-tasks (T005.1, T005.2) |
| 4 | Review iterations | 3 passes | Accept with warnings, move on |
| 5 | No progress | 2 identical snapshots | Block for human |
| 6 | Max iterations | 100 (configurable) | Save state, force exit |
| 7 | Token budget | 100% of session or per-task | Graceful handoff to `.forge/resume.md` |
