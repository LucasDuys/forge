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
- **STATUS**: RESOLVED by T013. See F004 below — `_defaultPollingIo` now runs a full single-commit amend + force-with-lease CAS loop against `forge/collab-state`, with a cross-process wire test at `tests/forge-collab-polling-real.test.cjs` covering the race-resolution, retry-exhaustion, TTL-pruning, and gated-push paths.

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
- **VERIFIED 2026-04-20 (T012 pre-fix read)**: `commands/execute.md` had no hook to spawn the TUI between `setup-state` and the `forge:executing` handoff, so `/forge:execute` in `autonomy: full` stayed headless by design. The `/forge:watch` path existed as a separate command but had to be launched manually in a second terminal.
- **FIX (T012)**: added `scripts/forge-tui-attach.cjs` -- a decision helper invoked by `commands/execute.md` immediately after `setup-state`. Branches:
  - `autonomy !== "full"` -> silent no-op (gated/supervised flow preserved, R003 AC4).
  - `.forge/config.json` `tui.auto_attach: false` -> silent no-op (opt-out, default true per R003 AC5).
  - `process.platform === "win32"` -> prints `Monitor progress with: /forge:watch` to stdout and exits, no fork attempt (R003 AC3).
  - `tmux` missing on `$PATH` (non-Windows) -> same headless message, no fork attempt (R003 AC3).
  - Unix + tmux available -> `tmux new-session -d -s forge-tui-<pid> node scripts/forge-tui.cjs --forge-dir .forge` detached, unref'd, stdout `Attach: tmux attach -t forge-tui-<pid>` (R003 AC1, AC2).
  Regression test at `tests/tui-auto-attach.test.cjs` covers the five AC branches plus a malformed-config fallback via a `FORGE_TUI_ATTACH_DRY_RUN=1` hook and `FORGE_TUI_ATTACH_FAKE_PATH` / `FORGE_TUI_ATTACH_FAKE_PLATFORM` / `FORGE_TUI_ATTACH_FAKE_PID` injection points. 8/8 green.
- **SEVERITY (pre-fix)**: medium -- feature was implied by the architecture (the TUI renderer already existed) but wiring was absent from `/forge:execute`.

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
- **STATUS**: RESOLVED by T009 (spec-forge-v03-gaps R008). See F003 below.

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

### F002 — setup.sh collab carve-out landed; 7 T001 residual failures now green (T001, spec-collab-fix R001 AC1 + AC4)

- **CHANGE**: `scripts/setup.sh` now emits the glob-form collab carve-out (`/.forge/*`, `!/.forge/collab/`, `!/.forge/collab/**`) under a `# forge: collab carve-out` marker instead of the legacy bare `.forge/` rule, and copies `templates/collab-gitignore` to `.forge/collab/.gitignore` so per-machine state (`participant.json`, `flag-emit-log-*.jsonl`, `.enabled`) stays local while shared collab artifacts propagate via git. `mkdir -p "${FORGE_DIR}/collab"` added to the scaffolding list so the nested .gitignore has a parent on first init.
- **NEW FILE**: `templates/collab-gitignore` — three lines (`participant.json`, `flag-emit-log-*.jsonl`, `.enabled`) with a header comment.
- **IDEMPOTENCY**: two paths. Outer gate `[ -f "${FORGE_DIR}/config.json" ]` short-circuits second invocations with `Forge already initialized (config.json present)` per F001. Inside the gitignore writer, a `grep -qF "# forge: collab carve-out"` check makes partial re-inits a no-op even if config.json is missing but the marker is already present.
- **LEGACY MIGRATION**: setup.sh deliberately does NOT rewrite an existing bare `.forge/` rule. That path is handled out-of-band by `scripts/forge-collab.cjs::patchGitignore`, surfaced by `/forge:collaborate start` on detection of `legacy_rule_no_carve_out`. This keeps setup.sh idempotent across re-inits of existing checkouts without clobbering user-curated ignores.
- **TEST RESULT**: `node scripts/run-tests.cjs --filter gitignore` — 18/18 pass (all 11 git-gated tests run when git is on PATH, duration jumps from 87 ms stub-skip to 3.8 s real-git). Full suite 425/426; the 1 failure is the pre-existing TUI CRLF/LF snapshot mismatch on Windows documented in O008.
- **MANUAL VERIFICATION**: `git check-ignore` on a fresh `bash scripts/setup.sh` temp dir confirms AC3 (`.forge/collab/inputs-lucas.md` and `.forge/collab/brainstorm/inputs-lucas.md` not ignored), AC4 (`participant.json`, `flag-emit-log-*.jsonl`, `.enabled` ignored by nested rule), and the outside-collab baseline (`.forge/state.md` still ignored, `.forge/collab/flags/FLAG-123.json` tracked).
- **RESOLVES**: O004 (setup.sh gitignored `.forge/` unconditionally), O020 (T001 setup.sh half never landed).

### F003 — writeState R008 guard + setup-state ingest hardening (T009, spec-forge-v03-gaps R008)

- **CHANGE** (scripts/forge-tools.cjs):
  1. `writeState()` now runs `_assertStateCompleteAllowed` before every serialize (both legacy 3-arg and partial 2-arg forms). A write that sets `task_status: complete` is rejected unless all three gates are green: (a) an active spec is declared in frontmatter, (b) `.forge/plans/<spec>-frontier.md` exists and parses, (c) every task id from that frontier has a registry entry in `.forge/task-status.json` whose status is one of `{complete, complete_with_concerns, DONE, DONE_WITH_CONCERNS}` (both the internal lowercase form and the forge-executor status-report form are accepted).
  2. Violations append one JSONL line to `.forge/history/cycles/<cycle>/state-violations.jsonl` with a stable shape: `{at, attempted, reason, frontier_path, missing_task_ids}`. Cycle id reuses `state.data.cycle` when present, otherwise a compact ISO stamp (`YYYYMMDDTHHMMZ`). After logging, the guard throws an `Error` with `code: 'E_STATE_WRITE_GUARD'` so the caller sees the problem at the write site.
  3. `setup-state` CLI is now authoritative for three frontmatter fields on ingest: it unconditionally writes `task_status: pending`, `current_task: <first task id of the active spec>`, `completed_tasks: []`, and `blocked_reason: null`, regardless of whatever frontmatter the inbound `state.md` happens to claim. The first-task lookup prefers the active spec's frontier; if that is unknown it falls back to the first task across all frontiers, then to `T001`. This is what closes the graph-visual-quality "fresh spec ships with `task_status: complete`" trap.
- **REGRESSION COVER** (`tests/setup-state-guard.test.cjs`, 12/12 green):
  - Direct writeState attempts with `task_status: complete` on a fresh spec produce `E_STATE_WRITE_GUARD` and a single JSONL line that names the three non-DONE tasks.
  - Frontier-missing and spec-missing cases both throw with distinct, actionable reasons.
  - All-gates-green writes succeed (registry uses internal `complete`/`complete_with_concerns`; second test covers the `DONE`/`DONE_WITH_CONCERNS` status-report shape).
  - Pending tasks are singled out in `missing_task_ids` so operators can tell at a glance which work is still open.
  - Non-complete writes (pending/testing/reviewing/blocked/null) pass through untouched.
  - Legacy 3-arg full-write form is also guarded.
  - CLI `setup-state` run against an adversarial state.md (`task_status: complete, current_task: null, completed_tasks: [...]`) rewrites frontmatter to the hard-coded defaults. Multi-spec workspace test confirms `current_task` lands on the active spec's first task, not some other frontier's T001.
  - Violation JSONL shape is locked to exactly five keys in sorted order; `at` is a real ISO timestamp; `reason` is >10 chars and prefixed `Refusing task_status=complete`.
- **FULL SUITE**: 485/486 green. The one failure is the pre-existing O023 TUI CRLF snapshot, unrelated to T009.
- **SCOPE NOTE**: the guard is strict on purpose. Per-task `task_status: complete` writes (the historical "this task finished, route to next" signal) will now be rejected unless the whole frontier is DONE. This is what R008 AC2 literally requires ("every status entry is one of {DONE, DONE_WITH_CONCERNS}"). In practice the rest of the codebase writes task-done state to the registry (`markTaskComplete`) and uses other `task_status` values (`testing`, `reviewing`, `implementing`, `null`) during per-task lifecycle transitions; only the legitimate spec-level completion flip lands `task_status: complete`, and it passes when the registry agrees. The one in-file callsite that writes per-task `'complete'` (`verifyStateConsistency` at line ~2898) is self-healing reconciliation: when it runs, the registry already shows `complete` for the current task, so the guard continues to pass for any single-task frontier; multi-task frontiers where only one task is done will now surface a violation, which is the correct behavior — the spec-level flag is semantically wrong in that state.
- **RESOLVES**: O014.

### F004 — polling transport writes are real: amend + force-with-lease CAS (T013, spec-collab-fix R002)

- **CHANGE** (`scripts/forge-collab.cjs:_defaultPollingIo`): replaced the two no-op stubs (`writeLease`, `appendMessage`) plus the read-only `ensureBranch`/`readBranch` pair with a full single-commit-on-ref implementation driven by git plumbing. Every mutation runs the `_mutate` loop:
  1. `git fetch origin +<branch>:refs/remotes/origin/<branch>` (forced tracking update so a rejected push never leaves the local tracking ref ahead of origin).
  2. `git ls-remote origin refs/heads/<branch>` (authoritative CAS-expected sha; local tracking is a snapshot, ls-remote is truth).
  3. `git show <sha>:state.json` to materialize `{ leases, messages }`.
  4. Apply the mutator. `writeLease` honours an optional `{ expected }` — if `state.leases[name]` no longer matches on re-read, the mutator aborts with `{ ok: false, reason: 'cas_race_lost', current }`. `appendMessage` prunes entries where `Date.now() - Date.parse(ts) > ttl_seconds * 1000` (default 300) before appending and dedupes by `id`.
  5. Build a *rootless* commit: `git hash-object -w --stdin` -> `git mktree` -> `git commit-tree <tree> -m "forge-collab: update state.json"` with **no `-p` parent**, so every push replaces the ref with a one-commit history.
  6. `gatedPush(['push', '--force-with-lease=refs/heads/<branch>:<expected-sha>', 'origin', '<commit>:refs/heads/<branch>'], {...})` so the user's `auto_push` preference is honoured (T012 wiring).
  7. On push rejection (`stale info|non-fast-forward|rejected|force-with-lease|cannot lock ref`), re-loop. Up to 3 retries with 100 ms linear backoff. 4th rejection returns `{ ok: false, reason: 'cas_exhausted', error }`.
- **BOOTSTRAP** (`ensureBranch`): if origin has no `forge/collab-state` ref, seeds it with an empty `{ leases:{}, messages:[] }` commit via the same plumbing and `--force-with-lease=refs/heads/<branch>:` (empty expected = "ref must not exist"). Two clients racing the seed: one lands, the loser's rejection is swallowed and a fresh fetch surfaces the winner's ref — so a quiet no-op on the loser side rather than a hard error.
- **STDIN FIX**: the earlier stub used `stdio: ['ignore', 'pipe', 'pipe']` uniformly. `hash-object --stdin` needs real stdin, so the new `run()` helper switches stdio[0] to `'pipe'` whenever `input` is present. Missed this in the first pass — hash-object was silently hashing empty input, producing a tree with no `state.json` entry. Caught by the wire test failing with `fatal: path 'state.json' does not exist in 'refs/heads/forge/collab-state'` after the commit landed.
- **BACKWARD COMPAT**: `writeLease(branch, name, next)` without the 4th `{ expected }` option is a plain setter — matches the shape the existing fire-and-forget call in `createPollingTransport.cas` uses (`forge-collab.cjs:642`). The in-repo `_stubIo()` tests (153/153) all continue to pass unchanged. `readBranch` still returns just the state object (not `{state, sha}`), so the existing `_refresh()` consumer is unaffected.
- **NEW EXPOSED SURFACE**: `_internal._defaultPollingIo` at module level; `_internal.io` and `_internal.branch` on the polling transport. Both added so cross-process tests can reach the real adapter from a clone's cwd without patching the whole transport.
- **NEW TEST FILE** (`tests/forge-collab-polling-real.test.cjs`, 4/4 green): first in-repo test that exercises the real IO adapter end-to-end instead of a stub.
  - **Two-subprocess race**: spawns two node children with separate clones of a shared bare remote in `os.tmpdir()`, each calls `writeLease('claim:T001', lease, { expected: null })` against the same branch with a wall-clock barrier so their race windows overlap. Asserts exactly one `{ ok:true }`, one `{ ok:false, reason:'cas_race_lost' }`, and that the bare repo's `forge/collab-state` ref holds exactly one commit (per R002 AC4 "single commit on ref regardless of N operations"). Winner's claimant is either alice or bob and the loser observes it on re-read.
  - **`cas_exhausted` path**: injected runner returns a non-fast-forward error on every push; retries exhaust and the caller sees `{ ok:false, reason:'cas_exhausted' }` (R002 AC3).
  - **TTL pruning**: `_pruneMessages` drops entries older than `ttl_seconds` and `appendMessage` completes `{ ok:true }` with the pruned state.
  - **Gated push**: with `autoPush:false` and no prompter, `writeLease` returns `{ ok:false, reason:'auto_push_disabled_no_prompter' }` — the user's auto_push preference gates the write before the ref changes (R002 AC5, integrating with F003's T012 wiring).
  - All subprocess cleanup via `fs.rmSync(root, { recursive:true, force:true, maxRetries:3 })`, wrapped in try/catch for Windows-locked files.
- **FULL SUITE**: 496/497 green (all 4 new tests + 153 existing forge-collab tests + 18 gitignore tests). The single failure is the pre-existing O008/O023 Windows CRLF snapshot in `tests/forge-tui/render-test.cjs`, unchanged by T013.
- **KEY DECISIONS** (for the record):
  - Rootless commit per mutation (no `-p`): fulfils R002 AC4 cleanly and makes race detection trivial. Downside: `git log <branch>` shows only the latest state, no history. Acceptable because the state document is the substrate, not the history.
  - `ls-remote` rather than `rev-parse refs/remotes/origin/<branch>` as the CAS-expected-sha source: local tracking refs go stale after a rejected push, and force-with-lease needs the true remote tip. Costs one extra network roundtrip per mutation; fine for a 2.5 s polling cadence.
  - `cas_race_lost` reason is optional-opt-in via `{ expected }` so existing `cas()` fire-and-forget callers (R013 stub tests) keep last-writer-wins semantics. The transport layer's `cas()` is still sync + local-only; wire test calls `io.writeLease` directly to observe the race-resolution outcome, matching the task-brief instruction "each calls `cas` on the same lease name simultaneously → asserts exactly one returns `{ok: true}`, the other returns `{ok: false, reason: "cas_race_lost"}` or similar".
- **RESOLVES**: O005 (polling transport writes were no-op stubs; now real). Partially addresses the lattice of O006/O007 — this task only touches the polling transport; O006 (transport-layer target filter across all backends) and O007 (Ably CAS authoritative) remain open for T022 and T024.

### F005 — First non-stub cross-node test in the collab suite (T013, spec-collab-fix R006)

- **OBSERVATION**: every prior collab test used `_stubIo()` so stub-masked regressions could hide behind a green suite (O005 was literally this). `tests/forge-collab-polling-real.test.cjs` is the first test that spawns real subprocesses against a real bare git remote.
- **PATTERN**: subprocess bodies live in `CHILD_SCRIPT` (a string) written to a tmp file at test startup, then spawned via `spawn(process.execPath, [childPath, FORGE_COLLAB, cwd, handle, BRANCH, barrier])`. Initial attempt used `node -e <script> <args>` directly but Windows/argv interaction dropped the first positional arg. Tmp-file approach is portable.
- **WALL-CLOCK BARRIER**: both children sleep until `Date.now() === barrier` (~400 ms after dispatch) before calling `writeLease`, so the race is actually contended at the push layer rather than serialized by spawn latency.
- **CROSS-PROC DETERMINISM**: the test asserts exactly-one-winner + cas_race_lost invariant, not which specific clone wins (timing-dependent, first-push-to-bare wins). State.json on the bare ref is checked for either claimant.
- **CLEANUP**: tmpdir rm with `{ recursive:true, force:true, maxRetries:3 }` in a `finally` block; Windows-locked-file best-effort.
- **RUNTIME**: 2.0 s on this machine for all 4 tests; well under the R006 AC "under 30 seconds on CI" target.
- **RELEVANT TO O019** (parallel agents collide on git state): the wire-test pattern is also the template for future multi-process tests. It uses isolated clones + a shared bare, which is the same isolation model that O019's worktree resolution will need. Useful reference when spec-forge-v03-gaps R006 streaming-DAG worktree isolation gets built.

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
- **RELATED**: F005 (T013 wire test) is the first in-repo test using real subprocesses + isolated clones + a shared bare remote. Useful as a reference pattern for future worktree-isolation tests once R006 streaming-DAG isolation ships.

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

### O022 — Legacy `discover` found <10% of installed surface; new walker closes the gap

- **CLAIM** (spec-forge-v03-gaps R002 intro): "forge-tools.cjs discover currently finds semantic-scholar as the only MCP server and misses 9+ other servers active on the user's machine, zero skills vs 65+ installed, and 3 CLIs vs many on $PATH."
- **REALITY (pre-T003)**: legacy `discoverCapabilities` read MCP servers only from `.claude.json`-style paths, relied on a non-existent `installed_plugins.json` manifest for plugins, and never walked SKILL.md anywhere. On this machine the legacy run returned 1 MCP server + 0 skills + 0 plugins + 3 CLI tools.
- **REALITY (post-T003)**: 10 MCP servers (merged from `~/.mcp.json` + `~/.claude.json`), 72 skills (user + plugin-shipped), 16 plugin manifests via `.claude-plugin/plugin.json` walk, 3 CLI tools from the declared allow-list (node/npm/stripe — others like `git`, `bun`, `claude` genuinely absent from the sandbox PATH under MSYS even though binaries exist on the machine). Total discover runtime 215ms on Windows dev machine, well under the 3s target.
- **SEVERITY**: gap closed.
- **NOTE**: plugin manifests are at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json`, not at `<root>/plugin.json`. The walker handles both by matching the `plugin.json` basename at any depth ≤ 4 below the cache root.
- **FOLLOW-UP**: CLI probe reports only what is on `$PATH` in the current sandbox. If Forge ever runs agents in a shell where `git` or `bun` is elsewhere, the probe correctly reports absence. Downstream callers that need "is git reachable anywhere" should not rely on `cli_tools.git`.

### O023 — Pre-existing TUI snapshot test fails on Windows with CRLF-sensitive fixtures

- **CLAIM** (nothing): noticed while running the full suite for T003 verification.
- **REALITY**: `tests/forge-tui/render-test.cjs` "snapshot matches saved render" fails with a diff of trailing `\r\n` lines against a fixture that stores `\n`. The failure exists on HEAD (`c98c0b3`) before any T003 edit; verified by `git stash` + re-run.
- **SEVERITY**: test-only; CI might not hit this if CI is Linux, but every Windows contributor sees a red suite.
- **FIX SKETCH**: either normalize the snapshot's line endings on read, or write fixtures with `\r\n` and compare byte-for-byte. Out of scope for T003; logged here so the next TUI-touching task can sweep it.

### O024 — Bare-name path references in specs are flagged as "missing" by the R011 validator

- **CLAIM** (spec-forge-v03-gaps R011): "Before planning, a `forge-speccer-validator` step enumerates every path token in the spec (heuristic: anything that parses as a file path and lives in a code fence or backticks)."
- **REALITY** (T004 implementation, `scripts/forge-speccer-validator.cjs`): running the validator on `docs/superpowers/specs/spec-forge-v03-gaps.md` flags 8 paths as missing, most of which are correct concepts but referenced by bare name: `setup.sh` (lives at `scripts/setup.sh`), `config.json` (lives at `.forge/config.json`), `state.md` (lives at `.forge/state.md`), `token-ledger.json` (lives at `.forge/token-ledger.json`), `forge-tools.cjs` (lives at `scripts/forge-tools.cjs`), `task-status.json` (lives at `.forge/task-status.json`), `history/backprop-log.md` (lives at `.forge/history/backprop-log.md`).
- **SEVERITY**: ux (the spec is semantically correct for humans; the validator correctly catches that the bare names do not resolve under the repo root).
- **NOTE**: `agents/forge-visual-verifier.md` is also flagged because T020 has not shipped yet — this is a valid "will-exist-after-R007-lands" reference. The validator cannot distinguish forward-looking path claims from typos.
- **FIX SKETCH**: two options for spec authors — (1) always write fully-qualified paths (`scripts/setup.sh` not `setup.sh`), or (2) extend the heuristic to treat bare-name references as "probable" rather than "claim" and demote them from missing to warning. Option (1) is simpler and makes specs more precise; option (2) preserves natural prose style. Recommend option (1) and a follow-up sweep of existing specs.
- **STATUS** (T004): validator ships as-is. Replan autocorrect uses `findNearestPath` which will suggest `scripts/setup.sh` for a bare `setup.sh` reference (matching basename, zero shared segments → still the only same-basename hit). So downstream replan behaviour is correct; the noise is at the user-surface layer.

### O025 — No git binary on the sandbox PATH means T004 cannot self-verify its commit

- **CLAIM** (forge-executor protocol step 4): "Create an atomic commit for this task."
- **REALITY**: the sandbox shell used by the T004 executor agent has no `git` on PATH (`git --version` → `command not found`). The agent authored all files, ran the full test suite (455/457 green, the 2 failures are pre-existing O023 + unrelated T006 skills-audit), but cannot execute `git add` / `git commit`.
- **SEVERITY**: partial (work is complete and tested; human-operator must finalise the commit).
- **WORKAROUND**: executor returns DONE_WITH_CONCERNS with a pre-drafted commit message (`feat(planner): spec path validation gate [T004]`) and the list of files touched; outer loop runs the actual git commands.
- **FILES**: `scripts/forge-speccer-validator.cjs` (new), `agents/forge-speccer-validator.md` (new), `tests/spec-path-validation.test.cjs` (new), `commands/plan.md` (modified — new "Spec Path-Validation Gate (R011)" section inserted before "Invoke Planning").

---

## Next entries to be added as brainstorming progresses.
