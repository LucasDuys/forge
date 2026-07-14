#!/usr/bin/env python3
"""Economics benchmark: turn measured density + CER into cost curves.

Consumes bench-results/scale.json + fidelity.json and produces
BENCHMARKS.md: effective-context table, per-session cost comparison
(text vs optical, cache on/off, per model), and the fidelity gate verdict.
Pure arithmetic over verified constants — no API calls (budget.py).

Usage: python3 -m opticalctx.bench.bench_economics [--out DIR]
"""

import argparse
import json
import os

from ..budget import SessionProfile, session_cost
from ..constants import MODELS


def table(rows, headers):
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x) for x in r) + " |")
    return "\n".join(out)


def run(out_dir):
    scale = json.load(open(os.path.join(out_dir, "scale.json")))
    fidelity = json.load(open(os.path.join(out_dir, "fidelity.json")))

    md = ["# opticalctx — measured benchmarks (local-only)\n",
          "Local proxies only: OCR CER is tesseract/rapidocr (a frontier "
          "VLM generally reads better); token costs are computed from the "
          "verified patch formula and public pricing, not API calls.\n"]

    # scale summary
    ing, ren = scale["ingest"], scale["render"]
    md.append("## Scale\n")
    md.append(f"- corpus: **{ing['chars']:,} chars** -> {ing['sections']:,} "
              f"sections in {ing['seconds']}s ({ing['chars_per_s']:,} chars/s)")
    md.append(f"- index: {ing['index_bytes']:,} bytes on disk")
    md.append(f"- pages: **{ren['pages']}** rendered in {ren['seconds']}s "
              f"({ren['pages_per_s']}/s), avg {ren['chars_per_page_avg']:,} "
              f"chars/page")
    md.append(f"- search: p50 {scale['search']['p50_ms']}ms / "
              f"p95 {scale['search']['p95_ms']}ms")
    md.append(f"- store size on disk: {scale['disk_bytes']:,} bytes\n")

    # fidelity grid
    md.append("## Fidelity (CER by kind x font size; gate 0.1%)\n")
    rows = [(f["kind"], f["font_px"], f"{f['chars_on_page']:,}",
             _fmt(f["tesseract_cer"]), _fmt(f["rapidocr_cer"]),
             "PASS" if f["passed_0.1pct"] else "fail")
            for f in fidelity]
    md.append(table(rows, ["kind", "px", "chars/page", "tesseract CER",
                           "rapidocr CER", "gate"]))
    md.append("")

    # window / effective context
    md.append("## Effective context (window simulation, 180k budget)\n")
    rows = []
    for model, w in scale["window"].items():
        rows.append((model, f"{w['real_tokens']:,}", f"{w['chars_carried']:,}",
                     f"{w['text_equiv_tokens']:,}",
                     f"{w['effective_ratio']}x", w["n_pages"],
                     f"${w['first_turn_usd']}", f"${w['cached_turn_usd']}"))
    md.append(table(rows, ["model", "real tok", "chars carried",
                           "text-equiv tok", "ratio", "pages",
                           "first turn", "cached turn"]))
    md.append("")

    # session cost curves
    md.append("## Session cost (40-turn agent session, 150k carried window)\n")
    profile = SessionProfile()
    rows = []
    for model in MODELS:
        base = session_cost(model, profile, effective_ratio=1.0)
        nocache = session_cost(model, SessionProfile(cache_enabled=False),
                               effective_ratio=1.0)
        w = scale["window"].get(model)
        if w is None:   # model was not simulated by bench_scale — say so
            rows.append((model, f"${nocache['total_usd']}",
                         f"${base['total_usd']}", "n/a", "not simulated", "n/a"))
            continue
        ratio = max(w.get("effective_ratio", 1.0), 1.0)
        opt = session_cost(model, profile, effective_ratio=ratio)
        rows.append((model, f"${nocache['total_usd']}", f"${base['total_usd']}",
                     f"${opt['total_usd']}", f"{ratio}x",
                     f"{(1 - opt['total_usd']/base['total_usd'])*100:.0f}%"))
    md.append(table(rows, ["model", "text, no cache", "text + cache",
                           "optical + cache", "ratio used",
                           "saving vs text+cache"]))
    md.append("\nNote: 1092x1092 pages survive every model tier undistorted "
              "(1,521 visual tokens). Standard-tier models simply price the "
              "same tokens differently; larger 1568px pages would be silently "
              "downscaled there.\n")

    # certification verdict
    md.append("## Certification verdict\n")
    for kind, c in scale["certify"]["by_kind"].items():
        md.append(f"- **{kind}**: median CER {c['median_cer']*100:.2f}% "
                  f"({c['sampled']}/{c['total']} pages sampled) — "
                  f"{'PASS' if c['passed'] else 'FAIL'} at gate "
                  f"{scale['certify']['gate']*100:.1f}%")

    out = "\n".join(md) + "\n"
    path = os.path.join(out_dir, "BENCHMARKS.md")
    open(path, "w").write(out)
    print(f"wrote {path}")
    return out


def _fmt(v):
    return f"{v*100:.2f}%" if v is not None else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="bench-results")
    run(ap.parse_args().out)


if __name__ == "__main__":
    main()
