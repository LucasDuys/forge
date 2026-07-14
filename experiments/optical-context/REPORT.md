# Optical Context — measured results (2026-07-14, Linux container)

All numbers produced by this harness (`./run_e2e.sh`), tesseract 5.3.4,
DejaVu Sans Mono, pages 1072×1072 px (largest square page the Claude API
accepts without downscaling; ≈1533 image tokens each), 4x supersampled
Lanczos rendering.

## 1. The economics only work if you pack

Corpus: forge CLAUDE.md + state-machine.md (21.7k chars of markdown).

| rendering | ratio (text tok / image tok) |
|---|---|
| naive (line-per-row) @ 10px | **0.59x — loses** |
| naive @ 14px | 0.44x — loses badly |
| packed reflow @ 10px | **1.77x — wins** |
| packed @ 12px | 1.18x |

Markdown's short lines waste ~70% of every row. `--pack` reflows the text
into a full-width stream with reversible ` @@ ` newline markers and flips
the result. Partial pages always lose (a 1KB file on one page = 0.17x), so
cold context must be batched until pages fill.

## 2. Fidelity by content type (tesseract lower bound)

| corpus | 10px | 11px | 12px | 14px |
|---|---|---|---|---|
| plain prose (LICENSE) | 99.02% | 99.47% | **99.78%** | — |
| technical markdown (packed+ascii) | 91.08% | 92.42% | 93.97% | 93.70% |
| JavaScript code | 95.13% | 95.84% | 96.82% | 97.60% |

- Prose is nearly there at 12px; symbol-dense text plateaus well below the
  99.5% bar **for tesseract**. Errors concentrate in backticks, braces,
  pipes, and underscores.
- Non-ASCII glyphs (box-drawing, arrows, smart quotes) are OCR poison;
  the deterministic `--ascii` transliteration is mandatory.
- Tesseract is a floor, not the verdict. Modern VLMs read dense rendered
  text far better; `claude_roundtrip.py` measures the real number and the
  real token costs via the count_tokens endpoint. **Run it with an API key
  before drawing conclusions** — it is the actual go/no-go gate.

## 3. Compression ceiling with this renderer

Packed 11px mono: 161 cols × 69 rows = 11,109 chars/page.

- Prose (~4 chars/token): 11,109/4 ≈ 2,777 text tokens vs 1,533 image
  tokens → **1.81x**
- Code (~3.5 chars/token): ≈ 3,174 vs 1,533 → **2.07x**
- 10px (12,876 chars/page) pushes prose to 2.1x if fidelity holds.

Adding the terse transform (`translate.py --mode terse`, 16.4% chars saved
on forge docs, deterministic) stacks multiplicatively: ~1.8x × 1.16 ≈ 2.1x
effective for prose-like internal state.

## 4. Section index

36 sections from the 21.7k-char corpus → 12.8 KB index (~3.2k tokens if
held in context; ~350 bytes/section). BM25 over title+keywords+gist
correctly resolves e.g. "token budget" → the Token Budgets section and its
page number. Retrieval is sub-millisecond at this scale; the design scales
to ~100k sections before needing SQLite FTS5 or embeddings.

## 5. Honest bottom line so far

- Ceiling is **~1.8–2.1x**, not the 10x headlines from DeepSeek-OCR — those
  numbers come from custom vision encoders producing far fewer vision
  tokens per pixel than commercial APIs charge.
- The win only materializes if (a) pages are packed full, (b) the VLM
  round-trip accuracy is ≥99.9% at the chosen density, and (c) the content
  is cold (read rarely) — every hydration of a page costs its 1,533 tokens
  again, and re-reading the same content twice erases the saving vs a
  cached text prompt.
- The section-index + lazy-hydration layer is valuable *independently* of
  whether images or text sit underneath — it's the part that actually cuts
  agent token burn.
