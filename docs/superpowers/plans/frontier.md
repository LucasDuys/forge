---
spec: collab-fix + forge-v03-gaps + mock-and-visual-verify
total_tasks: 29
estimated_tokens: 186
depth: standard
branch: fix/collab-and-forge-audit
---

# Unified Frontier — Collab Fix + Forge 0.3 Gaps + Mock/Visual Verify

Three approved specs decomposed into a single dependency-ordered frontier. Ordering rationale:

1. **Spec A (collab-fix)** lands first end-to-end (T001 -> T028). All eight requirements touch `scripts/forge-collab.cjs` so they chain sequentially but run in parallel with Spec B/C tiers.
2. **Spec B non-visual subset** (setup.sh idempotency, discover, path-val, README, skills-audit, caveman, transcripts, setup-state guard, Q&A cadence, TUI) lands in Tier 1 in parallel with A.
3. **Spec C (mock + visual verify)** is scaffolded starting Tier 1 (mock project) and completes after Spec B's visual gate lands.
4. **Spec B visual subset** (dev-server, completion-promise, visual gate) lands in Tiers 2-3 so Spec C can consume it.
5. **Spec B R006 (streaming DAG)** is the final big item — depends on setup-state, completion-promise, transcripts, and the visual gate.

## Tier 1 (parallel -- no dependencies)
- [T001] Collab .gitignore carve-out plus migration helper (spec A R001) | est: ~6k tokens | provides: collab-gitignore-rules, collab-migration-helper | maps: A.R001
- [T002] setup.sh idempotent across partial states (spec B R001) | est: ~5k tokens | provides: idempotent-setup | maps: B.R001
- [T003] Capabilities discovery complete and clustered (spec B R002) | est: ~7k tokens | provides: discover-complete | maps: B.R002
- [T004] Path-validation gate between spec and plan (spec B R011) | est: ~6k tokens | provides: speccer-validator | maps: B.R011
- [T005] README "How Forge Actually Works" rewrite (spec B R012) | est: ~7k tokens | provides: readme-rewrite | maps: B.R012
- [T006] Skills-audit command (spec B R013) | est: ~5k tokens | provides: skills-audit-cmd | maps: B.R013
- [T007] Caveman compression audit and whitelist enforcement (spec B R015) | est: ~6k tokens | provides: caveman-whitelist | maps: B.R015
- [T008] Execute run transcript JSONL per phase (spec B R014) | est: ~6k tokens | provides: execute-transcripts | maps: B.R014
- [T009] Setup-state guard against silent iteration-zero complete (spec B R008) | est: ~5k tokens | provides: state-write-guard | maps: B.R008
- [T010] Brainstorming one-question-at-a-time cadence (spec B R004) | est: ~5k tokens | provides: one-q-cadence | maps: B.R004
- [T011] Mock project scaffold with three intentional regressions (spec C R001) | est: ~8k tokens | provides: mock-blurry-graph | maps: C.R001
- [T012] TUI auto-attach on /forge:execute full autonomy (spec B R003) | est: ~6k tokens | provides: tui-auto-attach | maps: B.R003

## Tier 2 (depends on Tier 1)
- [T013] Polling transport writes via single-commit amend plus force-with-lease (spec A R002) | est: ~9k tokens | depends: T001 | consumes: collab-gitignore-rules | provides: polling-transport-writes | maps: A.R002
- [T014] Brainstorm dispatches parallel forge-researcher subagents (spec B R005) | est: ~6k tokens | depends: T010 | consumes: one-q-cadence | provides: researcher-dispatch | maps: B.R005
- [T015] Mock spec file with visual + structural ACs (spec C R002) | est: ~4k tokens | depends: T011 | consumes: mock-blurry-graph | provides: mock-spec-001 | maps: C.R002
- [T016] Sandbox-aware execution with dev-server lifecycle (spec B R010) | est: ~7k tokens | depends: T002, T003 | consumes: idempotent-setup, discover-complete | provides: dev-server-lifecycle | maps: B.R010
- [T017] Completion-promise covers visual + integration gates + no-open-flags (spec B R009) | est: ~6k tokens | depends: T008, T009 | consumes: execute-transcripts, state-write-guard | provides: completion-promise-gates | maps: B.R009
- [T018] Mock project full isolation from Forge own code (spec C R006) | est: ~4k tokens | depends: T011 | consumes: mock-blurry-graph | provides: mock-isolation | maps: C.R006

## Tier 3 (depends on Tier 2)
- [T019] Messages as bounded append queue on state.json (spec A R003) | est: ~6k tokens | depends: T013 | consumes: polling-transport-writes | provides: bounded-msg-queue | maps: A.R003
- [T020] Visual verification gate with Playwright MCP (spec B R007) | est: ~9k tokens | depends: T015, T016 | consumes: mock-spec-001, dev-server-lifecycle | provides: visual-verifier-agent | maps: B.R007
- [T021] Negative path -- Playwright unavailable yields BLOCKED not COMPLETE (spec C R005) | est: ~5k tokens | depends: T017 | consumes: completion-promise-gates | provides: playwright-unavailable-path | maps: C.R005

## Tier 4 (depends on Tier 3)
- [T022] Targeted scoping enforced at transport layer (spec A R004) | est: ~6k tokens | depends: T019 | consumes: bounded-msg-queue | provides: transport-target-filter | maps: A.R004
- [T023] End-to-end execute run autonomously fixes all three regressions (spec C R003) | est: ~7k tokens | depends: T020, T016 | consumes: visual-verifier-agent, dev-server-lifecycle | provides: mock-e2e-fix-run | maps: C.R003

## Tier 5 (depends on Tier 4)
- [T024] Ably CAS authoritative via publish-ack reconciliation (spec A R005) | est: ~7k tokens | depends: T022 | consumes: transport-target-filter | provides: ably-cas-authoritative | maps: A.R005
- [T025] Audit evidence captured for before/after review (spec C R004) | est: ~5k tokens | depends: T023 | consumes: mock-e2e-fix-run | provides: mock-audit-evidence | maps: C.R004

## Tier 6 (depends on Tier 5)
- [T026] Cross-process wire test covering real adapters (spec A R006) | est: ~8k tokens | depends: T024 | consumes: ably-cas-authoritative | provides: collab-wire-test | maps: A.R006

## Tier 7 (depends on Tier 6)
- [T027] LLM-default scorer, Jaccard becomes explicit opt-in (spec A R007) | est: ~7k tokens | depends: T026 | consumes: collab-wire-test | provides: llm-default-scorer | maps: A.R007

## Tier 8 (depends on Tier 7)
- [T028] Collab-mode explicit .enabled marker plus recovery (spec A R008) | est: ~6k tokens | depends: T027 | consumes: llm-default-scorer | provides: collab-enabled-marker | maps: A.R008

## Tier 9 (depends on everything before -- final big item)
- [T029] Per-acceptance-criterion streaming DAG (spec B R006) | est: ~12k tokens | depends: T008, T009, T012, T014, T017, T020, T028 | consumes: execute-transcripts, state-write-guard, tui-auto-attach, researcher-dispatch, completion-promise-gates, visual-verifier-agent, collab-enabled-marker | provides: streaming-dag | maps: B.R006

## Coverage

Every R-numbered requirement across all three specs maps to at least one task.

| Spec | Requirement | Task(s) |
|------|-------------|---------|
| collab-fix (A) | R001 .gitignore carve-out | T001 |
| collab-fix (A) | R002 polling amend+force-with-lease | T013 |
| collab-fix (A) | R003 bounded message queue | T019 |
| collab-fix (A) | R004 transport-layer target filtering | T022 |
| collab-fix (A) | R005 Ably CAS authoritative | T024 |
| collab-fix (A) | R006 cross-process wire test | T026 |
| collab-fix (A) | R007 LLM-default scorer | T027 |
| collab-fix (A) | R008 explicit .enabled marker | T028 |
| forge-v03-gaps (B) | R001 idempotent setup.sh | T002 |
| forge-v03-gaps (B) | R002 capabilities discover complete | T003 |
| forge-v03-gaps (B) | R003 TUI auto-attach | T012 |
| forge-v03-gaps (B) | R004 one-question cadence | T010 |
| forge-v03-gaps (B) | R005 parallel researcher dispatch | T014 |
| forge-v03-gaps (B) | R006 per-AC streaming DAG | T029 |
| forge-v03-gaps (B) | R007 visual verification gate | T020 |
| forge-v03-gaps (B) | R008 setup-state guard | T009 |
| forge-v03-gaps (B) | R009 completion-promise gates | T017 |
| forge-v03-gaps (B) | R010 dev-server lifecycle | T016 |
| forge-v03-gaps (B) | R011 path-validation gate | T004 |
| forge-v03-gaps (B) | R012 README rewrite | T005 |
| forge-v03-gaps (B) | R013 skills-audit command | T006 |
| forge-v03-gaps (B) | R014 execute transcripts | T008 |
| forge-v03-gaps (B) | R015 caveman whitelist | T007 |
| mock-and-visual-verify (C) | R001 mock scaffold | T011 |
| mock-and-visual-verify (C) | R002 mock spec visual ACs | T015 |
| mock-and-visual-verify (C) | R003 E2E fix run | T023 |
| mock-and-visual-verify (C) | R004 audit evidence | T025 |
| mock-and-visual-verify (C) | R005 Playwright-unavailable path | T021 |
| mock-and-visual-verify (C) | R006 mock isolation | T018 |

## Dependency Notes

- **Spec A sequential chain** (single file `scripts/forge-collab.cjs`): T001 -> T013 -> T019 -> T022 -> T024 -> T026 -> T027 -> T028. Length: 8 tasks.
- **Spec B R006 (T029) deps**: T008 (transcripts), T009 (setup-state guard), T017 (completion-promise) per user spec; plus T012 (TUI auto-attach for watch UI), T014 (researcher dispatch parallelism primitives), T020 (visual verifier as a downstream AC consumer), T028 (collab .enabled marker so collab + streaming play together).
- **Spec C R003 (T023) deps**: T020 (visual gate exists), T016 (dev-server lifecycle) per user spec.
- **Spec C R005 (T021) deps**: T017 (completion-promise emits BLOCKED) per user spec.
- **Spec B R007 (T020) deps**: T015 (mock spec declares visual ACs), T016 (dev-server lifecycle) per user spec. T011 (mock scaffold) is transitively covered through T015.

## Execution Notes

- All work lands on branch `fix/collab-and-forge-audit`. Do not create additional branches.
- Single-repo project (no `repos` block in `.forge/config.json`) so `repo:` tags are omitted.
- Budget: 186k tokens estimated against a 500k budget — 37% utilization, leaves headroom for review cycles and circuit-breaker retries.
- Longest dependency chain: 9 tasks (T001 -> T013 -> T019 -> T022 -> T024 -> T026 -> T027 -> T028 -> T029).
- Wide tier-1 parallelism: 12 tasks with no dependencies, so executor can fan out hard on the opening tier.
