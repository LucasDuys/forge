# opticalctx — optical context backend (library + CLI)

Store agent context as canonical text sections with a searchable BM25
index, render cold content into token-dense PNG pages for Claude's vision
input, certify pages with local OCR, and assemble budget-bounded context
windows with measured token/cost economics. Local-only: no network, no
API calls. Design rationale: `../PLAN.md`, `../SCALE.md`; measured
results: `../bench-results/BENCHMARKS.md`.

## Install

```bash
pip install pillow pytesseract python-Levenshtein rapidocr-onnxruntime
apt-get install tesseract-ocr   # or brew install tesseract
```

## CLI quickstart

```bash
cd experiments/optical-context

python3 -m opticalctx.cli init --root .octx --font-px 11 --gate 0.005
python3 -m opticalctx.cli ingest --root .octx notes/*.md src/*.py --kind auto
python3 -m opticalctx.cli flush --root .octx          # render + certify pages
python3 -m opticalctx.cli search --root .octx "token budget" -k 5
python3 -m opticalctx.cli get --root .octx <section_id>   # canonical text (bumps heat)
python3 -m opticalctx.cli window --root .octx --budget 180000 --model sonnet-5 --json
python3 -m opticalctx.cli stats --root .octx
```

`window --json` emits the assembled plan: `toc` / `text` / `page_label` /
`page_image` blocks in order, plus stats (real tokens, text-equivalent
tokens, effective ratio, first-turn and cached-turn USD). Feed the blocks
to the Messages API in order — labels before images, `cache_control` on
the last stable block; page_image blocks reference PNG paths to upload
once via the Files API and reuse by `file_id`.

## Library

```python
from opticalctx.store import CanonicalStore
from opticalctx.index import BM25Index
from opticalctx.sectionizer import split, extract_meta
from opticalctx.renderer import RenderConfig, render_batch
from opticalctx.ocr import certify, wrap_truth
from opticalctx.window import build_window

store = CanonicalStore(".octx")
index = BM25Index(".octx/index.json")
for title, body in split(open("doc.md").read(), kind="prose"):
    meta = extract_meta(title, body)
    sid = store.put(body, source="doc.md", kind="prose", title=title,
                    keywords=meta["keywords"], gist=meta["gist"])
    index.add(store.meta(sid))
index.save()
plan = build_window(store, index, token_budget=180_000,
                    model="sonnet-5", pages_dir=".octx/pages")
print(plan.stats.effective_ratio, plan.stats.cached_turn_usd)
```

## Guarantees and honest limits

- **Canonical text is the source of truth.** Pages are derived,
  content-addressed (`sha256(renderer_version|cfg|stream)`), immutable.
  Quote-backs must use `get`, never an image transcription.
- **Only certified pages enter windows.** A page ships as an image only
  if local OCR CER clears the gate; everything else rides as text. Local
  OCR is a *conservative floor* — a frontier VLM reads better, so gated
  pages are safe but some FAIL pages would actually be readable.
- **Standard-tier models** (haiku-4.5) get downscale-aware token counts;
  1092x1092 pages survive all tiers undistorted.
- **Windows never exceed their token budget** and blocks are ordered
  TOC -> hot text -> labeled pages -> overflow text.

## Benchmarks

```bash
./run_bench.sh    # from experiments/optical-context; ~1h CPU, no API key
```

Three stages: fidelity grid (CER by content kind x font size x engine),
scale (full 7MB corpus -> sections -> pages -> sampled certification ->
search latency -> window simulation), economics (session cost curves from
verified pricing). Results: `bench-results/BENCHMARKS.md` + JSON.
