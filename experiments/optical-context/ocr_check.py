#!/usr/bin/env python3
"""OCR every rendered page back to text and score fidelity vs the ground truth.

Uses tesseract as a conservative local proxy for "can a machine read this".
A VLM (Claude) is generally a stronger reader than tesseract, so tesseract
accuracy is a lower bound; the real end-to-end number comes from
claude_roundtrip.py.

Scores char-level similarity (Levenshtein ratio) after whitespace
normalization, because line-wrapping legitimately changes whitespace.
"""

import argparse
import json
import os
import re
import sys

import pytesseract
from Levenshtein import ratio as lev_ratio
from PIL import Image


def normalize(s):
    return re.sub(r"\s+", " ", s).strip()


def check_pages(pages_dir, source_text=None, psm=6):
    manifest = json.load(open(os.path.join(pages_dir, "manifest.json")))
    rendered = os.path.join(pages_dir, "rendered.txt")
    if os.path.exists(rendered):
        source_text = open(rendered).read()
    if source_text is None:
        raise SystemExit("no rendered.txt in pages dir and no source given")
    results = []
    for p in manifest["pages"]:
        img = Image.open(os.path.join(pages_dir, p["file"]))
        ocr = pytesseract.image_to_string(img, config=f"--psm {psm}")
        truth = source_text[p["char_start"]:p["char_end"]]
        acc = lev_ratio(normalize(ocr), normalize(truth))
        results.append({"page": p["page"], "chars": len(truth), "char_accuracy": round(acc, 5)})
    overall = (sum(r["char_accuracy"] * r["chars"] for r in results)
               / max(sum(r["chars"] for r in results), 1))
    return {"font_px": manifest["font_px"], "pages": results,
            "overall_char_accuracy": round(overall, 5)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pages_dir")
    ap.add_argument("source", nargs="?",
                    help="original text file (default: pages_dir/rendered.txt)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    text = open(args.source).read() if args.source else None
    res = check_pages(args.pages_dir, text)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        for r in res["pages"]:
            print(f"page {r['page']:3d}: {r['char_accuracy']*100:6.2f}% ({r['chars']} chars)")
        print(f"overall: {res['overall_char_accuracy']*100:.2f}%")


if __name__ == "__main__":
    main()
