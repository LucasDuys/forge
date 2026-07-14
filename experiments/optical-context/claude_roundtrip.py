#!/usr/bin/env python3
"""The REAL end-to-end test: can Claude read a rendered page back at ~100%,
and what does it actually cost in tokens?

For each page: sends the PNG, asks for an exact transcription, then compares
against ground truth (char-level Levenshtein). Also calls the count_tokens
endpoint on the raw text so the token comparison is measured, not estimated.

Requires: ANTHROPIC_API_KEY env var. Uses plain HTTPS (urllib) — no SDK
dependency. Cost per run is small (one image + transcription per page), but
it does spend real tokens: transcription output tokens roughly equal the
text you rendered.

Usage:
  python3 claude_roundtrip.py pages/ corpus.txt [--model claude-haiku-4-5-20251001] [--pages 0,1]

Interpretation:
  accuracy >= 99.9%  -> this font size is safe for lossless recall
  usage.input_tokens for the image message vs count_tokens for raw text
                     -> the true compression ratio on Claude
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.request

from Levenshtein import ratio as lev_ratio

API = "https://api.anthropic.com/v1"
HEADERS = lambda key: {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}

PROMPT = ("Transcribe ALL text in this image exactly, character for character. "
          "Preserve line breaks. Output ONLY the transcription, no commentary.")


def post(key, path, body):
    req = urllib.request.Request(f"{API}/{path}", data=json.dumps(body).encode(),
                                 headers=HEADERS(key), method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pages_dir")
    ap.add_argument("source")
    ap.add_argument("--model", default="claude-haiku-4-5-20251001",
                    help="haiku is the cheap reader; also try sonnet")
    ap.add_argument("--pages", help="comma-separated page numbers (default: all)")
    args = ap.parse_args()

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("ANTHROPIC_API_KEY not set — skipping real-API round trip.")

    rendered = os.path.join(args.pages_dir, "rendered.txt")
    text = open(rendered).read() if os.path.exists(rendered) else open(args.source).read()
    manifest = json.load(open(os.path.join(args.pages_dir, "manifest.json")))
    wanted = ({int(x) for x in args.pages.split(",")} if args.pages
              else {p["page"] for p in manifest["pages"]})

    total_img_in, total_text_tokens, accs = 0, 0, []
    for p in manifest["pages"]:
        if p["page"] not in wanted:
            continue
        truth = text[p["char_start"]:p["char_end"]]
        img_b64 = base64.b64encode(
            open(os.path.join(args.pages_dir, p["file"]), "rb").read()).decode()

        resp = post(key, "messages", {
            "model": args.model, "max_tokens": 8000,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64",
                                             "media_type": "image/png", "data": img_b64}},
                {"type": "text", "text": PROMPT},
            ]}],
        })
        transcript = "".join(b.get("text", "") for b in resp["content"])
        acc = lev_ratio(norm(transcript), norm(truth))
        accs.append((acc, len(truth)))

        img_in = resp["usage"]["input_tokens"]
        cnt = post(key, "messages/count_tokens", {
            "model": args.model,
            "messages": [{"role": "user", "content": truth}],
        })
        text_tok = cnt["input_tokens"]
        total_img_in += img_in
        total_text_tokens += text_tok
        print(f"page {p['page']:3d}: accuracy {acc*100:6.2f}% | "
              f"image-msg input {img_in} tok vs raw text {text_tok} tok "
              f"({text_tok / max(img_in, 1):.2f}x)")

    if accs:
        overall = sum(a * n for a, n in accs) / sum(n for _, n in accs)
        print(f"\noverall accuracy {overall*100:.2f}% | "
              f"measured ratio {total_text_tokens / max(total_img_in, 1):.2f}x "
              f"({total_text_tokens} text tok vs {total_img_in} image-msg tok)")
        print("note: image-msg tokens include the ~30-token prompt; "
              "subtract it for the pure image cost.")


if __name__ == "__main__":
    main()
