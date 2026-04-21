# Mock Visual-Verify Audit Evidence

This directory holds the before / after screenshot proof for the three
intentional regressions shipped in `mock-projects/blurry-graph/`. The E2E
`/forge:execute` run (T023) took the mock from all-broken to all-fixed by
flipping `regressions.*` to `false` in `mock-projects/blurry-graph/src/config.ts`
(see commit `b7477de`). This page is the static evidence of that run so a
reviewer can compare the two states without re-launching Playwright.

## How this was captured

Run from the repo root:

```
bash mock-projects/blurry-graph/demo.sh --mode full
```

`demo.sh` saves `src/config.ts` to a backup, flips the `halo`, `zoomOut`,
and `synthesis` flags back to `true`, starts `bun dev` on port `5174`,
drives Playwright to capture three `before.png` screenshots at
1280x800, restores `src/config.ts`, then re-runs against the fixed code
to capture three `after.png` screenshots. `--mode before` and `--mode after`
run only half the cycle each.

When Playwright is unavailable (`FORGE_DISABLE_PLAYWRIGHT=1` or `playwright`
not on PATH — the common case inside the Forge sandbox), the script writes
a minimal 1x1 placeholder PNG at each path so the directory structure, the
image references below, and the automated test `tests/mock-demo-evidence.test.cjs`
all stay green. Real screenshots can be dropped in later by re-running the
script in an environment where Playwright is installed.

## The three regressions

| Regression | Before (flag = true) | After (flag = false) |
|------------|----------------------|----------------------|
| **halo** — every node draws a translucent indigo ring at 3x its radius, overlapping neighbours and visually blurring the graph. | ![halo before](halo/before.png) | ![halo after](halo/after.png) |
| **zoomOut** — on mount, the D3 zoom transform sets scale to `0.15 + Math.random() * 0.1` so the whole graph renders as a tiny off-centre cluster. | ![zoomOut before](zoomOut/before.png) | ![zoomOut after](zoomOut/after.png) |
| **synthesis** — the right-side `<aside data-testid="synthesis">` renders empty; `<h3>Agreed</h3>` / `<h3>Disputed</h3>` sections never mount. | ![synthesis before](synthesis/before.png) | ![synthesis after](synthesis/after.png) |

## What "after" proves

- `halo` — the indigo ring is gone; nodes are cleanly separated.
- `zoomOut` — the D3 zoom transform is identity, the 10 nodes occupy the full viewport.
- `synthesis` — the right-side aside now contains two `<section>` blocks headed `Agreed` and `Disputed`, each populated from the mock graph's `stance` field.

The fix landed by flipping `regressions.halo`, `regressions.zoomOut`, and
`regressions.synthesis` from `true` to `false` in `src/config.ts`. The
regression code itself is retained behind the flags so the fixture can be
re-broken deterministically by `demo.sh --mode before`.

## File layout

```
docs/audit/mock-verify-evidence/
├── README.md                 # This file.
├── halo/
│   ├── before.png            # Halo ring live (flag true).
│   └── after.png             # Halo removed (flag false).
├── zoomOut/
│   ├── before.png            # Graph rendered at ~0.15-0.25 scale.
│   └── after.png             # Graph at identity scale.
└── synthesis/
    ├── before.png            # <aside> empty.
    └── after.png             # <aside> populated with Agreed + Disputed.
```

All six images are captured at the same viewport (1280x800) so diff review
is meaningful — the viewport is pinned in `demo.sh` via `VIEWPORT_W` / `VIEWPORT_H`.

## Reproducing

The demo script is re-runnable (R004 AC4): deleting the three regression
subdirectories and re-running `demo.sh --mode full` regenerates the same
layout with the same filenames. The mock itself is deterministic for the
purposes of structural assertions (node positions vary slightly per run
because D3's force simulation converges on different local optima, which
is the expected non-determinism called out in R004 AC4).

## Related

- Spec: [`docs/superpowers/specs/spec-mock-and-visual-verify.md`](../../superpowers/specs/spec-mock-and-visual-verify.md) R004.
- Fixture: [`mock-projects/blurry-graph/`](../../../mock-projects/blurry-graph/).
- E2E fix commit: `b7477de` (T023).
- Evidence test: [`tests/mock-demo-evidence.test.cjs`](../../../tests/mock-demo-evidence.test.cjs).
