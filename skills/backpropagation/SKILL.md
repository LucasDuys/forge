---
name: backpropagation
description: Trace runtime bugs back to spec gaps — identify missing acceptance criteria, update specs, generate regression tests, and detect patterns
---

# Backpropagation Skill

You are running the Forge backpropagation workflow. Your job is to trace a runtime bug back to a specification gap, update the spec to close that gap, generate a regression test, and log the correction for systemic pattern detection.

## Inputs

You will receive:
- **Bug description**: Natural-language description of the bug, or test failure output + test source code (from `--from-test` mode)
- **Test file path** (optional): Path to the failing test, if `--from-test` was used
- **Test source code** (optional): Contents of the failing test file
- **Spec files**: List of spec files in `.forge/specs/`

## Workflow

### Step 1: TRACE — Which spec?

Find the spec and requirement that should have prevented this bug.

1. Read all spec files in `.forge/specs/`. For each spec, extract:
   - Domain name (from frontmatter)
   - All R-numbered requirements and their acceptance criteria
   - The `linked_repos` field (to know which repos are involved)

2. Analyze the bug description (and test failure output if available) to determine:
   - What component or feature is affected?
   - What behavior went wrong?
   - What was the expected behavior?

3. Match the bug to the most relevant spec and requirement:
   - Use keyword matching between the bug description and requirement names/descriptions
   - Use code context: if the bug mentions specific files, endpoints, or functions, grep the spec for those references
   - If `--from-test` was used: read the test source code to understand which feature it tests, cross-reference with spec requirements

4. If no spec appears to cover this area at all, note this as a potential "missing requirement" gap and pick the closest spec by domain.

5. Present your finding to the user:
   > **Traced to:** `spec-{domain}.md` > **R{NNN}: {requirement name}**
   > **Reasoning:** {why this requirement is the match}

### Step 2: ANALYZE — What was missed?

Determine exactly what the spec's acceptance criteria failed to cover.

1. Read the identified requirement's acceptance criteria in full.

2. For each criterion, ask: "If this criterion were perfectly implemented and tested, would this bug still have occurred?"

3. Classify the gap into one of three types:

   | Gap Type | Definition | Example |
   |----------|------------|---------|
   | **Missing criterion** | The requirement exists but has no criterion covering this case | R001 requires user registration but no criterion tests duplicate email with different casing |
   | **Incomplete criterion** | A criterion exists but is too vague to catch this edge case | Criterion says "validate email format" but doesn't specify which RFC or edge cases |
   | **Missing requirement** | No requirement in any spec covers this behavior at all | No spec covers rate limiting, but the bug is a rate limit bypass |

4. Determine if this is a one-off edge case or a systemic pattern. Check:
   - Does `.forge/history/backprop-log.md` exist? If so, read it.
   - Have similar gaps been logged before? (Same pattern category: input validation, concurrency, error handling, integration)

5. Present the analysis:
   > **Gap type:** {missing_criterion | incomplete_criterion | missing_requirement}
   > **What was missed:** {specific description of what the acceptance criteria should have covered}
   > **Pattern category:** {input_validation | concurrency | error_handling | integration | other}

### Step 3: PROPOSE — Spec update

Write the proposed spec change and get user approval.

1. Draft the spec update based on gap type:

   - **Missing criterion**: Write a new acceptance criterion checkbox to add under the existing requirement.
   - **Incomplete criterion**: Write a replacement for the vague criterion with specific, testable language.
   - **Missing requirement**: Write a complete new R-numbered requirement with acceptance criteria. Use the next available R-number in the spec.

2. Present the proposed change clearly, showing before and after:

   **For missing criterion:**
   > **Proposed addition to R{NNN}:**
   > ```
   > - [ ] {New specific, testable criterion}
   > ```

   **For incomplete criterion:**
   > **Proposed replacement in R{NNN}:**
   > ```
   > Before: - [ ] {old vague criterion}
   > After:  - [ ] {new specific criterion}
   > ```

   **For missing requirement:**
   > **Proposed new requirement in spec-{domain}.md:**
   > ```markdown
   > ### R{NNN}: {Requirement Name}
   > {Description}
   > **Acceptance Criteria:**
   > - [ ] {Criterion 1}
   > - [ ] {Criterion 2}
   > ```

3. **Wait for explicit user approval.** Do NOT modify the spec file until the user says yes, approves, or confirms. If the user suggests edits, incorporate them and re-present.

4. Once approved, apply the change to the spec file using the Edit tool. Preserve all existing content — only add or modify the specific criterion/requirement.

### Step 4: GENERATE — Regression test

Write a test that would have caught this bug before it happened.

1. Determine the correct test location:
   - If `--from-test` was used: place the new test near the original test file (same directory or same test suite)
   - If no test file was provided: look at the project's existing test structure (use Glob to find test directories and naming patterns)
   - For multi-repo projects: use the `linked_repos` field from the spec and the repo config in `.forge/config.json` to determine which repo the test belongs in

2. Write the regression test:
   - **Tests the specific edge case or condition** that caused the bug
   - **Follows the project's existing test conventions** (framework, naming, structure)
   - **Includes a descriptive test name** that references the bug (e.g., `it('should reject duplicate email with different casing')`)
   - **Is minimal** — tests only the specific gap, not a broad integration test
   - **Has a comment** referencing the backprop: `// Regression: backprop #{N} — {brief description}`

3. Run the regression test to verify it currently **fails** (proving the bug exists and the test would have caught it):
   - If the test fails: good, this confirms it's a valid regression test
   - If the test passes: the bug may already be fixed, or the test doesn't accurately reproduce the issue. Adjust the test or note this to the user.

4. Present the test to the user:
   > **Regression test written:** `{test file path}`
   > **Test status:** {FAILS as expected / PASSES — bug may be fixed}
   > **What it verifies:** {description of what the test checks}

### Step 5: VERIFY — Optional re-run

Check if the user wants to verify the fix emerges from the updated spec.

1. Read `.forge/config.json` and check `backprop.re_run_after_spec_update`.

2. If `re_run_after_spec_update` is `true`:
   > The spec has been updated. You can run `/forge execute --filter {spec-domain}` to verify that the fix emerges naturally from the updated specification. This will re-execute tasks related to the affected requirement.

3. If `re_run_after_spec_update` is `false` (or not set):
   > **Tip:** You can run `/forge execute --filter {spec-domain}` to verify the fix emerges from the updated spec alone. Set `backprop.re_run_after_spec_update: true` in `.forge/config.json` to enable automatic re-execution after backprop.

### Step 6: LOG — Record in backprop log

Append the backpropagation record to the history log.

1. If `.forge/history/backprop-log.md` does not exist, create it with a header:
   ```markdown
   # Backpropagation Log

   Records of bugs traced back to spec gaps, with corrective actions taken.

   ---
   ```

2. Determine the next backprop ID:
   - Read the existing log and find the highest `id:` number
   - If the log is empty or new, start at 1

3. Append a new entry using the template from `templates/backprop-report.md`:

   ```markdown
   ---
   id: {N}
   date: {YYYY-MM-DD}
   spec: {spec-domain}
   requirement: {R_ID}
   gap_type: {missing_criterion|incomplete_criterion|missing_requirement}
   pattern: {pattern_category}
   ---

   # Backprop #{N}

   ## Bug Description
   {Original bug description or test failure summary}

   ## Root Spec
   - Spec: {spec file path}
   - Requirement: {R_ID}: {requirement name}
   - Gap: {What the acceptance criteria missed}

   ## Spec Update
   {The new or modified acceptance criterion that was applied}

   ## Regression Test
   - File: {test file path}
   - Verifies: {What the test checks}

   ## Pattern
   - Category: {pattern category}
   - Occurrences: {total count of this pattern in the log}
   - Systemic fix suggested: {yes/no}
   ```

4. **Pattern detection** — After logging, count occurrences of the same pattern category across all entries in the log:
   - If 3 or more backprops share the same pattern category, suggest a systemic change:

   > **Pattern detected:** You've had {N} **{pattern_category}** gaps. This is a systemic pattern.
   >
   > **Suggested systemic fix:** Add the following as a standard brainstorming question in future `/forge brainstorm` sessions:

   Use the pattern-to-question mapping from `references/backprop-patterns.md`:

   | Pattern (3+ occurrences) | Suggested Brainstorming Question |
   |--------------------------|----------------------------------|
   | input_validation | "What are the edge cases for input formats? (unicode, empty, boundary values, special characters)" |
   | concurrency | "What happens with concurrent access? (race conditions, ordering, idempotency)" |
   | error_handling | "What failure modes exist? (network timeout, disk full, rate limit, partial failure)" |
   | integration | "What cross-component contracts exist? (data formats, timing dependencies, versioning)" |

   If the pattern is "other", suggest the user define a custom question based on the recurring theme.

## Key Principles

- **Trace before fixing** — always identify the spec gap before writing code. The spec is the source of truth.
- **User approves spec changes** — never modify a spec without explicit approval. The user owns the spec.
- **Regression tests prove the gap** — the test must fail before the fix to confirm it would have caught the bug.
- **Patterns drive systemic improvement** — individual fixes are good, but identifying patterns makes the whole process better over time.
- **Minimal changes** — add only what's needed to close the gap. Don't refactor the entire spec.
