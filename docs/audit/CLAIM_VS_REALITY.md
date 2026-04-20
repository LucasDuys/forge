---
name: Forge Claim-vs-Reality Audit
scope: collab PR #4 + Forge 0.2.0 core
branch: fix/collab-and-forge-audit
started: 2026-04-20
---

# Forge Claim-vs-Reality Audit

Running log of "what the architecture says will happen" vs "what actually happens" while driving `/forge:brainstorm` and adjacent commands on the `fix/collab-and-forge-audit` branch. Filled in as each observation is made; no entry is hypothetical.

## Key
- **CLAIM** — what the command file, skill, spec, or docs promise.
- **REALITY** — what the code/runtime actually does, verified by me.
- **SEVERITY** — `blocker` (feature doesn't work), `silent-gap` (feature silently no-ops), `partial` (feature works in one mode but not another), `ux` (works but misleading).

---

## Observations from setup + discover

### O001 — setup.sh is a silent no-op if `.forge/` exists for any reason

- **CLAIM**: `scripts/setup.sh` initializes `.forge/specs/`, `.forge/plans/`, `.forge/history/cycles/`, `.forge/summaries/`, `config.json`, `state.md`, `token-ledger.json`, and `history/backprop-log.md`. The brainstorm command calls it unconditionally at Step 1.
- **REALITY** (`scripts/setup.sh:9-12`): early-exits on `[ -d "$FORGE_DIR" ]` with message `"Forge already initialized in ${FORGE_DIR}"` and does none of the above. The TUI leaves `.tui-log.jsonl` behind in `.forge/` from any prior run, so on second use of the same checkout the directory exists and setup skips all scaffolding. Downstream commands then hit missing files with no clear error.
- **SEVERITY**: silent-gap
- **FIX SKETCH**: check for presence of `config.json` or `specs/`, not just the dir. Or idempotently `mkdir -p` the scaffolding regardless.

### O002 — capabilities discovery misses the user's actual tool surface

- **CLAIM** (Step 2 of `commands/brainstorm.md`): `forge-tools.cjs discover` "scans the user's environment for MCP servers, skills, and plugins" and writes `.forge/capabilities.json` with "available tools that can enhance brainstorming and execution."
- **REALITY**: on this machine, output is:
  - `mcp_servers`: only `semantic-scholar`. Missing: `context7`, `figma`, `supabase`, `github`, `firebase`, `slack`, `linear`, `langsmith`, `playwright` (MCP), `firecrawl`, `plugin_supabase_supabase`, `claude_ai_Google_Drive` — all active in this session per `~/.mcp.json`.
  - `skills: {}`, `plugins: {}` — but 100+ skills are installed (`doc-coauthoring`, `webapp-testing`, `frontend-design`, `playwright`, `figma-implement-design`, full Forge skill set, etc.).
  - `cli_tools`: `gh`, `stripe`, `playwright`. Missing: `bun`, `node`, `git`, `claude`, every other CLI.
- **SEVERITY**: partial (functional but drops ~90% of context that could inform brainstorm)
- **FIX SKETCH**: probe `~/.claude/plugins/cache/**/plugin.json` and `~/.claude/skills/**/SKILL.md` for skills. Parse `~/.claude.json` or `~/.mcp.json` for MCP. CLI detection should check a longer list and also consult `$PATH`.

### O003 — Step 2.5 "auto-detect project context" has nothing to work with

- **CLAIM** (Step 2.5 of `commands/brainstorm.md`): "Check if `DESIGN.md`, `design.md`, or `docs/DESIGN.md` exists" and "`graphify-out/graph.json`". If found, pass to brainstorming skill.
- **REALITY**: none exist in the forge repo itself, so step is a no-op. Not a bug — just the step is invisible when nothing matches, and there is no `NOT FOUND` signal to tell the brainstorm skill "no design constraints on this repo" vs "design step failed". The skill is silently told "nothing matches."
- **SEVERITY**: ux

### O004 — `.forge/` is gitignored by setup.sh by default

- **CLAIM** (`skills/collaborating/SKILL.md:20-22`): "All brainstorm + consolidated + categories + questions + flags artifacts live under `.forge/collab/` and are committed to git so late joiners get full context via `git pull`."
- **REALITY** (`scripts/setup.sh:30-37`): setup.sh unconditionally appends `.forge/` to `.gitignore`. No carve-out for `.forge/collab/`. Means every `git add .forge/collab/<file>` that the collab skill instructs is a no-op, so nothing reaches origin.
- **SEVERITY**: blocker (for collab mode cross-machine sync; see also collab O005)
- **FIX SKETCH**: setup.sh should write `.forge/` followed by `!.forge/collab/` and `!.forge/collab/**` when collab tracks are shared.

---

## Observations from PR #4 code review (verified earlier in this session)

### O005 — polling transport's default IO adapter writes are no-op stubs

- **CLAIM** (spec-collab R013 AC, `commands/collaborate.md`): `/forge:collaborate --polling` provides "zero-setup operation" using a `forge/collab-state` branch, "claims and messages are commits, polled every 2-3 seconds."
- **REALITY** (`scripts/forge-collab.cjs:672-680`): `_defaultPollingIo.writeLease()` and `.appendMessage()` are empty stubs. Inline comment acknowledges: "Real implementation would commit + push; shipped as a stub here so the connect/publish/subscribe loop is testable. T012 push-config task will wire auto-push vs prompted-push here." T012 landed `gatedPush` but never wired it into the IO adapter.
- **VERIFICATION**: ran alice `sendTargeted('bob', 'flag-ping', ...)` across two real git clones sharing a bare remote. No branch created, no commits, bob `_refresh()` got 0 messages. In-repo tests pass because every polling test injects a shared in-memory `_stubIo()`.
- **SEVERITY**: blocker (for polling mode)

### O006 — `sendTargeted` at transport layer broadcasts to all subscribers

- **CLAIM** (spec-collab R015 AC, T004 commit): "non-target participants receive zero messages."
- **REALITY**: both Ably (`forge-collab.cjs:494-497`) and polling (`forge-collab.cjs:577-593`) `subscribe` deliver every event to every subscriber. Target scoping is enforced by the application-layer subscriber callback (`tests/forge-collab.test.cjs:671-672`: `m => { if (m.data.target === 'daniel') ... }`), not by the transport. Works correctly but the invariant lives in userland, not the wire.
- **SEVERITY**: ux (works in practice if apps follow the envelope convention, but any consumer who subscribes without filtering leaks targeted messages to all)

### O007 — Ably `cas` is a local-only CAS with fire-and-forget broadcast

- **CLAIM** (spec-collab R006 AC): "A test with two simulated agents racing for the same task asserts exactly one wins."
- **REALITY** (`forge-collab.cjs:520-529`): mutates a local `Map` on the client, then `publish('lease-update', ...)` fires and forgets. Two Ably clients can both `cas(name, null, lease)` at the same moment because each checks its own cache with no cross-node authority. Eventual consistency arrives via the broadcast, but atomicity in a race is not guaranteed. Memory and stub-io tests don't exercise this because they share one `state` object.
- **SEVERITY**: partial (works under low contention, races not safe)

### O008 — `forge-tui render-test.cjs` fails on Windows due to CRLF/LF mismatch

- **CLAIM**: test suite green on main and on this branch.
- **REALITY**: 1/211 failure on main, 1/372 failure on this branch — both the same CRLF vs LF snapshot diff in `tests/forge-tui/render-test.cjs:62`. Pre-existing, platform-specific, not caused by PR #4 but affects "100% green" claims on Windows boxes.
- **SEVERITY**: ux

---

## Observations user raised from prior Forge runs (to verify during this cycle)

These came in from the user's follow-up and are not yet verified on my side — flagged here so the brainstorm scope can decide which to validate live.

### O009 — TUI does not run automatically when a Forge command starts
- Not yet reproduced on this session. Need to run `/forge:execute` or equivalent and observe whether the TUI auto-attaches.

### O010 — `/forge:brainstorm` does not dispatch parallel web-search subagents based on input
- Need to inspect `skills/brainstorming/SKILL.md` and the `forge-researcher` wiring to see whether multi-agent web search is spec'd vs implemented.

### O011 — Brainstorm Q&A is not asked one-question-at-a-time
- Command file says "minimum 3 clarifying questions" but doesn't enforce single-question cadence. Need to inspect the skill.
- **VERIFIED 2026-04-20 (T010 pre-fix read)**: `skills/brainstorming/SKILL.md` Phase 3 rule 1 already said "ONE question at a time. Never ask multiple questions in a single message" and Key Principles repeated it — so part of R004 AC1 was already in the prose. What was missing vs R004:
  - No mandate to summarise each answer in two sentences or fewer before the next question (rule 6 said "summarize periodically, every 3-4 answers" — too loose).
  - No hard maximum on question count (table said Medium 8-12 and Complex 8-12 per sub-project, which conflicts with R004 max 7).
  - No anti-pattern example block labelled "DO NOT do this".
  - No manual test protocol documenting expected behaviour.
- **FIX (T010)**: rewrote Phase 3 rules to mandate `Captured:` summary after every answer, tightened question bounds to min 3 / max 7, added correct-pattern and anti-pattern example blocks, created `skills/brainstorming/test.md` with a 5-question scripted run, and tightened Phase 2 `--from-code` / `--from-docs` paths to cap at 7.
- **SEVERITY (pre-fix)**: partial — single-question rule existed but summary cadence and upper bound did not.

### O012 — Dependency DAG streaming from upstream tasks to downstream tasks is missing
- User's memory is that earlier Forge versions streamed "criteria fulfilled on previous task → update and start next task" without waiting for full task completion. Need to compare `skills/executing/SKILL.md` + `scripts/forge-tools.cjs` frontier code against that claim.

### O013 — `<promise>FORGE_COMPLETE</promise>` fires on structural checks, not on perceptual UI verification
- User's "it's still blurry" from the graph-visual-quality run: 328 tests pass + `FORGE_COMPLETE` emitted, visualization still broken. Loop checks `task-status.json === complete`, not visual smoke. Need to inspect `scripts/forge-headless.cjs` or equivalent.

### O014 — setup-state silently sets `task_status: complete, current_task: null` on new spec
- Would cause "done" at iteration 0 unless caught manually. Need to reproduce.

### O015 — Sandbox blind spots: no dev server, no browser, no Playwright baseline recording in loop
- Verifiable by trying to wire Playwright MCP into the loop during this brainstorm. If it works here, then the framework can do it but doesn't by default; that's a spec gap, not an impossibility.

---

## Fix notes

### F001 — setup.sh idempotency gate fixed (T002, spec B R001)

- **CHANGE**: `scripts/setup.sh` now gates the early-exit on `[ -f "${FORGE_DIR}/config.json" ]` instead of `[ -d "${FORGE_DIR}" ]`. When the directory exists without `config.json`, setup emits `Completing partial Forge init in ...` and re-runs every `mkdir -p` plus a `cp -n` (never-clobber) copy of `templates/config.json` and `templates/state.md`. Token ledger + backprop log are written only if missing.
- **MESSAGE**: second run emits exactly `Forge already initialized (config.json present)` per AC4.
- **REGRESSION COVER**: `tests/setup.test.cjs` — four cases: (a) partial state with `.tui-log.jsonl` still scaffolds everything, (b) second invocation emits the sentinel message, (c) second invocation leaves git working tree clean in a git-initialized project, (d) directory-only (no config.json) does not short-circuit and still creates config.
- **OBSERVATION while fixing**: T001 (collab-fix R001) landed a parallel edit on the same file, adding `mkdir -p "${FORGE_DIR}/collab"` and the `.gitignore` carve-out block. The changes merged cleanly because T002 only touched the gate and the copy primitives. T001's own `tests/forge-collab-gitignore.test.cjs` has four residual failures unrelated to T002 — those live in T001's work-in-progress; switching `cp` -> `cp -n` actually moved T001 from 10/18 to 14/18 passing because several T001 test cases expected the second-run no-clobber behavior.
- **PRE-EXISTING UNRELATED FAILURE**: `tests/forge-tui/render-test.cjs` snapshot comparison fails on Windows because the saved snapshot uses `\r\n` while the live render emits `\n`. Confirmed failure exists on HEAD without any T002 change. Not addressed here.

---

## Observations from execute run (T011 — mock scaffold)

### O016 — spec R001 requires root `.gitignore` but frontier T011 task instruction lists `src/.gitignore`
- **CLAIM** (task T011 instructions at dispatch): scaffold should include `src/.gitignore`.
- **REALITY**: a `.gitignore` inside `src/` cannot exclude `node_modules/` and `dist/` that live at the mock root — those patterns only take effect from the directory where the `.gitignore` lives or below. The spec's R001 AC (and R006) requires `node_modules/`, `dist/`, `.forge/baselines/` excluded, which forces the file to be at the mock root.
- **RESOLUTION**: T011 placed the `.gitignore` at `mock-projects/blurry-graph/.gitignore` (spec-correct location). No `src/.gitignore` was created. The task instruction appears to be a minor typo in the frontier dispatch; spec R001 + R006 are the source of truth.
- **SEVERITY**: ux (dispatch-prompt typo, not a code bug)

### O017 — T011 ships three deliberate regressions as the first real fixture for the visual-verifier gate
- **CLAIM** (spec-mock-and-visual-verify R001): "the exact failure pattern from the real graph-visual-quality run: halo overlays on every node, random zoom-out on mount, empty synthesis panel."
- **REALITY** (commit 5598dc1): `mock-projects/blurry-graph/` renders a 10-node D3 force-directed graph. Three flag-toggled regressions are live with defaults `halo=true, zoomOut=true, synthesis=true, off=false`:
  - Halo: every node draws a translucent ring at 3x node radius (14 * 3 = 42px) in indigo, overlapping neighbours at the default 80px link distance.
  - Zoom-out: on mount `d3.zoom.transform` scales by `0.15 + Math.random() * 0.1`, producing a tiny cluster offset from centre.
  - Synthesis: right-side `<aside data-testid="synthesis">` renders only the `<h2>Synthesis</h2>` heading with no `<h3>Agreed</h3>` / `<h3>Disputed</h3>` sections.
  - `off = true` is the master kill-switch — all three bugs disable for golden-path screenshots.
- **NOTE**: `bun install` was intentionally not run per task instructions; the install happens in T023 when the E2E fix run executes.
- **SEVERITY**: n/a (observation, not a claim-vs-reality gap)

---

### O018 — README "squash-merge to main" phrasing does not match actual-branch behaviour

- **CLAIM** (pre-T005 README lines 44 + 99 + 103 + 211 + 245 + 334): Forge "squash-merges to main" and "One squash-merge to main" in the quickstart, hero, and execute-loop diagram.
- **REALITY**: successful task worktrees squash-merge to the *current working branch*, not `main`. This branch (`fix/collab-and-forge-audit`) is the live example: all T001..T017 merges landed here, never on `main`. Forge never force-pushes to `main`; it does not even push to remote without an explicit user action. The phrase "to main" conflates the most common demo path with the actual behaviour.
- **SEVERITY**: ux (works correctly; the word "main" misleads new readers who do feature-branch work)
- **STATUS**: T005 README rewrite introduced the phrasing "squash-merge to the branch" / "squash-merge to the working branch" in the new "How Forge Actually Works" section and its autonomy table. Older inline examples in README (Quickstart ASCII block, older mechanics diagrams) still say "main" and were left intact per the task's surgical-edits rule. A follow-up pass can sweep those once this observation is in the audit.
- **FIX SKETCH**: grep `README.md docs/` for `squash.?merge to main` and replace with `squash-merge to the working branch`; mention `main` only when describing the specific case of someone running Forge directly on the main branch.

---

### O019 — Parallel agents in one working directory collide on git state

- **CLAIM** (`/forge:execute` docs): the autonomous loop dispatches executor agents per task; implicit expectation is that each runs cleanly.
- **REALITY**: six T-agents launched in parallel against the same `C:\dev\forge-review\` working directory produced commit-label scrambling. Concretely, observed on this branch between commits `5598dc1..d0ebe03`:
  - `b514f1b` labelled `fix(brainstorming): one-question-at-a-time cadence [T010]` — diff is 39 lines of CLAIM_VS_REALITY.md only. T010 agent committed its audit-log update first before other agents committed code, under its own label.
  - `898c642` labelled `docs(audit): O016+O017 observations from T011 mock scaffold [T011]` — diff is `scripts/setup.sh` + `tests/setup.test.cjs`. This is actually T002's idempotency work committed under T011's label, because the T011 agent staged and committed while T002's edits were also in the working tree.
  - `fc8c533` labelled `fix(brainstorming): one-question-at-a-time cadence [T010] (skill + test)` — diff is `README.md` + `docs/mechanics/*`. This is T005's README rewrite committed under T010's retry label.
  - `d0ebe03` labelled `(retry)` — diff IS the brainstorming skill. T010 actually landed here after two retries.
- **ROOT CAUSE**: all six agents share one git index + working tree. When agent A commits, it sweeps agent B's staged + unstaged changes along for the ride, and the commit message reflects whichever agent's workflow reached `git commit` first.
- **SEVERITY**: blocker (for parallel dispatch correctness; every parallel run needs isolated worktrees).
- **RESOLUTION PATH**: spec-forge-v03-gaps R006 (streaming DAG) already mandates worktree isolation for provisional downstream tasks (per Sherlock research). The same mechanism must apply to every parallel executor dispatch, not just provisional ones. Proposed as a follow-up R under spec-forge-v03-gaps before its final merge.
- **WORKAROUND UNTIL FIXED**: only dispatch a single executor agent at a time until R006 worktree gating ships, or dispatch parallel agents only on tasks that touch disjoint file sets and serialize committal by having the outer loop (not the agents) do `git commit` after all agents return.

### O020 — T001 setup.sh half is NOT committed; test suite reflects this honestly

- **CLAIM** (F001 audit note from T002 execution): "T001 (collab-fix R001) landed a parallel edit on the same file, adding `mkdir -p .forge/collab` and the `.gitignore` carve-out block."
- **REALITY**: the current `scripts/setup.sh` on HEAD does NOT contain any collab carve-out or `.forge/collab/` handling. Verified by `grep -n "collab\|carve" scripts/setup.sh`. The only `.gitignore` write in setup.sh is still the legacy `echo ".forge/" >> "$GITIGNORE"`. F001's claim was incorrect — T001's setup.sh half never landed.
- **CONSEQUENCE**: 7 of 18 tests in `tests/forge-collab-gitignore.test.cjs` fail because they expect setup.sh to generate `.forge/collab/.gitignore` and the glob-form rules. These failures are accurate regression coverage for the remaining T001 work.
- **SEVERITY**: partial (half of T001 shipped; the other half is a known gap the tests correctly guard).
- **RESOLUTION PATH**: re-dispatch T001 with a narrowed scope after the rate limit reset ("only modify scripts/setup.sh to emit the glob-form .gitignore rules and create .forge/collab/.gitignore carve-out") — when it lands, the 7 failing tests flip to green without changes to the test file.

### O021 — Rate-limit interruption mid-run produced partial commits + orphan test files

- **CLAIM** (agent orchestration): long-running agent dispatch completes or reports NEEDS_CONTEXT.
- **REALITY**: all six Tier-1 agents returned `You've hit your limit · resets 2pm (Europe/Amsterdam)` after 12–14 minutes and 57–71 tool uses each. Partial work was left in the working tree; my outer-loop cleanup split the uncommitted state into T001 and T007 commits under correct labels.
- **SEVERITY**: ux (expected Anthropic API behaviour; Forge has no graceful-partial-commit protocol).
- **FIX SKETCH**: executor agent could write a `PARTIAL` checkpoint at every significant milestone (file written, test passing) so a rate-limit-interrupted task can be resumed by a fresh agent reading `.forge/progress/<task>.json`. Forge's existing checkpoint schema already supports this; the executor just needs to write more frequently than "end of task".

---

## Next entries to be added as brainstorming progresses.
