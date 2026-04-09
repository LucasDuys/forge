# Backpropagation

When a bug is found post-execution, `/forge backprop` traces it back to the spec gap that allowed it.

1. **TRACE** -- Which spec and R-number does this bug map to?
2. **ANALYZE** -- Gap type: missing criterion, incomplete criterion, or missing requirement
3. **PROPOSE** -- Spec update for human approval
4. **GENERATE** -- Regression test that would have caught it
5. **VERIFY** -- Run test (should fail, confirming the gap). Optionally re-execute affected tasks.
6. **LOG** -- Record in backprop history. After 3+ gaps of the same category, suggest systemic changes to future brainstorming questions.

## Automatic mode (`auto_backprop: true`, default)

By default Forge runs backprop automatically when test failures are detected during executor runs:

1. The `hooks/auto-backprop.js` PostToolUse hook watches Bash tool outputs.
2. When a recognized test runner (vitest, jest, pytest, cargo test, go test, npm test, mocha, node --test, node run-tests.cjs) emits failure markers, the hook captures the failure context (failure lines + 4 lines of context above and 8 below + the last 5 summary lines, capped at 4 KB).
3. The hook writes `.forge/.auto-backprop-pending.json` and flips `auto_backprop_pending: true` in `state.md` frontmatter — the TUI dashboard's BACKPROP banner lights up at this point.
4. On the next stop-hook iteration, the loop engine prepends an `AUTO-BACKPROP TRIGGERED` directive to the routed prompt with the captured failure context, instructing the executor to run the 5-step backprop workflow before continuing the current task. If the executor determines the failure is environmental (network, missing tool, flaky external service) it logs that and skips backprop.
5. The flag file is deleted atomically — the same failure never re-triggers.

**Idempotency:** if a flag already exists, new failures do not overwrite it. The queued failure must be handled (or manually cleared via `rm .forge/.auto-backprop-pending.json`) before another can be captured.

**Opt out** in three ways:

- Set `auto_backprop: false` in `.forge/config.json`
- Set `FORGE_AUTO_BACKPROP=0` in your environment
- Remove the `auto-backprop` entry from `hooks/hooks.json`

Manual `/forge backprop "description"` or `/forge backprop --from-test path/` is always available regardless of the auto setting — useful for bugs that surfaced in production rather than during the executor's own test runs.
