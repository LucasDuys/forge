"""opticalctx CLI — thin argparse wiring over the library modules.

Per CONTRACT.md §cli.py and the pipeline in ../SCALE.md §1: ingest splits
files into canonical sections (source of truth), flush lazily renders
unpaged sections into content-addressed PNG pages and OCR-certifies them,
and window assembles the densest plan that fits a token budget. All
printing lives here; library modules stay silent.
"""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from .constants import text_tokens_est
from .index import BM25Index
from .ocr import certify, update_manifest_cert
from .renderer import RenderConfig, render_batch
from .sectionizer import extract_meta, split
from .store import CanonicalStore
from .transforms import terse
from .window import build_window

DEFAULT_ROOT = ".opticalctx"
DEFAULT_GATE = 0.001
CODE_EXTS = {".py", ".js", ".cjs", ".go"}


# --------------------------------------------------------------- helpers

def _index_path(root: Path) -> Path:
    return root / "index.json"


def _load_config(root: Path) -> tuple[RenderConfig, float]:
    """RenderConfig + cert gate from root/config.json (defaults if absent)."""
    path = root / "config.json"
    if not path.exists():
        return RenderConfig(), DEFAULT_GATE
    data = json.loads(path.read_text(encoding="utf-8"))
    gate = data.pop("gate", DEFAULT_GATE)
    fields = set(RenderConfig.__dataclass_fields__)
    cfg = RenderConfig(**{k: v for k, v in data.items() if k in fields})
    return cfg, gate


def _save_config(root: Path, cfg: RenderConfig, gate: float) -> None:
    data = {**asdict(cfg), "gate": gate}
    (root / "config.json").write_text(json.dumps(data, indent=2),
                                      encoding="utf-8")


def _detect_kind(path: Path) -> str:
    """auto kind: .py/.js/.cjs/.go = code, .log or *-log = log, else prose."""
    if path.suffix in CODE_EXTS:
        return "code"
    if path.suffix == ".log" or path.stem.endswith("-log"):
        return "log"
    return "prose"


def _stats_dict(stats) -> dict:
    d = asdict(stats)
    d["effective_ratio"] = round(stats.effective_ratio, 3)
    return d


# -------------------------------------------------------------- commands

def cmd_init(args) -> int:
    root = Path(args.root)
    CanonicalStore(root)  # creates root/sections/pages dirs
    cfg = RenderConfig(font_px=args.font_px, page_w=args.page_w,
                       page_h=args.page_h)
    _save_config(root, cfg, args.gate)
    print(f"initialized {root} (font_px={cfg.font_px}, "
          f"page={cfg.page_w}x{cfg.page_h}, gate={args.gate})")
    return 0


def cmd_ingest(args) -> int:
    root = Path(args.root)
    store = CanonicalStore(root)
    index = BM25Index(_index_path(root))
    total = 0
    for raw in args.paths:
        path = Path(raw)
        if not path.is_file():
            print(f"skip (not a file): {path}", file=sys.stderr)
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        kind = args.kind if args.kind != "auto" else _detect_kind(path)
        if args.terse:
            text = terse(text)
        n = 0
        for title, section_text in split(text, kind):
            meta = extract_meta(title, section_text)
            sid = store.put(section_text, source=path.name, kind=kind,
                            title=title, keywords=meta["keywords"],
                            gist=meta["gist"])
            index.add(store.meta(sid))
            n += 1
        total += n
        print(f"{path}: {n} sections ({kind})")
    index.save()
    print(f"ingested {total} sections; index: {_index_path(root)}")
    return 0


def cmd_flush(args) -> int:
    root = Path(args.root)
    cfg, gate = _load_config(root)
    store = CanonicalStore(root)
    pages_dir = root / "pages"
    kinds = ([args.kind] if args.kind
             else sorted({m["kind"] for m in store.unpaged()}))
    n_pages = 0
    for kind in kinds:
        unpaged = store.unpaged(kind)
        if not unpaged:
            continue
        sections = [(m["id"], store.get(m["id"])) for m in unpaged]
        for page in render_batch(sections, pages_dir, cfg, kind=kind):
            secs = page.sections
            truth = (page.rendered_text[secs[0]["char_start"]:
                                        secs[-1]["char_end"]]
                     if secs else page.rendered_text)
            status = "uncertified"
            try:
                cert = certify(page.png_path, truth, gate)
                update_manifest_cert(page.manifest_path, cert, gate)
                status = (f"cer={cert.best_cer:.4f} "
                          f"{'PASS' if cert.passed else 'FAIL'}")
            except RuntimeError as exc:
                print(f"warning: page {page.page_id}: {exc}",
                      file=sys.stderr)
            store.mark_paged([s["id"] for s in secs], page.page_id)
            n_pages += 1
            print(f"page {page.page_id} [{kind}] chars={page.chars} "
                  f"img_tokens={page.image_tokens} {status}")
    print(f"flushed {n_pages} pages")
    return 0


def cmd_search(args) -> int:
    root = Path(args.root)
    index = BM25Index(_index_path(root))
    results = index.search(args.query, k=args.k)
    if not results:
        print("no results")
        return 0
    for score, rec in results:
        print(f"{score:7.3f}  {rec.get('id')}  [{rec.get('kind')}] "
              f"{rec.get('title')}  ({rec.get('source')})")
    return 0


def cmd_get(args) -> int:
    root = Path(args.root)
    store = CanonicalStore(root)
    try:
        text = store.get(args.section_id)
    except KeyError:
        print(f"unknown section: {args.section_id}", file=sys.stderr)
        return 1
    store.touch(args.section_id)
    print(text, end="" if text.endswith("\n") else "\n")
    return 0


def cmd_window(args) -> int:
    root = Path(args.root)
    store = CanonicalStore(root)
    index = BM25Index(_index_path(root))
    plan = build_window(store, index, token_budget=args.budget,
                        model=args.model, query=args.query,
                        pages_dir=root / "pages")
    if args.json:
        payload = {
            "blocks": [{"type": b.type, "content": b.content,
                        "tokens": b.tokens} for b in plan.blocks],
            "stats": _stats_dict(plan.stats),
        }
        print(json.dumps(payload, indent=2))
        return 0
    for i, block in enumerate(plan.blocks):
        if block.type == "page_image":
            preview = block.content  # png path
        else:
            preview = " ".join(block.content.split())[:70]
        print(f"[{i:3d}] {block.type:<10} {block.tokens:>6} tok  {preview}")
    s = plan.stats
    print(f"-- model={s.model} real={s.real_tokens} "
          f"text_equiv={s.text_equiv_tokens} ratio={s.effective_ratio:.2f}x")
    print(f"-- chars={s.chars_carried} pages={s.n_pages} "
          f"text_sections={s.n_text_sections}")
    print(f"-- first_turn=${s.first_turn_usd:.4f} "
          f"cached_turn=${s.cached_turn_usd:.4f}")
    return 0


def cmd_stats(args) -> int:
    root = Path(args.root)
    store = CanonicalStore(root)
    metas = store.all_meta()
    pages_dir = root / "pages"
    manifests = []
    for path in sorted(pages_dir.glob("*.json")) if pages_dir.is_dir() else []:
        try:
            manifests.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    certified = sum(1 for m in manifests
                    if (m.get("cert") or {}).get("passed"))
    cert_pct = 100.0 * certified / len(manifests) if manifests else 0.0
    index_bytes = (_index_path(root).stat().st_size
                   if _index_path(root).exists() else 0)
    ledger = {}
    if store.ledger_path.exists():
        ledger = json.loads(store.ledger_path.read_text(encoding="utf-8"))
    disk = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    text_tokens = sum(text_tokens_est(m["chars"], m.get("kind", "prose"))
                      for m in metas)
    image_tok = sum(m.get("image_tokens", 0) for m in manifests)
    print(f"sections:      {len(metas)}")
    print(f"pages:         {len(manifests)} ({certified} certified, "
          f"{cert_pct:.0f}%)")
    print(f"index size:    {index_bytes} bytes")
    print(f"ledger:        {len(ledger)} entries, "
          f"{sum(ledger.values())} touches")
    print(f"disk:          {disk} bytes")
    print(f"token totals:  text~{text_tokens} image={image_tok}")
    return 0


# ------------------------------------------------------------------ main

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opticalctx",
        description="Optical context backend: canonical text sections "
                    "rendered as dense, OCR-certified page images.")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_root(p):
        p.add_argument("--root", default=DEFAULT_ROOT,
                       help=f"store root (default {DEFAULT_ROOT})")

    p = sub.add_parser("init", help="create store root + config.json")
    add_root(p)
    p.add_argument("--font-px", type=int, default=RenderConfig.font_px)
    p.add_argument("--page-w", type=int, default=RenderConfig.page_w)
    p.add_argument("--page-h", type=int, default=RenderConfig.page_h)
    p.add_argument("--gate", type=float, default=DEFAULT_GATE)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("ingest", help="split files into canonical sections")
    add_root(p)
    p.add_argument("paths", nargs="+", metavar="PATH")
    p.add_argument("--kind", default="auto",
                   choices=["auto", "prose", "code", "log", "docs"])
    p.add_argument("--terse", action="store_true",
                   help="apply the terse substitution table before splitting")
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("flush",
                       help="render unpaged sections to pages + certify")
    add_root(p)
    p.add_argument("--kind", default=None)
    p.set_defaults(func=cmd_flush)

    p = sub.add_parser("search", help="BM25 search over the section index")
    add_root(p)
    p.add_argument("query")
    p.add_argument("-k", type=int, default=5)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("get", help="print a section's canonical text")
    add_root(p)
    p.add_argument("section_id")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("window", help="assemble a window plan for a budget")
    add_root(p)
    p.add_argument("--budget", type=int, required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--query", default=None)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_window)

    p = sub.add_parser("stats", help="store/index/pages statistics")
    add_root(p)
    p.set_defaults(func=cmd_stats)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
