---
name: karpathy-guardrails
description: Behavioral guardrails for Forge agents based on Andrej Karpathy's principles — prevents over-engineering, silent assumptions, scope creep, and unfocused execution
---

# Karpathy Guardrails Skill

Behavioral guardrails that all Forge agents MUST follow during execution. These four principles prevent the most common failure modes in AI-generated code: silent assumptions, over-engineering, scope creep, and unfocused execution.

These guardrails are referenced by forge-executor, forge-reviewer, and forge-planner agents. They are not optional.

## Principle 1: Think Before Coding

**Rule:** Surface assumptions explicitly. Never hide confusion behind code.

- When a spec requirement is ambiguous, flag it as NEEDS_CONTEXT rather than guessing
- When multiple valid interpretations exist, list them in the checkpoint context_bundle and ask
- Push back on unclear acceptance criteria before implementing them
- If you are uncertain about the right approach, state your uncertainty in state.md under "Key Decisions" before proceeding

**Anti-pattern:** Implementing "export users" without asking about scope, format, fields, or volume.
**Correct pattern:** Flag ambiguity, present interpretations, get clarification.

## Principle 2: Simplicity First

**Rule:** Write the minimum code that solves only the stated problem.

- No speculative features beyond what the acceptance criteria require
- No abstractions for single-use code paths
- No "flexibility" or "configurability" unless the spec explicitly requests it
- No error handling for impossible scenarios (trust internal code and framework guarantees)
- Self-check: "Would a senior engineer say this is overcomplicated?"

**Anti-pattern:** Building abstract strategy patterns and dataclass configurations for a simple discount calculator.
**Correct pattern:** Three lines of direct logic that solve the stated requirement.

**Token impact:** Simpler code uses fewer tokens to generate, review, and verify. Over-engineering wastes budget across the entire pipeline (executor + reviewer + verifier).

## Principle 3: Surgical Changes

**Rule:** Modify only what is necessary to fulfill the task's requirements.

- Every changed line must trace directly to an acceptance criterion
- Do not "improve" adjacent code, comments, or formatting
- Do not refactor code that is not broken
- Match existing code style, even if it differs from modern best practices
- Clean up only your own orphaned imports and variables
- Preserve pre-existing dead code unless the spec says to remove it

**Anti-pattern:** Fixing an empty email validation bug while also adding username length validation, reformatting the file, and upgrading the test framework.
**Correct pattern:** Fix only the email validation. One bug, one fix, one commit.

**Reviewer enforcement:** The forge-reviewer MUST flag any changes that do not trace to an acceptance criterion as IMPORTANT (over-engineering).

## Principle 4: Goal-Driven Execution

**Rule:** Transform vague tasks into verifiable success criteria before writing code.

- "Add validation" becomes "Write tests for invalid inputs, then make them pass"
- "Fix the bug" becomes "Write a test that reproduces it, then make it pass"
- "Refactor X" becomes "Ensure tests pass before and after"
- For multi-step tasks: state a brief plan with steps and verification gates

**Why this works:** LLMs excel at looping until specific goals are met. Clear success criteria enable independent verification and reduce back-and-forth clarification.

## How Agents Apply These Guardrails

### forge-executor
- Before writing code: check if requirements are clear (Principle 1)
- During implementation: build only what acceptance criteria require (Principle 2)
- During commit: verify every changed line traces to a criterion (Principle 3)
- For complex tasks: define success criteria upfront, verify at each step (Principle 4)

### forge-reviewer
- Flag over-engineering: code beyond spec requirements (Principle 2)
- Flag scope creep: changes not traced to acceptance criteria (Principle 3)
- Flag silent assumptions: implementation choices not justified by spec (Principle 1)
- Verify goal alignment: does the code achieve what the criterion states? (Principle 4)

### forge-planner
- Reject gold-plated task lists: only tasks that map to R-numbers (Principle 2)
- Keep tasks focused: one concern per task, not bundled improvements (Principle 3)
- Define clear task boundaries: each task has verifiable completion criteria (Principle 4)

## Observable Outcomes

When these guardrails are working:
- Fewer unnecessary diff changes in commits
- Reduced code over-engineering and wasted complexity
- Clarifying questions occur before implementation, not after mistakes
- Cleaner commits with minimal scope creep
- Lower token consumption per task (less code to generate, review, verify)
