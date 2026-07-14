#!/usr/bin/env python3
"""Fidelity benchmark: local CER grid over content kind x font size x engine.

For each corpus kind and font size, renders one full page from the corpus
and measures character error rate with every available local OCR engine.
This is the local-only proxy for the Claude round-trip (tesseract is a
weak reader, rapidocr a stronger one; a frontier VLM is generally better
than both, so treat these as an upper bound on CER / lower bound on
viability — see REPORT.md §2).

Usage: python3 -m opticalctx.bench.bench_fidelity [--corpus DIR] [--out DIR]
"""

import argparse
import json
import os
import tempfile
import time

from ..ocr import certify, wrap_truth
from ..renderer import RenderConfig, page_geometry, render_batch

KIND_FILES = {
    "prose": "war-and-peace.txt",
    "code": "python-stdlib.py",
    "log": "agent-log.txt",
    "docs": "git-docs.adoc",
}
FONT_SIZES = [9, 10, 11, 12, 14]
SAMPLE_CHARS = 60_000   # enough to fill >1 page at every size


def run(corpus_dir: str, out_dir: str) -> list[dict]:
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for kind, fname in KIND_FILES.items():
        path = os.path.join(corpus_dir, fname)
        if not os.path.exists(path):
            continue
        # skip prefaces/headers: sample from 10% into the file
        full = open(path, encoding="utf-8", errors="ignore").read()
        text = full[len(full) // 10:len(full) // 10 + SAMPLE_CHARS]
        for px in FONT_SIZES:
            with tempfile.TemporaryDirectory() as td:
                cfg = RenderConfig(font_px=px)
                t0 = time.monotonic()
                pages = render_batch([(f"bench-{kind}", text)], td, cfg, kind=kind)
                render_s = time.monotonic() - t0
                p = pages[0]   # first (full) page only
                cols, _rows = page_geometry(cfg)
                truth = wrap_truth(p.rendered_text, cols)
                t0 = time.monotonic()
                cert = certify(p.png_path, truth, gate=0.001)
                ocr_s = time.monotonic() - t0
                rows.append({
                    "kind": kind, "font_px": px,
                    "chars_on_page": p.chars,
                    "image_tokens": p.image_tokens,
                    "tesseract_cer": cert.tesseract_cer,
                    "rapidocr_cer": cert.rapidocr_cer,
                    "best_cer": cert.best_cer,
                    "passed_0.1pct": cert.passed,
                    "render_s": round(render_s, 2), "ocr_s": round(ocr_s, 2),
                })
                print(f"{kind:5s} {px:2d}px: {p.chars:6d} chars, "
                      f"tess CER {fmt(cert.tesseract_cer)}, "
                      f"rapid CER {fmt(cert.rapidocr_cer)}")
    with open(os.path.join(out_dir, "fidelity.json"), "w") as f:
        json.dump(rows, f, indent=2)
    return rows


def fmt(v):
    return f"{v*100:.2f}%" if v is not None else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="bench-corpus")
    ap.add_argument("--out", default="bench-results")
    a = ap.parse_args()
    run(a.corpus, a.out)


if __name__ == "__main__":
    main()
