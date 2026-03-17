---
description: "Trace a bug back to a spec gap and generate regression tests"
argument-hint: "\"DESCRIPTION\" [--from-test PATH]"
allowed-tools: ["Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "Bash(*)", "Agent(*)"]
---

# Forge Backprop

Trace a runtime bug back to a specification gap, update the spec, generate a regression test, and log the correction for pattern detection.

## Pre-flight Check

1. Verify `.forge/` exists. If it does not, stop and tell the user:
   > `.forge/` not found. Run `/forge brainstorm` first to generate specifications.

2. Verify `.forge/specs/` contains at least one `spec-*.md` file. If none found, stop and tell the user:
   > No specs found in `.forge/specs/`. Run `/forge brainstorm` first to create specifications. Backprop requires existing specs to trace bugs against.

3. Ensure `.forge/history/` exists. If not, create it:
   ```bash
   mkdir -p .forge/history
   ```

## Parse Arguments

Parse from `$ARGUMENTS`:

| Input | Format | Description |
|-------|--------|-------------|
| Bug description | Quoted string (first positional argument) | Natural-language description of the bug |
| `--from-test PATH` | Path to a test file | Run this test, capture failure output, use it as the bug description |

**Exactly one** of the two inputs must be provided. If neither is found, stop and tell the user:
> Usage: `/forge backprop "description of bug"` or `/forge backprop --from-test path/to/failing-test`

### --from-test mode

If `--from-test PATH` is provided:
1. Verify the test file exists. If not, stop and tell the user the file was not found.
2. Detect the test runner from the file extension and project config:
   - `.test.ts`, `.test.js`, `.spec.ts`, `.spec.js` — look for Jest, Vitest, or Mocha in package.json
   - `.test.py`, `test_*.py` — use pytest
   - `.test.go` — use `go test`
   - Other — ask the user how to run it
3. Run the test, capturing stdout and stderr.
4. Read the test source code.
5. Combine the failure output and source code into the bug description context for the skill.

## Invoke Backpropagation

Invoke the **forge:backpropagation** skill with:
- The bug description (either from the quoted argument or from the test failure output)
- The test file path (if `--from-test` was used)
- The test source code (if `--from-test` was used)
- The list of spec files in `.forge/specs/`

The skill handles the full workflow: trace to spec, analyze the gap, propose a spec update, generate a regression test, and log the correction.
