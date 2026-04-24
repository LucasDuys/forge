# Caveman Compression Details

Internal agent artifacts are written in a compressed "caveman" form to reduce the token cost of every round trip through the autonomous loop. This page holds the full benchmark numbers and mode table that used to live inline in the README.

The short summary: three intensity modes, selected automatically by remaining task budget. Never compresses source code, commits, specs, or PR descriptions.

## Mode table

| Mode | When | Measured reduction |
|---|---|---|
| lite | budget > 50% | ~1% on mixed artifacts (filler-word strip only) |
| full | 20-50% | 12% on the 10-scenario benchmark |
| ultra | < 20% | 18% on the same benchmark, up to 65% on dense prose |

The 12% full-intensity figure is below the original 30% target. The mode ships behind a `terse_internal: false` flag pending further tuning. The 26.8% figure cited elsewhere in prior drafts comes from write-path benchmarks on pure-prose artifacts; the agent-output benchmark is the honest headline.

## What gets compressed

- `state.md` notes and transition logs
- Progress checkpoint context bundles and error logs
- Resume handoff docs
- Review notes for minor issues
- Verifier pass reports
- Agent-to-agent handoff messages

## What stays verbose (always)

- Source code, diffs, commit messages
- PR descriptions
- User-facing specs and plans
- Security warnings
- Errors requiring human action
- Acceptance criteria for backpropagation

## Benchmark source

The 10-scenario benchmark lives at [docs/benchmarks/caveman-integration.md](../benchmarks/caveman-integration.md). Run with `node scripts/run-tests.cjs` under the caveman suite.

## Related

- [docs/caveman.md](../caveman.md): user-facing overview and config flags
- [skills/caveman-internal/SKILL.md](../../skills/caveman-internal/SKILL.md): the skill definition itself
