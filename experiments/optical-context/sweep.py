#!/usr/bin/env python3
"""Parameter sweep: find the densest rendering that still OCRs at ~100%.

For each font size, renders the corpus, OCRs it back, and reports:
  - chars per page and pages needed
  - estimated text tokens (chars/4 for prose, chars/3.5 for code)
  - Claude image tokens per page (patch formula ceil(w/28)*ceil(h/28);
    default 1092x1092 page = 1521 tokens, safe on every model tier)
  - compression ratio (text tokens / image tokens)
  - tesseract char accuracy

The sweet spot is the smallest font size whose accuracy stays above the
--min-accuracy bar. Emits a markdown table and a results.json.
"""

import argparse
import json
import os
import shutil

from ocr_check import check_pages
from render import render_pages


def sweep(text, work_dir, sizes, page_w=1092, page_h=1092, kind="prose",
          pack=True, ascii_safe=True):
    chars_per_token = 3.5 if kind == "code" else 4.0
    rows = []
    for px in sizes:
        out = os.path.join(work_dir, f"px{px}")
        shutil.rmtree(out, ignore_errors=True)
        m = render_pages(text, out, font_px=px, page_w=page_w, page_h=page_h,
                         pack=pack, ascii_safe=ascii_safe)
        acc = check_pages(out)["overall_char_accuracy"]
        n_pages = len(m["pages"])
        img_tokens = m["claude_image_tokens_per_page"] * n_pages
        text_tokens = round(len(text) / chars_per_token)
        rows.append({
            "font_px": px,
            "pages": n_pages,
            "chars_per_page": m["chars_capacity_per_page"],
            "est_text_tokens": text_tokens,
            "image_tokens": img_tokens,
            "ratio": round(text_tokens / img_tokens, 2),
            "tesseract_accuracy": acc,
        })
    return rows


def to_markdown(rows, min_accuracy):
    md = ["| font px | pages | chars/page | text tok | image tok | ratio | tesseract acc |",
          "|--------:|------:|-----------:|---------:|----------:|------:|--------------:|"]
    for r in rows:
        flag = "" if r["tesseract_accuracy"] >= min_accuracy else " ⚠"
        md.append(f"| {r['font_px']} | {r['pages']} | {r['chars_per_page']} "
                  f"| {r['est_text_tokens']} | {r['image_tokens']} "
                  f"| {r['ratio']}x | {r['tesseract_accuracy']*100:.2f}%{flag} |")
    return "\n".join(md)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("input", help="corpus text file")
    ap.add_argument("-o", "--out", default="sweep-out")
    ap.add_argument("--sizes", default="8,9,10,11,12,14")
    ap.add_argument("--kind", choices=["prose", "code"], default="prose")
    ap.add_argument("--min-accuracy", type=float, default=0.995)
    ap.add_argument("--no-pack", action="store_true",
                    help="disable row-filling reflow (see how much it matters)")
    args = ap.parse_args()

    text = open(args.input).read()
    sizes = [int(s) for s in args.sizes.split(",")]
    rows = sweep(text, args.out, sizes, kind=args.kind, pack=not args.no_pack)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(rows, f, indent=2)
    print(to_markdown(rows, args.min_accuracy))

    ok = [r for r in rows if r["tesseract_accuracy"] >= args.min_accuracy]
    if ok:
        best = min(ok, key=lambda r: r["font_px"])
        print(f"\nbest: {best['font_px']}px -> {best['ratio']}x token ratio at "
              f"{best['tesseract_accuracy']*100:.2f}% tesseract accuracy")
    else:
        print(f"\nno size met the {args.min_accuracy*100:.1f}% accuracy bar")


if __name__ == "__main__":
    main()
