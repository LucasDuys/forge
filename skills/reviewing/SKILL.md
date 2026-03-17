---
name: reviewing
description: Claude-on-Claude code review protocol — reviews implementation against spec requirements and code quality standards
---

# Reviewing Skill

This skill defines the two-pass review workflow that validates implementation quality before a task is marked complete. It is dispatched after a task is implemented and tests pass (at depth >= standard).

## Inputs

You will receive:
- **Implemented code**: The files created or modified by the executor for this task
- **Spec requirements**: The R-numbered requirements and acceptance criteria this task must satisfy
- **Task definition**: From the frontier file, including task name, dependencies, and repo
- **Review iteration**: Which review pass this is (1, 2, or 3)

## Two-Pass Review Workflow

### Pass 1: Spec Compliance Review (mandatory for depth >= standard)

This is the primary review pass. It verifies that the implementation actually satisfies the spec.

**Procedure:**

1. **Read the actual code.** Do NOT trust the implementer's report or summary. Open every file that was created or modified and read it.
2. **List every acceptance criterion** from the spec requirements assigned to this task.
3. **Check each criterion against the code:**
   - Is there code that implements this criterion?
   - Does the implementation match what the criterion specifies (not just approximate it)?
   - Is the criterion fully satisfied, or only partially?
4. **Flag missing implementations** — acceptance criteria with no corresponding code.
5. **Flag extra features** — code that goes beyond what the spec requires. Over-engineering wastes tokens and introduces unnecessary complexity. If the spec says "return 201 with {id, email}", the code should not also return `created_at`, `updated_at`, and `role` unless the spec asks for them.
6. **Flag misunderstandings** — code that implements something different from what the criterion describes. Example: spec says "hash with bcrypt (min 12 rounds)" but code uses SHA-256.

**Output for Pass 1:**

```
## Spec Compliance

STATUS: PASS | ISSUES

CHECKED CRITERIA:
- [x] R001/AC1: POST /auth/register accepts {email, password} — implemented in src/controllers/auth.ts:45
- [ ] R001/AC2: Password hashed with bcrypt (min 12 rounds) — MISSING, no hashing found
- [x] R001/AC3: Returns 201 with JWT + refresh token — implemented in src/controllers/auth.ts:67

ISSUES (if any):
- [CRITICAL] src/controllers/auth.ts — R001/AC2: No password hashing implemented. Raw password stored directly.
- [IMPORTANT] src/controllers/auth.ts:67 — Returns extra fields (created_at, role) not in spec. Over-engineering.
```

### Pass 2: Code Quality Review (follows spec compliance)

This pass reviews the quality of the implementation itself. Only run this if Pass 1 does not have CRITICAL issues (fix those first).

**Check each of these areas:**

1. **Naming clarity** — Are variables, functions, and files named clearly? Can a reader understand what they do without reading the implementation?
2. **Design patterns** — Does the code follow the patterns established in the codebase? Does it match the conventions from the repo's CLAUDE.md?
3. **Test quality** — Do tests actually assert meaningful behavior? Are assertions specific (not just "test passes" or "no error thrown")? Do tests cover the acceptance criteria?
4. **Error handling** — Are errors handled appropriately? Are error messages helpful? Are edge cases covered (null, empty, boundary values)?
5. **Security** — No SQL/NoSQL injection vectors. No hardcoded secrets, API keys, or passwords. No unsafe patterns (eval, innerHTML with user input, unsanitized query params).
6. **Maintainability** — Is the code reasonably structured? Would another developer understand it? Are there obvious code smells (god functions, deep nesting, copy-paste duplication)?

**Output for Pass 2:**

```
## Code Quality

STATUS: PASS | ISSUES

ISSUES (if any):
- [IMPORTANT] src/services/auth.ts:23 — Missing error handling for database connection failure. Will crash with unhandled promise rejection.
- [MINOR] src/controllers/auth.ts:12 — Variable `d` should be named `userData` or similar for clarity.
- [MINOR] src/tests/auth.test.ts:45 — Test "should register user" only asserts status code, not response body. Weak assertion.
```

## Combined Review Output

The final review output combines both passes:

```
STATUS: PASS | ISSUES

ISSUES (if any):
- [CRITICAL] file:line — description
- [IMPORTANT] file:line — description
- [MINOR] file:line — description
```

## Severity Levels

- **CRITICAL**: Blocks completion. Spec requirement not met, security vulnerability, broken functionality. Must be fixed before the task can proceed.
- **IMPORTANT**: Should fix. Missing edge case handling, questionable design pattern, weak test assertions, over-engineering. Fix unless review budget is exhausted.
- **MINOR**: Nice to fix. Naming improvements, minor redundancy, style preferences. Accept and move on if review budget is low.

## Review Loop Rules

The review loop is bounded by circuit breakers to prevent infinite cycling:

1. **Max 3 review iterations per task.** After 3 rounds of review-fix-review, accept the code with warnings and move on. Log unresolved issues in the execution summary.
2. **Same implementer fixes issues.** The executor that wrote the code fixes the review issues. This preserves context and avoids re-reading the entire implementation.
3. **CRITICAL issues must be fixed.** If a CRITICAL issue remains after 3 iterations, the task is flagged as blocked and escalated to the user.
4. **IMPORTANT issues should be fixed.** Fix in iterations 1-2. In iteration 3, accept remaining IMPORTANT issues with warnings.
5. **MINOR issues are optional.** Fix if budget allows. In iteration 2+, skip all MINOR issues and focus on CRITICAL and IMPORTANT only.
6. **Shrinking scope per iteration.** Each iteration should address fewer issues than the previous one. If the issue count is not decreasing, something is wrong — flag for human review.

### Iteration Behavior

| Iteration | Focus | Accept Condition |
|-----------|-------|------------------|
| 1 | All severity levels | PASS = no CRITICAL or IMPORTANT issues |
| 2 | CRITICAL + IMPORTANT only | PASS = no CRITICAL issues, IMPORTANT count decreased |
| 3 (final) | CRITICAL only | Accept with warnings for any remaining IMPORTANT/MINOR |

### After Review Completes

- **PASS**: Task is marked as reviewed and clean. Proceed to commit and advance.
- **ISSUES resolved in loop**: Task is marked as reviewed after fixes. Proceed to commit.
- **ISSUES after 3 iterations**: Task is marked as reviewed with warnings. Log unresolved issues. Proceed to next task.

## What the Reviewer Does NOT Check

- **Code style** — trust linters and formatters. Do not flag indentation, semicolons, or bracket placement.
- **Performance optimization** — unless the spec explicitly requires specific performance characteristics.
- **Documentation** — unless the spec explicitly requires documentation.
- **Refactoring opportunities in unrelated code** — stay focused on the task's scope.

## Dispatching Agents

This skill orchestrates the review by dispatching agents:

1. **forge-reviewer** — Dispatched to perform the two-pass review. Receives the code, spec, and iteration number. Returns the combined review output.
2. If issues are found, the **forge-executor** is re-dispatched with the issue list to fix them.
3. After fixes, **forge-reviewer** is dispatched again for the next iteration.
4. This loop continues until PASS or iteration 3 is reached.

The stop hook manages this loop via the state machine. When state is "tests passing + not reviewed", it feeds the review prompt. When state is "review issues + fix attempts < 3", it feeds the fix prompt.
