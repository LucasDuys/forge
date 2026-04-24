---
spec: collab-fix
total_tasks: 8
estimated_tokens: 55
depth: standard
branch: fix/collab-and-forge-audit
---

# Collab Fix Frontier — 8 tasks on scripts/forge-collab.cjs

Sequential chain since all 8 tasks land on the same file. Cross-spec deps are cross-referenced to `forge-v03-gaps-frontier.md` and `mock-and-visual-verify-frontier.md`; see unified view at `frontier.md` for the complete DAG.

## Tier 1 (parallel — no dependencies)
- [T001] Collab .gitignore carve-out plus migration helper (R001) | est: ~6k tokens | provides: collab-gitignore-rules, collab-migration-helper | maps: R001

## Tier 2 (depends on Tier 1)
- [T013] Polling transport writes via single-commit amend plus force-with-lease (R002) | est: ~9k tokens | depends: T001 | consumes: collab-gitignore-rules | provides: polling-transport-writes | maps: R002

## Tier 3
- [T019] Messages as bounded append queue on state.json (R003) | est: ~6k tokens | depends: T013 | consumes: polling-transport-writes | provides: bounded-msg-queue | maps: R003

## Tier 4
- [T022] Targeted scoping enforced at transport layer (R004) | est: ~6k tokens | depends: T019 | consumes: bounded-msg-queue | provides: transport-target-filter | maps: R004

## Tier 5
- [T024] Ably CAS authoritative via publish-ack reconciliation (R005) | est: ~7k tokens | depends: T022 | consumes: transport-target-filter | provides: ably-cas-authoritative | maps: R005

## Tier 6
- [T026] Cross-process wire test covering real adapters (R006) | est: ~8k tokens | depends: T024 | consumes: ably-cas-authoritative | provides: collab-wire-test | maps: R006

## Tier 7
- [T027] LLM-default scorer, Jaccard becomes explicit opt-in (R007) | est: ~7k tokens | depends: T026 | consumes: collab-wire-test | provides: llm-default-scorer | maps: R007

## Tier 8
- [T028] Collab-mode explicit .enabled marker plus recovery (R008) | est: ~6k tokens | depends: T027 | consumes: llm-default-scorer | provides: collab-enabled-marker | maps: R008

## Coverage

| Requirement | Task |
|-------------|------|
| R001 .gitignore carve-out | T001 |
| R002 polling amend+force-with-lease | T013 |
| R003 bounded message queue | T019 |
| R004 transport-layer target filtering | T022 |
| R005 Ably CAS authoritative | T024 |
| R006 cross-process wire test | T026 |
| R007 LLM-default scorer | T027 |
| R008 explicit .enabled marker | T028 |

## Execution Notes
- Sequential single-file chain: T001 -> T013 -> T019 -> T022 -> T024 -> T026 -> T027 -> T028.
- No cross-spec dependencies inbound or outbound until T028 is consumed by forge-v03-gaps T029 (streaming DAG).
- All work on branch `fix/collab-and-forge-audit`.
