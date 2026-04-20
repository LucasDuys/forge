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

### O012 — Dependency DAG streaming from upstream tasks to downstream tasks is missing
- User's memory is that earlier Forge versions streamed "criteria fulfilled on previous task → update and start next task" without waiting for full task completion. Need to compare `skills/executing/SKILL.md` + `scripts/forge-tools.cjs` frontier code against that claim.

### O013 — `<promise>FORGE_COMPLETE</promise>` fires on structural checks, not on perceptual UI verification
- User's "it's still blurry" from the graph-visual-quality run: 328 tests pass + `FORGE_COMPLETE` emitted, visualization still broken. Loop checks `task-status.json === complete`, not visual smoke. Need to inspect `scripts/forge-headless.cjs` or equivalent.

### O014 — setup-state silently sets `task_status: complete, current_task: null` on new spec
- Would cause "done" at iteration 0 unless caught manually. Need to reproduce.

### O015 — Sandbox blind spots: no dev server, no browser, no Playwright baseline recording in loop
- Verifiable by trying to wire Playwright MCP into the loop during this brainstorm. If it works here, then the framework can do it but doesn't by default; that's a spec gap, not an impossibility.

---

## Next entries to be added as brainstorming progresses.
