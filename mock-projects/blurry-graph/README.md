# blurry-graph

An intentionally-broken Vite + React + D3 force-directed knowledge graph used
as a test fixture for Forge's visual-verifier harness. This project is NOT
Forge itself — it is a self-contained mock application that ships three
deliberate regressions the verifier must detect and auto-fix.

See `docs/superpowers/specs/spec-mock-and-visual-verify.md` for the full
fixture contract (requirements R001–R006).

## What this mock does

- Renders ten nodes (`Alpha` … `Juliet`) in an SVG canvas, linked in a small
  chain, laid out by a D3 force simulation.
- Each node is coloured by stance: green for `agreed`, red for `disputed`.
- A right-hand `Synthesis` panel lists the agreed and disputed nodes in
  separate sections.
- Depending on the flags in `src/config.ts`, the rendering is subtly or
  not-so-subtly broken.

## How to run it

From the Forge repo root:

```
cd mock-projects/blurry-graph
bun install
bun dev
```

The dev server starts on port `5174` (the port is pinned via `vite.config.ts`
so Playwright-based verifiers can hit a known URL without searching).

Alternate runners (`npm install && npm run dev`, `pnpm install && pnpm dev`)
work too — the project pins exact versions for reproducibility, so any Node
package manager that respects `package.json` resolves to the same tree.

## The regression flags

`src/config.ts` exports a single `regressions` object:

```ts
export const regressions = {
  halo: true,       // Regression 1
  zoomOut: true,    // Regression 2
  synthesis: true,  // Regression 3
  off: false        // Master kill-switch — golden-path screenshots
};
```

| Flag        | Effect when `true`                                                                                   |
|-------------|------------------------------------------------------------------------------------------------------|
| `halo`      | Draws a translucent indigo ring at 3× node radius on every node. Halos overlap neighbours and visually blur the graph. |
| `zoomOut`   | Applies a random zoom transform (scale ~0.15–0.25) on mount, so the whole graph renders as a tiny offset cluster.      |
| `synthesis` | Renders the `Synthesis` panel as empty — the `<aside>` node with `data-testid="synthesis"` is present but has no `<section>` children. |
| `off`       | Master kill-switch. When `true`, **no** regression applies regardless of the other flags. Used to capture golden-path baselines. |

To toggle: edit `src/config.ts`, flip the boolean, save. Vite HMR picks up
the change immediately. To capture a clean baseline, set `off: true`; to
reproduce the broken state the verifier must fix, leave the three flags at
their default `true` values with `off: false`.

## How Forge uses this mock as a test fixture

Forge's visual-verifier agent (see
`docs/superpowers/specs/spec-mock-and-visual-verify.md`, R001–R005)
runs an end-to-end harness that:

1. Boots `bun dev` inside this directory.
2. Takes Playwright screenshots of the running page.
3. Compares structure (DOM) and visuals (pixels) against the spec's
   acceptance criteria.
4. Emits a verdict: `COMPLETE` only if all three regressions are absent
   and the structural checks pass; `BLOCKED` if Playwright is unavailable.
5. Auto-fixes the regressions by editing `src/config.ts` and/or `src/App.tsx`
   until the verifier passes.

The mock is intentionally isolated from Forge's own runtime (R006):

- No Forge source file under `scripts/`, `agents/`, `hooks/`, `skills/`,
  or `commands/` imports or requires from `mock-projects/`.
- The mock has its own `package.json`, its own `node_modules/`, its own
  `.gitignore`, and its own `.forge/baselines/` scratch space.
- Deleting `mock-projects/blurry-graph/` recursively does not break the
  Forge test suite. The `tests/mock-isolation.test.cjs` regression test
  enforces this invariant on every CI run.

## Directory layout

```
mock-projects/blurry-graph/
├── .forge/                  # Scratch space for fixture runs (baselines, etc.)
├── .gitignore               # Excludes node_modules/, dist/, .forge/baselines/
├── README.md                # You are here.
├── index.html               # Vite entry HTML.
├── package.json             # Pinned exact versions of react, react-dom, d3, vite, @vitejs/plugin-react.
├── src/
│   ├── App.tsx              # Force-directed graph + regressions.
│   ├── config.ts            # The three regression flags + master kill-switch.
│   └── main.tsx             # React entry.
├── tsconfig.json
└── vite.config.ts           # Pins dev port to 5174.
```
