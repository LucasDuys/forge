---
domain: mock-and-visual-verify
status: approved
created: 2026-04-20
complexity: standard
linked_repos: []
supersedes: []
relates_to: docs/superpowers/specs/spec-forge-v03-gaps.md
---

# Mock Project + Visual Verification Spec

## Overview

Forge 0.3 introduces a perceptual verification gate (spec-forge-v03-gaps R007). To prove the gate actually catches the kind of regressions that escape structural unit tests, we need a small controlled failure case plus end-to-end verification on top of it. This spec ships:

1. A minimal React + D3 knowledge-graph mock at `mock-projects/blurry-graph/` that ships deliberately broken — the exact failure pattern from the real graph-visual-quality run: halo overlays on every node, random zoom-out on mount, empty synthesis panel.
2. A spec file inside the mock that declares visual acceptance criteria consumable by the new `forge-visual-verifier` agent.
3. A `/forge:execute` run on the mock that autonomously fixes the three regressions, verified by Playwright screenshots before and after.
4. A negative test path: Playwright unavailable → executor reports BLOCKED, does not silently emit FORGE_COMPLETE.
5. Audit evidence saved to `docs/audit/mock-verify-evidence/` so the before/after proof can be reviewed without re-running the mock.

Uses the exact regression pattern the user hit in production so we are not testing against a strawman.

## Requirements

### R001: Mock project scaffolded with three intentional visual regressions

**Acceptance Criteria:**
- [ ] Directory `mock-projects/blurry-graph/` at repo root with a standalone Vite + React + D3 scaffold, its own `package.json`, `tsconfig.json`, and `.gitignore` scoped to Vite build output.
- [ ] Entry point at `mock-projects/blurry-graph/src/App.tsx` renders a simple force-directed graph of 10 nodes with labels.
- [ ] Regression 1 (halo overlay): every node draws a translucent halo ring 3x its radius that overlaps neighbour nodes. Toggled via `regressions.halo = true` in `src/config.ts`; the bug is live when flag is on.
- [ ] Regression 2 (random zoom-out): on mount, the D3 zoom transform sets scale to `0.15 + Math.random() * 0.1` so nodes appear tiny and off-centre. Toggled via `regressions.zoomOut = true`.
- [ ] Regression 3 (empty synthesis panel): a right-side panel labeled "Synthesis" renders an empty container. Expected content: two sections `<h3>Agreed</h3>` and `<h3>Disputed</h3>` each populated from the node graph. Toggled via `regressions.synthesis = true`.
- [ ] `bun install && bun dev` in the mock directory serves the app on `http://localhost:5174`.
- [ ] All three regressions live on the shipped code with flags default-true; a `regressions.off = true` global flag disables them cleanly for golden-path screenshots.

### R002: Spec file inside the mock declares visual + structural ACs

**Acceptance Criteria:**
- [ ] `mock-projects/blurry-graph/.forge/specs/001-readable-graph.md` with `status: approved` and three R-level requirements:
  - R001 (Readable nodes): visual AC + structural AC (node label text content matches data).
  - R002 (Sensible initial zoom): visual AC at two viewports (1280x800, 1920x1080).
  - R003 (Synthesis panel populated): visual AC + structural AC (count of `<h3>` elements inside synthesis = 2).
- [ ] Each visual AC uses the extended syntax from spec-forge-v03-gaps R007: `- [ ] [visual] path=/ viewport=1280x800 checks=[...]`.
- [ ] Mock's own `.forge/config.json` declares `sandbox.dev_server: "bun dev --port 5174"` and `sandbox.wait_url: "http://localhost:5174"`.

### R003: End-to-end execute run autonomously fixes all three regressions

**Acceptance Criteria:**
- [ ] Running `/forge:execute` from `mock-projects/blurry-graph/` with Playwright MCP available triggers the full loop on `001-readable-graph.md`.
- [ ] Dev server auto-starts per R010 lifecycle, visual-verifier takes baseline screenshots of the broken state, each R's AC fails with the expected reason (halo/zoom/synthesis).
- [ ] Executor applies fixes (setting `regressions.*` flags to false; or better, removing the regression code entirely — executor chooses per karpathy guardrail "surgical changes").
- [ ] Visual-verifier re-runs, all three R-level requirements pass, `<promise>FORGE_COMPLETE</promise>` fires.
- [ ] Total wall-clock time under 10 minutes on a typical developer machine (measured, not aspirational).

### R004: Audit evidence captured for before/after review

**Acceptance Criteria:**
- [ ] Script `mock-projects/blurry-graph/demo.sh` drives the full cycle headlessly and saves `before.png`, `after.png` for each of the three regressions to `docs/audit/mock-verify-evidence/<regression-id>/`.
- [ ] An index `docs/audit/mock-verify-evidence/README.md` embeds all six screenshots with captions.
- [ ] Screenshot dimensions consistent across before/after (same viewport, same crop) so diff review is meaningful.
- [ ] Demo script is re-runnable: deleting the evidence directory and running `demo.sh` regenerates it identically (no non-determinism in captured frames beyond what the mock itself produces).

### R005: Negative path — Playwright unavailable does not yield false COMPLETE

**Acceptance Criteria:**
- [ ] With Playwright MCP disabled (test harness sets `FORGE_DISABLE_PLAYWRIGHT=1`), `/forge:execute` on the mock emits `<promise>FORGE_BLOCKED</promise>` with a structured reason containing `{ gate: "visual", detail: "playwright_unavailable" }`.
- [ ] No task in `001-readable-graph.md` transitions to `task_status: complete` when the visual gate is BLOCKED.
- [ ] Stderr/logs contain clear actionable setup guidance: `Install Playwright MCP: claude mcp add playwright -- npx @playwright/mcp@latest`.
- [ ] Regression test runs this scenario in CI and asserts on the promise, the task status, and the guidance string presence.

### R006: Mock project is fully isolated from Forge's own code

**Acceptance Criteria:**
- [ ] `mock-projects/blurry-graph/` can be deleted recursively without touching Forge's own `node_modules`, tests, or runtime state.
- [ ] Mock has its own `.gitignore` that excludes `node_modules/`, `dist/`, and local `.forge/baselines/`.
- [ ] Mock does not import from Forge's scripts directly; the integration point is exclusively the `/forge:execute` CLI.
- [ ] Mock's `package.json` pins exact D3 + Vite versions for reproducibility over time (no caret ranges in runtime deps).

## Future Considerations

- Additional mocks for other regression patterns: layout thrashing, font loading FOUT, ARIA landmark violations, dark-mode contrast failures.
- A/B harness: run the same spec against Forge 0.2 (no visual gate) and 0.3 (with gate) and show the gap in a single diff view.
- Export evidence to a shareable HTML report for PR comments.
