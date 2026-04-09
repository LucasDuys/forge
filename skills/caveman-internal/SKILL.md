---
name: caveman-internal
description: Internal token optimization for Forge agent artifacts (handoff notes, artifact summaries, review notes). NOT exposed as a user-facing /caveman command.
---

<!--
Adapted from JuliusBrussee/caveman (MIT License)
https://github.com/JuliusBrussee/caveman

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the conditions of the MIT License.
-->

# Caveman Internal Skill

Compress prose in Forge's own agent-to-agent artifacts so the autonomous loop spends fewer tokens on coordination and more on actual implementation. This skill is consumed internally by Forge agents (executor, planner, reviewer, verifier) when writing handoff notes, artifact summaries, and review reports. It is NOT a user-facing command and must never be invoked as `/caveman`.

## Scope

In scope (compress these):
- `.forge/artifacts/{task-id}.json` artifact descriptions and key_decisions
- `.forge/context-bundles/` handoff notes between tasks
- Review summaries written by the reviewer agent
- Internal status reports passed between agents
- Token-ledger annotations and state.md "What's Done" entries

Out of scope (ALWAYS use normal verbose mode regardless of intensity):
- All code output (source files, code blocks, diffs, patches)
- Commit messages and PR descriptions
- User-facing spec files in `.forge/specs/`
- Security warnings of any kind
- Irreversible action confirmations (deletes, force-pushes, schema drops)
- Error messages humans need to act on
- Anything the user will read directly

## Intensity Modes

Three levels. Higher intensity removes more, but technical terms (function names, file paths, identifiers, version numbers, error codes) stay verbatim at every level.

### lite

Strip filler words and pleasantries. Keep articles, conjunctions, and full grammar. This is the safest mode and is the default for `standard` depth tasks.

Remove: just, really, basically, very, quite, simply, actually, essentially, indeed, clearly, obviously, sure, certainly, happy to help, of course, please note, it should be noted, as you can see, in order to (use "to").

Example:
- Before: "I just finished implementing the registration endpoint. Basically, it accepts an email and password, and it really validates them carefully before hashing the password with bcrypt."
- After: "Finished implementing the registration endpoint. It accepts an email and password, and validates them before hashing the password with bcrypt."

Token reduction: ~20%.

### full

Drop articles (a, an, the) where meaning survives. Allow sentence fragments. Use shorter synonyms. Keep technical terminology precise. Default for `quick` depth tasks.

Substitutions: implement -> add, modify -> change, utilize -> use, demonstrate -> show, approximately -> about, in addition -> also, due to -> from, prior to -> before, subsequent to -> after, in the event that -> if.

Example:
- Before: "I have implemented the registration endpoint. It accepts an email and a password, validates them against the schema, and then hashes the password using bcrypt with twelve rounds before storing the user record in the database."
- After: "Added registration endpoint. Accepts email + password, validates against schema, hashes password with bcrypt 12 rounds, stores user record in database."

Token reduction: ~40%.

### ultra

Emergency budget mode. Used when fewer than 20% of task budget tokens remain. Adds aggressive abbreviation and arrows for causality.

Abbreviations: database -> DB, authentication -> auth, configuration -> config, function -> fn, variable -> var, request -> req, response -> res, parameter -> param, environment -> env, repository -> repo, dependency -> dep, validation -> valid, error -> err, message -> msg, application -> app, server -> srv, client -> cli, production -> prod, development -> dev.

Strip conjunctions where meaning is clear. Use arrows for causality and flow: `X -> Y` means X causes/produces Y. Use `+` for "and" in lists.

Example:
- Before: "I have implemented the registration endpoint. It accepts an email and a password, validates them against the schema, and then hashes the password using bcrypt with twelve rounds before storing the user record in the database."
- After: "Added register endpoint. Accepts email+password -> valid vs schema -> bcrypt 12 rounds -> store user in DB."

Token reduction: ~65%.

## Intensity Selection Logic

Agents self-select intensity at the start of each task by querying the task budget and applying the rule below. No external orchestrator is required.

### Decision rule

Compute `remaining_percentage = remaining / budget * 100` from the task budget, then:

| Remaining budget | Mode |
|------------------|------|
| > 50% | lite (lowest compression, keep readability) |
| 20% to 50% | full (default compression) |
| < 20% | ultra (emergency, maximum compression) |

`depth = thorough` clamps the result to `lite` regardless of budget. Compression is never allowed to obscure thorough-depth artifacts.

### How to query the budget

From a shell:

```
node scripts/forge-tools.cjs check-task-budget <task_id> --forge-dir .forge
```

From Node:

```js
const { checkTaskBudget } = require('./scripts/forge-tools.cjs');
const { used, budget, remaining, percentage } = checkTaskBudget(taskId, forgeDir);
```

The returned `percentage` is percent used. Compute remaining as `100 - percentage`.

### Fallback

If the budget check fails, throws, or there is no current task context (ad-hoc work, repair flows), default to `full`. Never block on budget lookup. See `references/budget-thresholds.md` for the full threshold table and rationale.

## Quality Fallback

Caveman compression is lossy. If a downstream consumer (reviewer, verifier, next executor) cannot act on a compressed artifact because critical context is missing, the producing agent must regenerate the artifact in normal verbose mode.

Triggers for fallback:

- Reviewer or verifier reports missing context, ambiguous reference, or unresolvable identifier in a caveman artifact
- Backpropagation pass cannot reconstruct intent from a compressed key_decision
- Next executor's context bundle is incoherent without the original phrasing

When fallback occurs:

1. Rewrite the artifact in verbose mode and overwrite the compressed version.
2. Append a line to `.forge/state.md` under "Caveman Fallbacks":
   ```
   - {task_id} {mode} -> verbose: {short reason}
   ```
3. Continue the loop. Do not retry compression for the same artifact.

The T024 benchmark validates that fallbacks fire on fewer than 5% of compressed artifacts. Above that threshold, the thresholds in `references/budget-thresholds.md` should be tuned upward (less aggressive compression).

### Decision Examples

- Simple task, 80% budget remaining: **lite**. Plenty of headroom, keep readability high.
- Mid-complexity task, 35% budget remaining: **full**. Default compression, drop articles, allow fragments.
- Complex task near budget limit, 15% remaining: **ultra**. Compress harder, do not bail. The right move is more compression, not abandoning the task.
- User-facing content (spec text, commit message, error to user) regardless of budget: **normal verbose**. Out of scope for caveman. See "Out of scope" above.

## Rules

1. Never compress out-of-scope content. Code, commits, specs, security notes, and error messages stay verbose.
2. Never alter identifiers, file paths, function names, version strings, error codes, or quoted user input.
3. Never drop information that changes meaning. Compression is lexical, not semantic.
4. If a sentence cannot be compressed without ambiguity, leave it alone.
5. Apply the chosen intensity uniformly within an artifact. Do not mix modes inside one document.
6. When in doubt, fall back to lite. Lite is always safe.

## Attribution

This skill adapts the prompt-compression approach from JuliusBrussee/caveman, used here under the MIT license. Original project: https://github.com/JuliusBrussee/caveman
