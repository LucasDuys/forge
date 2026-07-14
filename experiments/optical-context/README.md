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

1. **Page cost is fixed**: a 1072×1072 page = `(w*h)/750` ≈ **1533 Claude
   image tokens**, full or empty. Anything above ~1.15 MP gets downscaled
   by the API before the model sees it, so bigger pages don't help.
2. **Break-even density**: a page must carry > ~6,100 chars of prose
   (1533 tokens × ~4 chars/token) to beat raw text. Packed 11px mono fits
   ~11,100 chars/page → **~1.8x compression ceiling** with this renderer.
3. **Fidelity is the gate**: tesseract reads packed prose at 12px at
   ~99.8%, but punctuation-dense technical text plateaus ~94%. The VLM
   round trip (`claude_roundtrip.py`) is the number that actually decides
   viability — run it before believing anything.

## Key findings so far (2026-07, this container)

- Naive markdown rendering LOSES (0.44–0.71x): short lines waste rows.
  `--pack` (reflow with reversible ` @@ ` newline markers) flips it to
  1.18–1.77x.
- Non-ASCII (box-drawing, arrows, smart quotes) tanks OCR; `--ascii`
  transliteration is deterministic and cheap.
- Partial pages always lose. Batch cold context until a page fills.
- The section index (`index.json`) is small (~350 bytes/section): keep it
  in context, hydrate pages on demand — that's the actual product shape.
