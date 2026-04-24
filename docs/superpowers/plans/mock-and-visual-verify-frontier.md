---
spec: mock-and-visual-verify
total_tasks: 6
estimated_tokens: 33
depth: standard
branch: fix/collab-and-forge-audit
---

# Mock + Visual Verify Frontier — 6 tasks building the visual-gate harness

Cross-spec dependencies reference `forge-v03-gaps-frontier.md`. See `frontier.md` for full unified DAG.

## Tier 1 (parallel — no dependencies)
- [T011] Mock project scaffold with three intentional regressions (R001) | est: ~8k tokens | provides: mock-blurry-graph | maps: R001

## Tier 2 (depends on Tier 1)
- [T015] Mock spec file with visual + structural ACs (R002) | est: ~4k tokens | depends: T011 | consumes: mock-blurry-graph | provides: mock-spec-001 | maps: R002
- [T018] Mock project full isolation from Forge own code (R006) | est: ~4k tokens | depends: T011 | consumes: mock-blurry-graph | provides: mock-isolation | maps: R006

## Tier 3 (depends on Tier 2 + cross-spec forge-v03-gaps T017)
- [T021] Negative path — Playwright unavailable yields BLOCKED not COMPLETE (R005) | est: ~5k tokens | depends: T017 (forge-v03-gaps) | consumes: completion-promise-gates | provides: playwright-unavailable-path | maps: R005

## Tier 4 (depends on Tier 3 + cross-spec forge-v03-gaps T020, T016)
- [T023] End-to-end execute run autonomously fixes all three regressions (R003) | est: ~7k tokens | depends: T020 (forge-v03-gaps), T016 (forge-v03-gaps) | consumes: visual-verifier-agent, dev-server-lifecycle | provides: mock-e2e-fix-run | maps: R003

## Tier 5 (depends on Tier 4)
- [T025] Audit evidence captured for before/after review (R004) | est: ~5k tokens | depends: T023 | consumes: mock-e2e-fix-run | provides: mock-audit-evidence | maps: R004

## Coverage

| Requirement | Task |
|-------------|------|
| R001 mock scaffold | T011 |
| R002 mock spec visual ACs | T015 |
| R003 E2E fix run | T023 |
| R004 audit evidence | T025 |
| R005 Playwright-unavailable path | T021 |
| R006 mock isolation | T018 |

## Execution Notes
- T011 (mock scaffold) was landed in commit 5598dc1 — status DONE.
- T015, T018 unblocked now.
- T021 blocks on cross-spec T017 (completion-promise gates).
- T023 blocks on cross-spec T020 (visual verifier) + T016 (dev-server lifecycle).
- All work on branch `fix/collab-and-forge-audit`.
