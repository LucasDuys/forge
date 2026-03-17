# Review Protocol

## Claude-on-Claude Review Standards

### What the Reviewer Checks
1. **Spec compliance** — Does the code satisfy every acceptance criterion for the task?
2. **Missing pieces** — Are there acceptance criteria with no corresponding implementation?
3. **Over-engineering** — Is there code that goes beyond what the spec requires?
4. **Edge cases** — Are obvious edge cases handled (nulls, empty, boundary values)?
5. **Security** — No injection, XSS, hardcoded secrets, or unsafe patterns
6. **Test quality** — Do tests actually test the right thing? Are assertions meaningful?

### What the Reviewer Does NOT Check
- Code style (trust linters)
- Performance optimization (unless spec requires it)
- Documentation (unless spec requires it)
- Refactoring opportunities in unrelated code

### Output Format
```
STATUS: PASS | ISSUES

ISSUES (if any):
- [CRITICAL] file:line — description
- [IMPORTANT] file:line — description
- [MINOR] file:line — description
```

### Severity Levels
- **CRITICAL**: Blocks completion. Spec requirement not met, security issue, broken functionality.
- **IMPORTANT**: Should fix. Missing edge case, questionable pattern, weak test.
- **MINOR**: Nice to fix. Naming, minor redundancy. Accept and move on if review budget is low.

### Review Loop Rules
- Max 3 review iterations per task
- After 3 iterations: accept with warnings, log unresolved issues
- Same implementer fixes issues (preserves context)
- CRITICAL issues must be fixed. IMPORTANT issues should be fixed. MINOR issues are optional.
