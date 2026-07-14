# Optical Context — text-as-image context compression experiment

Research prototype testing whether agent context can be stored as rendered
page images and read back by a VLM for fewer tokens than raw text, with a
cheap searchable section index deciding which page to hydrate.

**Status: experiment.** Not wired into the forge plugin. See
`REPORT.md` for measured results and `PLAN.md` for the project plan.

## Pipeline

```
corpus.txt
  └─ translate.py   deterministic terse transform (optional, ~16% chars saved)
  └─ render.py      text -> 1072x1072 PNG pages (packed, supersampled, mono font)
       ├─ ocr_check.py        tesseract read-back accuracy (local lower bound)
       ├─ sweep.py            font-size sweep: density vs accuracy vs token ratio
       ├─ sectionize.py       section index w/ metadata + BM25 search -> page ids
       └─ claude_roundtrip.py REAL test: Claude transcribes page, measures true
                              token costs via count_tokens (needs ANTHROPIC_API_KEY)
```

## Run it

```bash
pip install pillow pytesseract python-Levenshtein
apt-get install tesseract-ocr        # or brew install tesseract

./run_e2e.sh                         # full pipeline on corpus/sample.md
./run_e2e.sh path/to/your.txt        # your own corpus
FONT_PX=10 QUERY="worktree" ./run_e2e.sh
ANTHROPIC_API_KEY=... ./run_e2e.sh   # adds the real Claude round trip
```

## The three numbers that matter

1. **Page cost is fixed**: Claude charges `ceil(w/28) × ceil(h/28)` tokens
   per image (one per 28×28px patch), full or empty. Default 1092×1092
   page = **1,521 tokens** — the largest square that survives every model
   tier. Standard-tier models (Haiku) silently downscale anything bigger;
   high-res-tier models (Fable/Mythos 5, Opus 4.7/4.8, Sonnet 5) accept
   1568×1568 = 3,136 tokens if you can guarantee the tier.
2. **Break-even density**: a page must carry > ~6,100 chars of prose
   (1521 tokens × ~4 chars/token) to beat raw text. Packed 11px mono fits
   ~11,600 chars/page → **~1.9x compression ceiling** here, ~2.4–3.0x on
   high-res-tier pages.
3. **Fidelity is the gate**: tesseract reads packed prose at 12px at
   ~99.8%, but punctuation-dense technical text plateaus ~94%. The VLM
   round trip (`claude_roundtrip.py`) is the number that actually decides
   viability — run it before believing anything. Research warning: VLM
   reading collapses when line pitch gets tight, and there is no published
   accuracy floor for Claude on dense rendered text.

Full research brief with sources: `RESEARCH.md`. Project plan: `PLAN.md`.

## Key findings so far (2026-07, this container)

- Naive markdown rendering LOSES (0.44–0.71x): short lines waste rows.
  `--pack` (reflow with reversible ` @@ ` newline markers) flips it to
  1.18–1.77x.
- Non-ASCII (box-drawing, arrows, smart quotes) tanks OCR; `--ascii`
  transliteration is deterministic and cheap.
- Partial pages always lose. Batch cold context until a page fills.
- The section index (`index.json`) is small (~350 bytes/section): keep it
  in context, hydrate pages on demand — that's the actual product shape.
