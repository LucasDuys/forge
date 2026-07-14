# Optical Context Memory — Technical Project Plan

Goal: a memory backend for agentic processes (forge, Claude Code sessions)
that cuts token usage and extends effective context. Research
(`RESEARCH.md`) + local measurements (`REPORT.md`) say the original idea —
"convert everything to images" — works only inside a narrow regime, so the
plan is **text-first with an optical tier**, not optical-first.

## What the research settled

| Question from the original idea | Answer |
|---|---|
| Can images carry text for fewer tokens? | Yes: 1.9x (any tier) to 2.4–3.0x (high-res tier) — verified arithmetic, patch formula `ceil(w/28)×ceil(h/28)` |
| At 100% readability? | **No.** No published accuracy floor for Claude on dense text; ~2% CER third-party ⇒ ~0% chance of verbatim-perfect 30k-char pages. Failure modes hit exactly the high-stakes content: code, UUIDs, hashes, paths |
| Deterministic token-efficient translation? | Yes, but not gzip (tokenizers shred binary) and not stopword-stripping (costs 12–20% accuracy). Winners: TOON/compact-JSON serialization (40–60% on tabular), TSCG-style schema compilation (50–72%, zero-dep JS, *improves* accuracy), n-gram abbreviation with legend (~1.4x) |
| Pages → sections with metadata for search? | Converged industry pattern: tiny always-hot text index + lazy hydration by ID (Anthropic memory tool: 84% savings; claude-mem: ~10x from filter-before-fetch). **Index must stay text — never pixels** |
| Model for interpretation? | Only high-res-tier Claude models (Fable/Mythos 5, Opus 4.7/4.8, Sonnet 5) see full-res pages. Haiku silently downscales to illegibility. Dollar math: text-on-Haiku can beat image-on-Sonnet |
| Colibri? | Identified: [JustVugg/colibri](https://github.com/JustVugg/colibri) — pure-C engine running GLM-5.2 (744B MoE) in ~25GB RAM via disk-streamed experts, ~0.3–1.2 tok/s warm. Too slow for the interactive read path; viable as a $0 offline "librarian" for metadata generation, and its memory-hierarchy design is the blueprint for ours. Full assessment: `SCALE.md` §4 |

Killer constraints discovered (each can erase the saving):
1. **Quote-back**: output tokens ≈ 5x input price; an agent echoing exact
   strings (`old_string`/`new_string`) out of an image pays >10x the saving.
2. **Cache inversion**: editing an image invalidates its prompt-cache
   entry; append-only text rides at ~0.1x. Optical pages must be immutable.
3. **Reading ≠ reasoning**: transcription survives to ~10x compression
   (DeepSeek-OCR) but *task performance* only to ~3–4x (Glyph). Budget ≤3x.
4. **Partial pages always lose** — page cost is fixed by area, not fill.

## Architecture

```
                        ┌──────────────────────────────────────────┐
 agent (forge/CC)  ───► │ HOT: section index (always text, in ctx) │  ~350 B/section
                        │ id | title | keywords | gist | locator   │
                        └───────────────┬──────────────────────────┘
                            search (BM25/FTS5, later ColPali)
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │ WARM: canonical text store (files)       │  ground truth,
                        │ deterministic transforms applied:        │  always present
                        │ TOON/compact-JSON, schema compile,       │
                        │ abbreviation legend, terse mode          │
                        └───────────────┬──────────────────────────┘
                        hydrate by path (fidelity-critical: code,
                        diffs, ids)  OR  hydrate as page (cold prose)
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │ COLD (optional, flag-gated): rendered    │  1,521–3,136
                        │ immutable PNG pages, packed 10–12px mono │  tok/page,
                        │ logs, transcripts, reference docs ONLY   │  ≤3x effective
                        └──────────────────────────────────────────┘
```

Every image page is derived from a canonical text file that always exists —
a misread is recoverable by re-hydrating the text. Images are a *transport
optimization*, never the source of truth.

## Phases

### Phase 1 — Measure the real gate (this week, ~$5 of API)
The one number nobody has published: Claude's character error rate on OUR
rendering at 10/11/12px, prose vs code, loose vs tight line pitch.
- Run `claude_roundtrip.py` (built, needs `ANTHROPIC_API_KEY`) across the
  sweep grid on Sonnet 5 and Haiku 4.5.
- Add a *comprehension* variant (ask questions about page content, not
  transcription) — that tests the Glyph reading≠reasoning gap on Claude.
- **Gate**: if CER > 0.1% at every ≥1.5x density for transcription, the
  optical tier is dead for recall use; keep it only for gist-tolerant
  content, and Phases 2–3 still deliver the token savings alone.

### Phase 2 — Deterministic translation layer (no pixels, no risk)
Port the winners into `forge-tools.cjs` (CJS, zero-dep, per repo rules):
- compact-JSON/TOON-style serializer for state/checkpoints/ledgers
- TSCG-style tool-schema compiler (MIT reference impl exists, 34.7KB JS)
- n-gram abbreviation with an embedded legend for recurring forge phrases
- Wire into existing `formatCavemanValue()` call sites; benchmark against
  `docs/benchmarks/caveman-integration.md` (target: beat its 12% honestly).
Expected: 20–70% off structured internal content, zero fidelity risk.

### Phase 3 — Section index + lazy hydration (the actual token win)
- Productionize `sectionize.py` logic in JS: deterministic sectioning,
  metadata (title/keywords/gist/locator), BM25 in pure JS (index is small;
  `node:sqlite` lacks FTS5 — avoid native deps).
- Storage: `.forge/memory/{index.json, sections/*.txt}` append-only.
- Agent surface: `memory_search(query) → ids`, `memory_get(id) → text`
  as forge tools; hot index pinned in context.
- This layer alone is where Anthropic's own memory tool gets 84% savings.

### Phase 4 — Optical tier (only if Phase 1 gate passes)
- `render.py` pipeline as a storage backend for cold prose: packed,
  ascii-safe, immutable pages; `memory_get` returns an image block with
  `cache_control` when the requesting model is high-res tier, text
  otherwise (tier detection by model id).
- Batch cold content until pages fill; never re-render (immutability).
- Optional: ColPali-style retrieval over pages if lexical search proves
  insufficient — GPU-preferred, separate opt-in.

### Phase 5 — End-to-end A/B in forge
- Same task suite (forge `mock-projects/`) run with memory backend off/on;
  compare `.forge/token-ledger.json` totals and task success rate.
- Ship behind config: `"optical_context": {"enabled": false, "tier": "auto"}`.

## Testing you can run today

```bash
cd experiments/optical-context
./run_e2e.sh                          # render→OCR→sweep→index→search, no API needed
ANTHROPIC_API_KEY=... ./run_e2e.sh    # + the real Claude round-trip (the gate)
python3 sweep.py corpus/code.js --kind code   # code-corpus economics
```

## Decision summary

- **Do now**: Phases 2–3. Deterministic, zero-risk, and they capture most
  of the practical savings (the research shows the index/hydration pattern,
  not pixels, is where agent-memory systems get their 80%+ reductions).
- **Do after measuring**: Phase 4, gated on the Phase-1 CER benchmark.
- **Don't do**: gzip-in-prompt, stopword stripping, images for code/ids,
  mutable image pages, optical pages for anything an agent will quote back.
