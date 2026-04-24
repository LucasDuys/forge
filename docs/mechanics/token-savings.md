# Token-Saving Mechanisms

Five mechanisms cooperate to keep a long autonomous run inside its budget. Numbers below are either measured from the repo's benchmark suite or explicitly tagged as estimates. This page is the expanded reference for the short summary in the README.

## 1. Hard per-task and session budgets

Full reference: [docs/budgets.md](../budgets.md).

Task budgets scale with detected complexity:

```
quick     5 000 tokens
standard 15 000 tokens
thorough 40 000 tokens
session 500 000 tokens
```

At 80% of either ceiling the next prompt gets a warning injected. At 100% the phase flips to `budget_exhausted`, state halts, a resume doc is written. No silent drift over hours of autonomous work.

## 2. Caveman compression

Full reference: [docs/caveman.md](../caveman.md). Benchmark detail: [docs/mechanics/caveman-details.md](caveman-details.md).

Three intensity modes compress internal agent artifacts (state notes, handoff bundles, checkpoint context, review reports). Never touches source code, commits, specs, or PR descriptions.

Measured reductions: 1% at lite, 12% at full on the 10-scenario agent-output benchmark, 18% at ultra (up to 65% on dense prose).

## 3. Tool-call cache

Source: [hooks/tool-cache.js](../../hooks/tool-cache.js).

PreToolUse intercept with a 120 second TTL on read-only operations (`git status/log/diff/branch`, `ls`, `find`, `Glob`, `Grep`, `Read`). On a hit the hook returns the cached result and skips the LLM round trip entirely. Estimated savings are significant on iterative workflows that re-read the same files. Not yet benchmarked end to end.

## 4. Test-output filter

Source: [hooks/test-output-filter.js](../../hooks/test-output-filter.js).

For test runner output over 2000 characters (vitest, jest, pytest, cargo test, go test, npm test, mocha) the hook keeps only the failure blocks, eight lines of surrounding context, and the summary tail. Estimated compression is 50 to 80% on large test suites. Measurement pending.

## 5. Graphify integration

Source: [skills/graphify-integration/SKILL.md](../../skills/graphify-integration/SKILL.md).

Optional. When `graphify-out/graph.json` exists, the planner aligns task boundaries with community clusters, the researcher queries the graph before external docs, the reviewer runs a blast-radius check, and the executor pulls only the relevant subgraph instead of scanning the whole codebase. Graceful degradation: no graph, no change. Token impact estimated, not yet measured.
