---
description: "Review an existing branch holistically before merging — blast radius, conventions, security, and spec compliance"
allowed-tools: ["Read(*)", "Bash(*)", "Grep(*)", "Glob(*)", "Agent(forge:forge-reviewer,forge:forge-verifier,forge:forge-researcher)", "WebSearch(*)", "WebFetch(*)"]
---

# Forge Review Branch

Review an unmerged branch holistically. Dispatches parallel review agents that examine the total diff (not commit-by-commit), check blast radius, verify conventions, and validate security — following Anthropic's multi-agent review architecture.

## Usage

```
/forge review-branch [FLAGS]
```

## Parse Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--base BRANCH` | `main` | Base branch to diff against |
| `--head BRANCH` | current HEAD | Branch to review (defaults to current branch) |
| `--spec SPEC` | *(none)* | Path to spec file for acceptance criteria verification |
| `--depth quick\|standard\|thorough` | `standard` | Review depth |
| `--fix` | *(off)* | Automatically fix CRITICAL issues found |
| `--comment` | *(off)* | Post results as GitHub PR comment via `gh` |

## Pre-flight Check

1. Verify this is a git repository. If not: `Not a git repository.`
2. Verify the base branch exists: `git rev-parse --verify {base}`. If not: `Base branch '{base}' not found.`
3. Verify there are changes to review: `git diff --name-only {base}...{head}`. If empty: `No changes between {base} and {head}. Nothing to review.`
4. Read `.forge/capabilities.json` if it exists (for tool-aware review).

## Step 1: Gather Branch Context

Run these commands to understand the full scope of changes:

```bash
# Total diff stats
git diff --stat {base}...{head}

# All changed files
git diff --name-only {base}...{head}

# Commit log for the branch
git log --oneline {base}...{head}

# Number of commits
git rev-list --count {base}...{head}
```

Present a brief summary:
```
Forge Review Branch
===================================
Base:    {base}
Head:    {head}
Commits: {N}
Files:   {M} changed ({additions}+, {deletions}-)
```

## Step 2: Convention Inference

Before reviewing, understand the codebase's conventions (same as forge-executor Step 4):

1. Check for CLAUDE.md, .editorconfig, linting config
2. If absent, auto-detect from existing code:
   - Import style (ESM vs CJS)
   - Naming conventions
   - Error handling patterns
   - Test framework and location
   - File organization
3. Store inferred conventions for use by review agents

## Step 3: Dispatch Parallel Review Agents

Following Anthropic's multi-agent review pattern, dispatch these agents in parallel:

### Agent 1: Spec Compliance Reviewer (if --spec provided)
Dispatch **forge-reviewer** with:
- The spec file's R-numbered requirements and acceptance criteria
- The full list of changed files
- Task: verify every acceptance criterion is met by the branch's changes

### Agent 2: Blast Radius Analyzer
For each changed file that exports functions/classes/types:
1. Find all files in the codebase that import from it: `grep -r "from.*{file}" src/`
2. Check if exported signatures changed (parameters, return types, removed exports)
3. For each dependent: check if it handles the change correctly
4. Flag breaking changes as CRITICAL, untested dependents as IMPORTANT

Output:
```
BLAST RADIUS:
- {file}: {N} dependents
  - {dependent}: uses {export} — SAFE|BREAKING|NEEDS_TEST
- Total breaking changes: {N}
- Untested dependents: {N}
```

### Agent 3: Convention & Quality Reviewer
Dispatch **forge-reviewer** in code quality mode:
- Check all changed files against inferred conventions
- Flag style inconsistencies with the existing codebase
- Check for security issues (OWASP top 10 patterns)
- Check for stubs, TODOs, placeholder code
- Check test quality (specific assertions, not toBeTruthy)

### Agent 4: Research Validator (thorough depth only)
Dispatch **forge-researcher** to verify:
- Are security-sensitive patterns (auth, crypto, input validation) following best practices?
- Are framework patterns matching official documentation?
- Are there known vulnerabilities in approaches used?

## Step 4: Verification Pass

After parallel agents complete, run verification checks:

1. **Aggregate findings** — collect all issues from all agents
2. **Deduplicate** — same issue flagged by multiple agents counts once
3. **Validate each finding** (Anthropic's verification pattern):
   - For each CRITICAL or IMPORTANT finding, re-read the actual code at the flagged location
   - Attempt to disprove the finding — is there context that makes it correct?
   - Only retain findings with confidence >= 80%
4. **Run affected tests** (if test runner available):
   ```bash
   # JavaScript
   npx jest --changedSince={base} --passWithNoTests
   # Python
   python -m pytest --co -q  # collect affected tests
   ```

## Step 5: Produce Report

Present results in this format:

```
Forge Branch Review: {head} -> {base}
===================================

VERDICT: SAFE TO MERGE | ISSUES FOUND | CRITICAL ISSUES

Summary:
  Commits reviewed:  {N}
  Files changed:     {M}
  Issues found:      {total} ({critical} critical, {important} important, {minor} minor)
  Blast radius:      {N} dependent files, {B} breaking changes
  Convention match:  {percentage}%
  Tests:             {pass/fail status}

SPEC COMPLIANCE: (if --spec provided)
  - [x] R001/AC1: {criterion} — {file:line}
  - [ ] R002/AC3: {criterion} — MISSING

CRITICAL ISSUES:
  1. [{file}:{line}] {description}
     Why: {explanation}
     Fix: {suggestion}

IMPORTANT ISSUES:
  1. [{file}:{line}] {description}
     Why: {explanation}

BLAST RADIUS:
  - {file}: {N} dependents — {SAFE|BREAKING details}

CONVENTION VIOLATIONS:
  - {file}:{line}: {convention violated} (codebase uses {pattern}, branch uses {different pattern})
```

## Step 6: Auto-Fix (if --fix flag)

If `--fix` is provided and CRITICAL issues were found:

1. For each CRITICAL issue, attempt to fix it:
   - Read the flagged code
   - Apply the suggested fix
   - Re-run affected tests
2. Stage and commit fixes: `fix: address review findings from /forge review-branch`
3. Re-run the review (iteration 2) to verify fixes resolved the issues
4. Max 2 fix iterations (then report remaining issues for human review)

## Step 7: Post to PR (if --comment flag)

If `--comment` is provided and `gh` CLI is available:

1. Find the PR for the current branch: `gh pr view --json number`
2. Post the review summary as a PR comment: `gh pr comment {number} --body "{report}"`
3. If CRITICAL issues exist, add a review: `gh pr review {number} --request-changes --body "{critical issues}"`
4. If no CRITICAL issues: `gh pr review {number} --approve --body "Forge review: SAFE TO MERGE"`

## Integration with Forge Execution Loop

This command also runs automatically during `/forge execute` when:
- All tasks in a spec are complete
- Before phase verification
- The state machine routes to `review_branch` state

In the loop context:
- Base branch is read from `.forge/config.json` (default: main)
- Head branch is the current working branch
- Spec is read from `.forge/specs/` for the current spec
- Depth matches the execution depth
- Results are logged to `.forge/branch-reviews/{spec}-review.md`
- If CRITICAL issues found: loop pauses for human review (regardless of autonomy mode)

## Output

After review completes, present the verdict clearly:

- **SAFE TO MERGE**: No critical or important issues. Convention compliance high. Blast radius contained.
- **ISSUES FOUND**: Important issues exist but no critical blockers. Human should review before merging.
- **CRITICAL ISSUES**: Must-fix problems found. Do not merge without resolving.
