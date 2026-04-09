# Forge Test Suite

Forge ships a zero-dependency test runner that drives the suites under `tests/`.
No npm install. No jest. Just `node`.

## Run everything

```
node scripts/run-tests.cjs
```

The runner discovers every `tests/*.test.cjs` file, executes it as a separate
child process, and prints a per-file summary plus a grand total.

## Run a single file

```
node tests/budget.test.cjs
```

Each file is self-contained and calls `runTests()` at the bottom, so it can be
run on its own without the runner.

## Filter by name

```
node scripts/run-tests.cjs --filter locks
```

Runs only test files whose path contains the given substring.

## Verbose output

```
node scripts/run-tests.cjs --verbose
```

Forwards each test file's stdout (including individual `PASS` lines) to the
runner output. Useful when chasing a flaky test.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | All tests in all files passed |
| 1    | One or more tests failed, or runner could not start |

## Test layout

| File | Coverage |
|------|----------|
| `tests/budget.test.cjs`      | Per-task token ledger, depth resolution, status report (T006) |
| `tests/locks.test.cjs`       | Lock acquire/release/heartbeat/stale takeover (T007) |
| `tests/state.test.cjs`       | `writeState` legacy and partial forms, frontmatter round-trip (T007) |
| `tests/checkpoints.test.cjs` | Checkpoint store: write/read/update/list/delete (T009) |
| `tests/worktrees.test.cjs`   | Worktree skip rules and graceful git fallback (T008) |
| `tests/headless.test.cjs`    | Headless query state shape, timing, exit codes (T011) |
| `tests/route.test.cjs`       | Route decision and budget gating (T010) |
| `tests/frontier.test.cjs`    | Frontier markdown parsing |

## Test helper

`tests/_helper.cjs` exports a tiny test framework:

```js
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');

suite('my feature', () => {
  test('does the thing', () => {
    const { forgeDir } = makeTempForgeDir({ config: { token_budget: 100 } });
    // ... use forgeDir as a fresh sandbox
  });
});

runTests();
```

`makeTempForgeDir` creates a fresh `.forge/` under `os.tmpdir()` and registers
it for automatic cleanup on process exit. Tests never touch the real `.forge/`
directory.

## Conventions

- Pure Node.js built-ins only. No new dependencies.
- Cross-platform. Git tests skip with a clear reason if git is not on `PATH`.
- Deterministic. No assertions on wall-clock time, only on relative ordering.
- Total runtime under 30 seconds on a cold cache.
