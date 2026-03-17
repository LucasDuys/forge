# Backpropagation Patterns

## How to Trace a Bug to a Spec Gap

1. **Identify the behavior** — What went wrong? What was expected?
2. **Find the spec** — Which spec domain does this belong to?
3. **Find the requirement** — Which R-number requirement is closest?
4. **Check acceptance criteria** — Is there a criterion that should have caught this?
5. **Classify the gap**:
   - **Missing criterion**: The requirement exists but doesn't test this case
   - **Incomplete criterion**: The criterion exists but is too vague
   - **Missing requirement**: No requirement covers this behavior at all

## Common Gap Patterns

### Input Validation Gaps
- Special characters not tested (unicode, emoji, SQL chars)
- Boundary values not specified (max length, min value, empty)
- Format variations not covered (email with +, phone with country code)

### Concurrency Gaps
- Race conditions not specified (simultaneous writes)
- Ordering assumptions not documented
- Idempotency not required

### Error Handling Gaps
- Failure modes not specified (network timeout, disk full, rate limit)
- Error message content not defined
- Retry behavior not documented

### Integration Gaps
- Cross-component contract not specified
- Data format assumptions not documented
- Timing dependencies not captured

## When to Suggest Systemic Changes
After 3+ backprops of the same pattern category, suggest adding a standard
brainstorming question for that category. For example:
- 3 input validation gaps → add "What are the edge cases for input formats?"
- 3 concurrency gaps → add "What happens with concurrent access?"
