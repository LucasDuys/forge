# opticalctx — module contract (v1)

Python 3.11 library + CLI implementing the optical context backend designed
in `../PLAN.md` and `../SCALE.md`. Local-only: no network, no API calls.
Allowed deps: stdlib, PIL (Pillow), pytesseract, Levenshtein,
rapidocr_onnxruntime. Everything else stdlib.

Architecture rule #1: **pages are a view, not a store.** Canonical text is
the source of truth; PNG pages are derived, content-addressed, immutable.

## Storage layout (root dir, default `.opticalctx/`)

```
root/
  config.json            # RenderConfig + gate settings as JSON
  sections/{id}.txt      # canonical section text; id = sha256(text)[:16]
  sections.jsonl         # one JSON record per section, append-only
  pages/{page_id}.png    # rendered page image
  pages/{page_id}.json   # page manifest (see below)
  index.json             # BM25 index persistence
  ledger.json            # {section_id: access_count}
```

Section record (sections.jsonl):
```json
{"id": "a3f2...", "source": "moby-dick.txt", "kind": "prose",
 "title": "...", "keywords": ["..."], "gist": "...", "chars": 1234,
 "created": "<caller-supplied iso ts or ''>", "page_id": null_or_str}
```

Page manifest (pages/{page_id}.json):
```json
{"page_id": "...", "renderer_version": "r1", "font_px": 11,
 "page_w": 1092, "page_h": 1092, "kind": "prose",
 "sections": [{"id": "...", "char_start": 0, "char_end": 999}],
 "chars": 10432, "image_tokens": 1521,
 "cert": {"tesseract_cer": 0.021, "rapidocr_cer": 0.004,
          "best_cer": 0.004, "passed": false, "gate": 0.001},
 "line_crc32": [3735928559, ...]}
```
`char_start/char_end` index into the page's rendered stream (the packed
concatenation), NOT into section text.

## constants.py  (PROVIDED — do not modify, import from it)
Pricing/tier tables, `image_tokens(w,h)`, `downscaled_dims(w,h,tier)`,
`text_tokens_est(chars, kind)`, `RENDERER_VERSION`, `CHARS_PER_TOKEN`.

## budget.py  (PROVIDED — do not modify, import from it)
`page_cost_usd`, `tokens_for_model`, `WindowStats`, `session_cost`.

## store.py
```python
class CanonicalStore:
    def __init__(self, root: str | Path): ...      # creates dirs
    def put(self, text: str, *, source: str, kind: str,
            title: str, keywords: list[str], gist: str) -> str:
        """Write section text + jsonl record. Content-addressed:
        sha256(text.encode())[:16] hex. Idempotent: re-putting identical
        text returns the same id without duplicating the jsonl record."""
    def get(self, section_id: str) -> str:          # raises KeyError
    def meta(self, section_id: str) -> dict:        # raises KeyError
    def all_meta(self) -> list[dict]:               # jsonl order, deduped
    def unpaged(self, kind: str | None = None) -> list[dict]
    def mark_paged(self, section_ids: list[str], page_id: str) -> None
        # rewrites sections.jsonl records' page_id (compact rewrite is ok)
    def touch(self, section_id: str) -> None        # ledger increment
    def heat(self, section_id: str) -> int          # ledger count, 0 default
```

## sectionizer.py
```python
def split(text: str, kind: str = "prose", max_chars: int = 4000) -> list[tuple[str, str]]:
    """Deterministic. Returns [(title, section_text)]. Strategy:
    markdown headings if >=2 present; for kind='code', split on top-level
    def/class boundaries; else blank-line paragraph blocks merged up to
    max_chars. Every char of input lands in exactly one section."""
def extract_meta(title: str, text: str) -> dict:
    """{'keywords': [<=8 stopword-filtered TF terms], 'gist': first 160
    chars whitespace-normalized}"""
```

## transforms.py  (port from ../translate.py + ../render.py)
```python
def normalize(text: str) -> str
def terse(text: str) -> str          # deterministic substitution table
def asciify(text: str) -> str        # ASCII_MAP transliteration + errors='replace'
def pack(text: str) -> str           # newline -> ' @@ ' (NL_MARK)
def unpack(text: str) -> str
NL_MARK = " @@ "
```

## renderer.py  (port/extend ../render.py)
```python
@dataclass
class RenderConfig:
    font_path: str = DEJAVU_MONO; font_px: int = 11
    page_w: int = 1092; page_h: int = 1092
    margin: int = 12; line_spacing: int = 2; supersample: int = 4

@dataclass
class PageResult:
    page_id: str; png_path: str; manifest_path: str
    sections: list[dict]   # {"id","char_start","char_end"} in stream coords
    chars: int; image_tokens: int; rendered_text: str

def render_batch(sections: list[tuple[str, str]], out_dir: str | Path,
                 cfg: RenderConfig, kind: str = "prose") -> list[PageResult]:
    """sections = [(section_id, canonical_text)]. Pipeline per section:
    asciify -> pack; join into one stream with separator
    f' @[{section_id}]@ ' before each section's content. Fill pages
    greedily to capacity (full rows). page_id =
    sha256(f'{RENDERER_VERSION}|{cfg.font_px}|{cfg.page_w}x{cfg.page_h}|'
           + stream_slice)[:16].
    Writes PNG + manifest JSON (cert null until certify runs; line_crc32 =
    crc32 of each rendered text line). Deterministic: same input+cfg =>
    byte-identical PNG, same page_id. A section may span pages; its
    char_start/char_end are stream offsets per page it appears on."""
```

## ocr.py
```python
@dataclass
class CertResult:
    tesseract_cer: float | None; rapidocr_cer: float | None
    best_cer: float; passed: bool
def cer(ocr_text: str, truth: str) -> float
    """1 - Levenshtein.ratio on whitespace-normalized strings."""
def certify(png_path: str, truth_text: str, gate: float = 0.001,
            engines: tuple = ("tesseract", "rapidocr")) -> CertResult
    """Runs each available engine; missing engine -> None; best_cer =
    min of available; passed = best_cer <= gate. Never raises on a
    missing engine; raises if none available."""
def update_manifest_cert(manifest_path: str, cert: CertResult, gate: float) -> None
```

## index.py
```python
class BM25Index:
    def __init__(self, path: str | Path): ...       # loads if exists
    def add(self, record: dict) -> None             # section record
    def search(self, query: str, k: int = 5) -> list[tuple[float, dict]]
    def save(self) -> None
    def toc(self, max_entries: int = 100) -> list[dict]
        """Two-level: group sections by source; return per-source
        {'source', 'kind', 'n_sections', 'top_keywords'(<=6), 'section_ids'}
        sorted by n_sections desc, truncated to max_entries."""
```
BM25 over title+keywords+gist terms, k1=1.5 b=0.75, same tokenizer as
../sectionize.py (STOPWORDS + [a-zA-Z_][a-zA-Z0-9_\-]+ lowered).

## window.py
```python
@dataclass
class WindowBlock:
    type: str            # 'text' | 'page_label' | 'page_image' | 'toc'
    content: str         # text, label line, or page png path
    tokens: int
@dataclass
class WindowPlan:
    blocks: list[WindowBlock]; stats: "WindowStats"
def build_window(store, index, *, token_budget: int, model: str,
                 query: str | None = None, hot_text_budget: int = 8000,
                 pages_dir: str | Path) -> WindowPlan:
    """Assemble: (1) TOC block from index.toc(); (2) hot text sections —
    highest store.heat() first (ties: jsonl order), canonical text until
    hot_text_budget tokens; (3) certified pages (manifest cert.passed)
    for remaining budget, each preceded by a page_label block
    'Image {n}: page {page_id} — sections: {titles}'; (4) uncertified/
    unpaged sections as plain text until budget exhausted. Never exceed
    token_budget. Downscale-aware: pages count tokens via
    tokens_for_model(model, w, h). stats = budget.WindowStats over the
    result (see budget.py)."""
```

## cli.py
argparse, prog `opticalctx`, subcommands:
```
init  --root  [--font-px --page-w --page-h --gate]
ingest --root PATH... [--kind auto|prose|code|log|docs] [--terse]
        # auto: .py/.js/.cjs/.go=code, .log/-log=log, else prose
flush --root [--kind K]     # render unpaged sections -> pages + certify
search --root QUERY [-k]
get --root SECTION_ID
window --root --budget N --model M [--query Q] [--json]
stats --root                # sections, pages, certified %, index size,
                            # ledger, disk bytes, token totals
```
Each command prints human-readable output; `--json` where noted.

## Facade (api.py) — integrator writes this; do not implement.

## tests/  (one file per module you implement)
stdlib unittest, temp dirs, no network. Renderer tests may skip OCR
engines if unavailable but must test determinism (same input -> same
page_id) and packing (page fill > 80% capacity for a long prose input).

## Style
- Python 3.11, stdlib type hints, no external deps beyond the allowed list.
- No prints from library code (CLI prints; library returns values).
- Every module: short docstring citing the relevant section of
  ../RESEARCH.md, ../SCALE.md or ../REPORT.md for its design choices.
```
