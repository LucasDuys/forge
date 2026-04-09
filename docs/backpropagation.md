# Backpropagation

When a bug is found post-execution, `/forge backprop` traces it back to the spec gap that allowed it.

1. **TRACE** -- Which spec and R-number does this bug map to?
2. **ANALYZE** -- Gap type: missing criterion, incomplete criterion, or missing requirement
3. **PROPOSE** -- Spec update for human approval
4. **GENERATE** -- Regression test that would have caught it
5. **VERIFY** -- Run test (should fail, confirming the gap). Optionally re-execute affected tasks.
6. **LOG** -- Record in backprop history. After 3+ gaps of the same category, suggest systemic changes to future brainstorming questions.
