---
description: "Show Forge usage guide"
---

# Forge Help

Display the following help text to the user:

## Commands

**`/forge brainstorm [topic]`** — Turn an idea into concrete specs
  - `--from-code` — Generate specs from existing codebase
  - `--from-docs path/` — Generate specs from PRDs, API docs, research files

**`/forge plan`** — Decompose specs into task frontiers
  - `--filter <name>` — Only plan a specific spec
  - `--depth quick|standard|thorough` — Set task granularity

**`/forge execute`** — Run the autonomous implementation loop
  - `--autonomy full|gated|supervised` — Set pause behavior
  - `--max-iterations N` — Safety cap on loop iterations
  - `--token-budget N` — Max tokens to spend
  - `--depth quick|standard|thorough` — Override task depth

**`/forge resume`** — Continue after context reset or interruption

**`/forge backprop "bug description"`** — Trace a bug back to a spec gap
  - `--from-test path/` — Trace from a failing test

**`/forge status`** — Show current progress and budget

**`/forge review-branch`** — Review an unmerged branch before merging
  - `--base main` — Base branch to diff against
  - `--spec path/` — Spec file for acceptance criteria verification
  - `--depth quick|standard|thorough` — Review depth
  - `--fix` — Auto-fix critical issues
  - `--comment` — Post results as GitHub PR comment

**`/forge setup-tools`** — Detect and install CLI tools that enhance Forge

**`/forge help`** — Show this help text

## Quick Start
1. `/forge brainstorm "build a REST API for task management"`
2. `/forge plan`
3. `/forge execute --autonomy gated`

## Configuration
Edit `.forge/config.json` to customize autonomy, depth, token budget, multi-repo setup, and circuit breaker thresholds.
