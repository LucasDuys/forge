---
spec: forge-v03-gaps
total_tasks: 15
estimated_tokens: 104
depth: standard
branch: fix/collab-and-forge-audit
---

# Forge v0.3 Gaps Frontier — 15 tasks across setup, discovery, UX, visual gate, streaming DAG

Cross-spec dependencies noted inline with their source spec (collab-fix or mock-and-visual-verify). See `frontier.md` for the full unified DAG.

## Tier 1 (parallel — no dependencies)
- [T002] setup.sh idempotent across partial states (R001) | est: ~5k tokens | provides: idempotent-setup | maps: R001
- [T003] Capabilities discovery complete and clustered (R002) | est: ~7k tokens | provides: discover-complete | maps: R002
- [T004] Path-validation gate between spec and plan (R011) | est: ~6k tokens | provides: speccer-validator | maps: R011
- [T005] README "How Forge Actually Works" rewrite (R012) | est: ~7k tokens | provides: readme-rewrite | maps: R012
- [T006] Skills-audit command (R013) | est: ~5k tokens | provides: skills-audit-cmd | maps: R013
- [T007] Caveman compression audit and whitelist enforcement (R015) | est: ~6k tokens | provides: caveman-whitelist | maps: R015
- [T008] Execute run transcript JSONL per phase (R014) | est: ~6k tokens | provides: execute-transcripts | maps: R014
- [T009] Setup-state guard against silent iteration-zero complete (R008) | est: ~5k tokens | provides: state-write-guard | maps: R008
- [T010] Brainstorming one-question-at-a-time cadence (R004) | est: ~5k tokens | provides: one-q-cadence | maps: R004
- [T012] TUI auto-attach on /forge:execute full autonomy (R003) | est: ~6k tokens | provides: tui-auto-attach | maps: R003

## Tier 2 (depends on Tier 1)
- [T014] Brainstorm dispatches parallel forge-researcher subagents (R005) | est: ~6k tokens | depends: T010 | consumes: one-q-cadence | provides: researcher-dispatch | maps: R005
- [T016] Sandbox-aware execution with dev-server lifecycle (R010) | est: ~7k tokens | depends: T002, T003 | consumes: idempotent-setup, discover-complete | provides: dev-server-lifecycle | maps: R010
- [T017] Completion-promise covers visual + integration gates + no-open-flags (R009) | est: ~6k tokens | depends: T008, T009 | consumes: execute-transcripts, state-write-guard | provides: completion-promise-gates | maps: R009

## Tier 3 (depends on Tier 2 + cross-spec mock-and-visual-verify T015)
- [T020] Visual verification gate with Playwright MCP (R007) | est: ~9k tokens | depends: T015 (mock-and-visual-verify), T016 | consumes: mock-spec-001, dev-server-lifecycle | provides: visual-verifier-agent | maps: R007

## Tier 9 (final capstone — depends on everything before + cross-spec collab-fix T028)
- [T029] Per-acceptance-criterion streaming DAG (R006) | est: ~12k tokens | depends: T008, T009, T012, T014, T017, T020, T028 (collab-fix) | consumes: execute-transcripts, state-write-guard, tui-auto-attach, researcher-dispatch, completion-promise-gates, visual-verifier-agent, collab-enabled-marker | provides: streaming-dag | maps: R006

## Coverage

| Requirement | Task |
|-------------|------|
| R001 idempotent setup.sh | T002 |
| R002 capabilities discover complete | T003 |
| R003 TUI auto-attach | T012 |
| R004 one-question cadence | T010 |
| R005 parallel researcher dispatch | T014 |
| R006 per-AC streaming DAG | T029 |
| R007 visual verification gate | T020 |
| R008 setup-state guard | T009 |
| R009 completion-promise gates | T017 |
| R010 dev-server lifecycle | T016 |
| R011 path-validation gate | T004 |
| R012 README rewrite | T005 |
| R013 skills-audit command | T006 |
| R014 execute transcripts | T008 |
| R015 caveman whitelist | T007 |

## Execution Notes
- T020 blocks on cross-spec dependency T015 (mock-and-visual-verify spec declares visual ACs first).
- T029 blocks on cross-spec dependency T028 (collab-fix .enabled marker so collab and streaming compose).
- Tier 1 is 10-wide parallel-safe with disjoint file sets (setup.sh, forge-tools.cjs subcommands, different SKILL.md files). In practice dispatch serially or in disjoint pairs until worktree isolation (R006) ships per audit O019.
- All work on branch `fix/collab-and-forge-audit`.
