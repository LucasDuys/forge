#!/usr/bin/env python3
"""Split source text into sections, attach metadata, and map them to pages.

This builds the searchable "table of contents" layer: the full-fidelity
content lives in the rendered page images, while this small index (a few
hundred bytes per section) is what an agent actually keeps in context or
queries. Lookup returns which page(s) to hydrate.

Sectioning is deterministic: markdown headings first, falling back to blank-
line paragraph blocks merged up to --max-chars. Metadata per section:
title, char range, page numbers, top keywords (stopword-filtered term
frequency), and a first-sentence gist. No model, no embeddings — BM25 over
this index is the zero-dependency baseline; swap in embeddings later if
recall proves insufficient.

Usage:
  sectionize.py index corpus.txt pages/manifest.json -o index.json
  sectionize.py search index.json "token budget enforcement"
"""

import argparse
import json
import math
import re
from collections import Counter

STOPWORDS = set("""a an and are as at be by for from has have if in into is it
its of on or that the this to was were will with we you your not no can via
each which when what how all any been than then them they i""".split())

TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_\-]{1,}")


def terms(text):
    return [t.lower() for t in TOKEN_RE.findall(text) if t.lower() not in STOPWORDS]


def split_sections(text, max_chars=2000):
    """Yield (title, start, end) using markdown headings, else paragraphs."""
    heads = [(m.start(), m.group(2).strip())
             for m in re.finditer(r"^(#{1,6})\s+(.+)$", text, re.M)]
    if len(heads) >= 2:
        bounds = [h[0] for h in heads] + [len(text)]
        if heads[0][0] > 0:
            yield ("(preamble)", 0, heads[0][0])
        for i, (pos, title) in enumerate(heads):
            yield (title, pos, bounds[i + 1])
        return
    # fallback: paragraph blocks merged to max_chars
    pos, start, buf_title = 0, 0, None
    for para in re.split(r"\n\s*\n", text):
        if buf_title is None and para.strip():
            buf_title = para.strip().split("\n")[0][:60]
        end = pos + len(para)
        if end - start >= max_chars:
            yield (buf_title or "(section)", start, end)
            start, buf_title = end, None
        pos = end + 2
    if start < len(text):
        yield (buf_title or "(section)", start, len(text))


def build_index(text, manifest, max_chars=2000):
    pages = manifest["pages"]

    # When pages were rendered with --pack, each source newline became a
    # 4-char marker, so manifest offsets are shifted. Build a prefix count
    # of newlines to translate source offsets -> rendered offsets.
    if manifest.get("pack"):
        nl_prefix = [0]
        for ch in text:
            nl_prefix.append(nl_prefix[-1] + (1 if ch == "\n" else 0))
        to_rendered = lambda i: i + 3 * nl_prefix[min(i, len(text))]
    else:
        to_rendered = lambda i: i

    def pages_for(a, b):
        ra, rb = to_rendered(a), to_rendered(b)
        return [p["page"] for p in pages
                if p["char_start"] < rb and p["char_end"] > ra]

    sections = []
    for i, (title, a, b) in enumerate(split_sections(text, max_chars)):
        body = text[a:b]
        first = re.sub(r"\s+", " ", body.strip())[:160]
        top = [w for w, _ in Counter(terms(body)).most_common(8)]
        sections.append({
            "id": i, "title": title,
            "char_start": a, "char_end": b,
            "pages": pages_for(a, b),
            "keywords": top,
            "gist": first,
        })
    return {"page_dir_hint": manifest.get("page_w") and "see manifest.json",
            "n_sections": len(sections), "sections": sections}


def bm25_search(index, query, k=5, k1=1.5, b=0.75):
    docs = [(s, terms(s["title"] + " " + " ".join(s["keywords"]) + " " + s["gist"]))
            for s in index["sections"]]
    n = len(docs)
    avgdl = sum(len(d) for _, d in docs) / max(n, 1)
    df = Counter()
    for _, d in docs:
        df.update(set(d))
    scores = []
    for s, d in docs:
        tf = Counter(d)
        score = 0.0
        for q in terms(query):
            if q not in tf:
                continue
            idf = math.log(1 + (n - df[q] + 0.5) / (df[q] + 0.5))
            score += idf * tf[q] * (k1 + 1) / (tf[q] + k1 * (1 - b + b * len(d) / avgdl))
        if score > 0:
            scores.append((score, s))
    scores.sort(key=lambda x: -x[0])
    return scores[:k]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("index")
    p1.add_argument("source")
    p1.add_argument("manifest")
    p1.add_argument("-o", "--out", default="index.json")
    p1.add_argument("--max-chars", type=int, default=2000)
    p2 = sub.add_parser("search")
    p2.add_argument("index")
    p2.add_argument("query")
    p2.add_argument("-k", type=int, default=5)
    args = ap.parse_args()

    if args.cmd == "index":
        text = open(args.source).read()
        manifest = json.load(open(args.manifest))
        idx = build_index(text, manifest, args.max_chars)
        json.dump(idx, open(args.out, "w"), indent=2)
        size = len(json.dumps(idx))
        print(f"{idx['n_sections']} sections -> {args.out} "
              f"({size} bytes, ~{size // 4} tokens if kept in context)")
    else:
        idx = json.load(open(args.index))
        for score, s in bm25_search(idx, args.query, args.k):
            print(f"{score:6.2f}  [{s['id']:3d}] {s['title']}  -> pages {s['pages']}")
            print(f"        {s['gist'][:100]}")


if __name__ == "__main__":
    main()
