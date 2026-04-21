---
domain: forge-v03-gaps
status: approved
created: 2026-04-20
complexity: complex
linked_repos: []
supersedes: []
relates_to: docs/audit/CLAIM_VS_REALITY.md, docs/audit/research/streaming-dag.md
---

# Forge v0.3 Gaps Spec — Close the Reality-vs-Architecture Drift

## Overview

A pass through Forge 0.2 on `fix/collab-and-forge-audit` surfaced fifteen concrete gaps between what the architecture advertises and what actually runs. Three classes:

1. **Silent no-ops** — `setup.sh` early-exits when `.forge/` exists for any reason, leaving scaffolding missing. `discover` sees <10% of the available tools. Setup-state can write `task_status: complete` on a fresh spec. `<promise>FORGE_COMPLETE</promise>` fires on structural checks while the UI is still broken in the browser.

2. **Features implied but not wired** — no TUI auto-attach on execute. Brainstorm Q&A is multi-question prompts, not one-at-a-time. No parallel web-search subagents during brainstorm to inform proposals. No per-acceptance-criterion streaming DAG: downstream tasks wait for full upstream task completion even when the specific criterion they depend on is already met.

3. **Verification has a perceptual blind spot** — the loop passes unit tests and static checks, but nothing renders pixels and looks at them. The "blurry visualization" case in graph-visual-quality v1 shipped 328 passing tests plus `FORGE_COMPLETE` on a visibly-broken UI.

This spec closes those gaps in Forge 0.3. Work lands on `fix/collab-and-forge-audit` with commits keyed to R-numbers. Tasks that verify UI behaviour use Spec C's mock landing page (`mock-projects/blurry-graph`) as the test harness. The streaming DAG design follows the research summary at `docs/audit/research/streaming-dag.md` which recommends the Dagster asset-graph + Sherlock speculative-execution pattern.

## Requirements

### R001: setup.sh is idempotent across partial states

`scripts/setup.sh:9-12` treats any existing `.forge/` as "already initialized" and exits. The TUI leaves `.tui-log.jsonl` behind; a crash mid-init leaves a bare directory; restoring from backup may leave fragments. Fix: treat "has `config.json`" as the idempotency signal, and `mkdir -p` the rest.

**Acceptance Criteria:**
- [ ] `setup.sh` checks `[ -f "${FORGE_DIR}/config.json" ]` not `[ -d "${FORGE_DIR}" ]` for the early-exit gate.
- [ ] When the directory exists but `config.json` is missing, all `mkdir -p` and template-copy operations still run (idempotent `cp -n`).
- [ ] Regression test: create `.forge/.tui-log.jsonl`, run setup.sh, verify all of `specs/`, `plans/`, `history/cycles/`, `summaries/`, `config.json`, `state.md`, `token-ledger.json`, `history/backprop-log.md` are present.
- [ ] Second run produces exit 0 with message `Forge already initialized (config.json present)` and no file modifications (`git status` clean).

### R002: Capabilities discovery is complete and clustered

`forge-tools.cjs discover` currently finds `semantic-scholar` as the only MCP server and misses 9+ other servers active on the user's machine, zero skills vs 65+ installed, and 3 CLIs vs many on $PATH. Output on a skill-heavy setup becomes unreadable.

**Acceptance Criteria:**
- [ ] Discover reads `~/.mcp.json`, `~/.claude.json`, `~/.claude/plugins/cache/**/plugin.json`, and `~/.claude/skills/**/SKILL.md` (depth ≤ 4).
- [ ] `cli_tools` section probes `$PATH` for a declared allow-list (`node`, `npm`, `bun`, `git`, `gh`, `playwright`, `stripe`, `claude`, `docker`, `psql`) and reports version when present.
- [ ] When the combined `skills + plugins` count exceeds 50, output clusters by source (user-skills, plugin-name, archived) with counts and does not inline-list every entry — `--expand` flag produces the full tree.
- [ ] Full discover completes in under 3 seconds on a developer machine (measured; regression test runs with a `--profile` flag and fails at >5 s).
- [ ] Output includes a `deprecated` section listing any skills whose SKILL.md description starts with `Deprecated` — skills like `superpowers:brainstorm` (vs `superpowers:brainstorming`) should land here.

### R003: TUI auto-attach on `/forge:execute` in full autonomy

Today `/forge:execute` runs headless by default; the TUI is a separate `/forge:watch` invocation. For a long autonomous run (>5 minutes) without the TUI, progress visibility is zero. Auto-attach fixes this while leaving the manual path intact.

**Acceptance Criteria:**
- [ ] `/forge:execute` with `autonomy === "full"` spawns the TUI in a way appropriate to the environment.
- [ ] On Unix-like systems with `tmux` available, a detached tmux session `forge-tui-<pid>` is started with the TUI command; stdout prints `Attach: tmux attach -t forge-tui-<pid>`.
- [ ] On Windows or when tmux is unavailable, stdout prints `Monitor progress with: /forge:watch` and the execute command continues headless; no fork attempt on unsupported platforms.
- [ ] An `autonomy === "gated"` run does NOT auto-attach (the current manual flow is preserved).
- [ ] New `.forge/config.json` flag `tui.auto_attach` (default true) allows disabling the behavior without changing autonomy mode.

### R004: Brainstorming enforces one-question-at-a-time cadence

`skills/brainstorming/SKILL.md` today instructs "ask at least 3 questions"; examples in the wild batch 5 questions in a single prompt. One-at-a-time cadence produces higher-quality answers because the user cannot skip or skim.

**Acceptance Criteria:**
- [ ] Skill rewrite mandates: ask exactly one question, wait for the answer, summarize what was captured in ≤ 2 sentences, then next question.
- [ ] Minimum 3, maximum 7 questions before the proposal stage.
- [ ] Skill's instruction block contains an anti-pattern example showing a multi-question prompt with "DO NOT do this".
- [ ] Skill-level test (manual protocol documented in `skills/brainstorming/test.md`) exercises a 5-question run against a mock user.

### R005: Brainstorm dispatches parallel forge-researcher subagents

After the user answers questions 2 through N, the skill should fire a `forge-researcher` subagent with the accumulated context while the user answers question N+1 — so by the proposal stage, three to five research artefacts are ready to inform tradeoffs. This is what turned the earlier ad-hoc Q&A into an actionable plan.

**Acceptance Criteria:**
- [ ] After question 2 is answered, the skill spawns a research subagent asking "find 3 prior-art approaches to <topic derived from Q&A> and summarise tradeoffs" via the Agent tool with `run_in_background: true`.
- [ ] After question 4 (if reached), a second research subagent fires with a narrower, Q&A-informed prompt.
- [ ] Research outputs land at `.forge/specs/<spec-id>.research.md` (one file, accumulating sections per dispatch).
- [ ] Proposal-stage generation cites specific findings from the research file (named citations: `per docs/audit/research/streaming-dag.md#dagster`).
- [ ] Config flag `brainstorm.web_search_enabled` (default true) turns the entire dispatch off for restricted sandboxes.
- [ ] Fallback: when no Agent tool is available or subagent dispatch fails, proposal stage proceeds without research and notes the absence rather than silently skipping.

### R006: Per-acceptance-criterion streaming DAG

Today's frontier is task-level (`depends: [T003]`). Downstream tasks block on full upstream completion even when the specific AC they need is already met. Per AC research (Dagster asset graph + Sherlock speculative execution), the winning pattern is:

- Extend frontier edges to `provides` and `depends: [T003.R002.AC3]` on an AC-granular DAG.
- When an upstream task ticks an AC that downstream declares as a dependency, the scheduler dispatches that downstream task provisionally in its own worktree.
- Downstream work stays in the worktree until the upstream task reaches verified-complete state. If upstream later regresses the depended-on AC, downstream is marked STALE and re-queued with an invalidation notice.
- Bounded speculation: max 3 provisional downstream tasks in flight per upstream chain. After 2 verification failures, fall back to sequential mode for that spec.

**Acceptance Criteria:**
- [ ] Frontier format extended: tasks may declare `provides: [R002.AC3, R002.AC5]` and `depends: [T003.R002.AC3]` in addition to task-level `depends: [T003]`. Backward-compatible with task-only edges.
- [ ] Scheduler accepts an "AC met" event from upstream executor agents and dispatches waiting downstream tasks whose AC dependencies are now all-met.
- [ ] Edge primitive on the wire: `{ task_id, ac_id, state: "provisional" | "verified", witness_hash, witness_paths: [], emitted_at }`. `witness_hash` is SHA-256 of the file contents that evidence the AC passed; mismatched hashes invalidate downstream.
- [ ] Downstream provisional work runs in an isolated worktree (already a Forge affordance); merge to main is gated on upstream `verified` state.
- [ ] Rollback: if upstream transitions a previously-emitted AC from `verified` back to `failed`, every downstream task that consumed it is marked STALE, worktree preserved, re-queued.
- [ ] Bounded speculation: scheduler caps at 3 provisional downstream tasks per upstream chain; after 2 verification failures on a chain, scheduler disables streaming for that spec and logs `streaming_disabled: <reason>`.
- [ ] Visual rendering: `/forge:watch` renders the AC-granular DAG as a Mermaid flowchart with subgraphs per task, nodes per AC, edges by AC dependency, live status dots.
- [ ] Default on via `.forge/config.json` `streaming_dag.enabled: true`. Explicitly set `enabled: false` to fall back to strict tier-by-tier serial execution (rare).
- [ ] Integration test using Spec C mock: 3 tasks with AC-level deps, provisional dispatch triggers, upstream regression causes rollback, final state converges.

### R007: Visual verification gate with Playwright MCP

`<promise>FORGE_COMPLETE</promise>` today fires when `task-status.json` reports all tasks complete. Structural unit tests and parser-level Playwright checks pass; the UI in the browser may still be visibly broken (halo overlays, random zoom-out, empty synthesis panel from the real case). A perceptual check is needed.

**Acceptance Criteria:**
- [ ] New agent `agents/forge-visual-verifier.md` owns the visual gate; uses `mcp__playwright__browser_*` tools for navigation + screenshots.
- [ ] Spec AC syntax extended: `- [ ] [visual] path=/graph viewport=1280x800 checks=["graph nodes readable at zoom 1.0", "no blurred text on any node label", "synthesis panel shows agree/disputed sections"]`.
- [ ] Visual verifier navigates to the declared path, takes a full-page screenshot, runs an LLM-vision check against each claim, returns `pass | fail | blocked`.
- [ ] `<promise>FORGE_COMPLETE</promise>` emits only when every visual AC is `pass` AND every non-visual AC is `pass`.
- [ ] When the declared dev server is unavailable or the Playwright MCP is not wired, every visual AC returns `blocked` not `pass`; the completion promise emits `<promise>FORGE_BLOCKED</promise>` with a structured reason list.
- [ ] Baseline management: first successful `pass` saves the screenshot to `.forge/baselines/<spec>/<ac-id>.png`; subsequent runs pass the current screenshot + baseline to the LLM-vision check for regression detection.
- [ ] Integration test on mock: Spec C's three intentional regressions each produce `fail` with specific failure reasons; after fixes, all three produce `pass`.

### R008: Setup-state guard against silent iteration-zero complete

Observed in the graph-visual-quality real run: a new spec entered the state file with `task_status: complete, current_task: null`, which would have short-circuited execute had it not been noticed manually. Guards prevent this.

**Acceptance Criteria:**
- [ ] New spec ingestion writes `task_status: pending, current_task: T001, completed_tasks: []` to state.md regardless of the spec's own frontmatter.
- [ ] `writeState()` refuses to set `task_status: complete` unless:
  - A frontier file exists for the active spec, AND
  - Every task id in the frontier has a status entry, AND
  - Every status entry is one of {DONE, DONE_WITH_CONCERNS}.
- [ ] Violation emits a structured error to `.forge/history/cycles/<ts>/state-violations.jsonl` and refuses the write.
- [ ] Regression test forces the silent-complete trap and asserts the guard rejects the write.

### R009: Completion promise covers visual + integration gates + no-open-flags

`FORGE_COMPLETE` today is a structural check on task-status.json. It must also gate on visual ACs (R007) and on zero open flags (from collab). Blocked states get their own promise so consumers can discriminate.

**Acceptance Criteria:**
- [ ] `<promise>FORGE_COMPLETE</promise>` fires only when: all tasks DONE, all visual ACs PASS, all non-visual ACs PASS, no open collab flags.
- [ ] Any gate failure emits `<promise>FORGE_BLOCKED</promise>` with `{ reasons: [{ gate: "visual", ac: "R003.AC2", detail: "..."}, ...] }` JSON payload inline in the promise body.
- [ ] Contract test: each of the four gate failure modes (task, visual, non-visual, flag) independently triggers BLOCKED; all-green state triggers COMPLETE.

### R010: Sandbox-aware execution with dev-server lifecycle

The executor today cannot run a dev server, so visual ACs and E2E ACs cannot actually run. Config-declared dev servers start before visual verification and stop after; capabilities.json reports what the sandbox can do.

**Acceptance Criteria:**
- [ ] `.forge/config.json` accepts `sandbox: { dev_server: "bun dev --port 5174", wait_url: "http://localhost:5174", wait_timeout_ms: 15000 }`.
- [ ] Executor starts the dev server as a background process before any visual AC runs, waits for `wait_url` to return 200 (or `wait_timeout_ms` to elapse), runs visual ACs, then sends SIGTERM + 5 s grace + SIGKILL.
- [ ] Capabilities discover (R002) probes sandbox affordances and writes `{ browser: bool, spawn: bool, network: bool }` so specs can decide feasibility before planning.
- [ ] A `/forge:execute --record-baselines` subcommand flags the first-successful-visual-AC path to save baselines.
- [ ] Integration test on mock: dev server auto-starts, visual ACs run, dev server auto-stops, no orphan processes.

### R011: Path-validation gate between spec and plan

The graph-visual-quality run had a stale path (`app/tests/e2e/` vs `app/e2e/`) that the re-plan agent caught; it should have been caught earlier as a spec-read invariant.

**Acceptance Criteria:**
- [ ] Before planning, a `forge-speccer-validator` step enumerates every path token in the spec (heuristic: anything that parses as a file path and lives in a code fence or backticks).
- [ ] Each path is checked against the target repo; missing paths produce `REPLAN_NEEDED` status with a list of (spec-line, missing-path) pairs.
- [ ] The replan agent is invoked automatically to correct the paths, writes an updated spec, then planning resumes.
- [ ] Regression test: spec with a known-bad path triggers REPLAN and the planner re-runs against the corrected spec.

### R012: README "How Forge Actually Works" rewrite

Current README is dense; new readers struggle to understand the phase loop + autonomy modes + backprop. A focused rewrite, with mechanics moved to `docs/mechanics/`, improves onboarding.

**Acceptance Criteria:**
- [ ] New section "How Forge Actually Works" in `README.md` at the top, under 1500 words.
- [ ] Contains a phase-loop diagram (Mermaid): `brainstorm → plan → execute → review → backprop` with the feedback edge from backprop to brainstorm clearly drawn.
- [ ] One worked example: simple feature (e.g. "add a logout button"), real commands run, real files written at each phase; <300 words total.
- [ ] Explicit "what Forge does automatically vs what requires your explicit approval" table, rows per autonomy mode (`gated`, `full`).
- [ ] Troubleshooting section: "when `<promise>FORGE_COMPLETE</promise>` fires but the feature is broken" with three recipes (visual smoke, `/forge:backprop`, manual spec review).
- [ ] Existing detailed mechanics move to `docs/mechanics/` with stable URLs; existing inline mechanics in README become one-sentence summaries linking there.
- [ ] `README.md` renders cleanly on GitHub (verified by fetching the rendered HTML and eyeballing headings + Mermaid rendering).

### R013: Skill + command inventory audit command

With skill counts varying across setups, users need a way to see what their Forge actually sees. A `/forge:skills-audit` command emits the grouped inventory including dupes.

**Acceptance Criteria:**
- [ ] New command `commands/skills-audit.md` invokes a lightweight node script that produces a table of (skill, source, path, status).
- [ ] Duplicate detection: same skill name in ≥ 2 sources is flagged with `status: duplicate`.
- [ ] Deprecated detection: SKILL.md description starting with `Deprecated` is flagged with `status: deprecated`.
- [ ] Archive detection: skills under `_archived-*/` subdirectories are flagged with `status: archived`.
- [ ] Output is copy-paste-ready into a skills cleanup PR.

### R014: Execute run transcript for audit + review

Currently a long execute run leaves only commits + the final state file. A human-readable JSONL transcript per phase enables `/forge:review-branch` to cross-check agent claims against reality.

**Acceptance Criteria:**
- [ ] Every agent invocation inside `/forge:execute` appends a line to `.forge/history/cycles/<ts>/transcript.jsonl` with `{ phase, agent, task_id, tool_calls_count, duration_ms, status, summary }`.
- [ ] Timestamps appear only on phase-boundary lines, not every entry, so diffs across runs stay readable.
- [ ] `/forge:review-branch` accepts a transcript path and cross-checks: every task it reviewed has a corresponding transcript entry; every transcript entry it sees has a corresponding commit or status update.
- [ ] Test: a deterministic mock execute run produces a stable transcript byte-for-byte across repeats.

### R015: Caveman compression audit and whitelist enforcement

`forge:caveman-internal` compresses internal artifacts. The compression is trusted to be lossless but not currently verified. Whitelist enforcement prevents accidental compression of user-facing content.

**Acceptance Criteria:**
- [ ] Compression wrapper refuses to compress paths outside the declared whitelist: `{handoff notes, state.md, summaries/, review reports}`. Violations throw.
- [ ] A round-trip test compresses representative artifacts, decompresses, asserts byte-identical (or if not byte-identical, that every semantic token is preserved per the skill's documented schema).
- [ ] Commits, specs, PR descriptions, code files never go through compression (enforced by path check + file-extension check).
- [ ] `/forge:status` surfaces total bytes compressed + total bytes saved per cycle so regressions in compression quality are visible.

## Future Considerations

- Multi-machine execute via collab's frontier sharing once Spec A R006 lands.
- Spec-level automatic dependency inference from natural language (currently manual in the frontier).
- Execution profile: heatmap showing which tasks dominate token cost + wall time so plans can be optimised.
- First-class support for `gh` MCP in discover so PR lifecycle gates can live inside Forge.
