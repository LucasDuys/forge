# Caveman Token Optimization

Internal agent artifacts are written in caveman form to reduce token cost on every read of the loop.

Three intensity modes, selected automatically based on remaining task budget:

| Budget remaining | Mode | Typical reduction |
|---|---|---|
| Above 50% | lite | ~10-15% |
| 20-50% | full | ~25-30% |
| Below 20% | ultra | ~60-65% |

## What gets compressed

- State.md notes and transition logs
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

## Measured savings

- **26.8% prose reduction** on free-text content
- **46% reduction** on the state.md phase documentation section

Full benchmark: [benchmarks/caveman-integration.md](benchmarks/caveman-integration.md).

## Attribution

Adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) under MIT License. The skill file at `skills/caveman-internal/SKILL.md` credits the original and is not exposed as a user-facing `/caveman` command.
