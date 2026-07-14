#!/usr/bin/env python3
"""Scale benchmark: ingest the full corpus, render everything to pages,
measure throughput, index size, search latency, and window assembly.

Certification at scale samples N pages per kind (full-corpus OCR of
hundreds of pages would take hours on CPU); the sampled CER is stamped
into remaining manifests marked "extrapolated": true so the window
simulator can include them. Sampled vs extrapolated counts are reported —
no silent inflation.

Usage: python3 -m opticalctx.bench.bench_scale [--corpus DIR] [--root DIR]
       [--out DIR] [--cert-sample N] [--gate 0.005]
"""

import argparse
import json
import os
import random
import shutil
import statistics
import time

from ..index import BM25Index
from ..ocr import certify
from ..renderer import RenderConfig, render_batch
from ..sectionizer import extract_meta, split
from ..store import CanonicalStore
from ..window import build_window

KIND_FILES = {
    "prose": ["war-and-peace.txt", "moby-dick.txt"],
    "code": ["python-stdlib.py"],
    "log": ["agent-log.txt"],
    "docs": ["git-docs.adoc"],
}

QUERIES = ["prince andrew battle", "whale harpoon deck", "token budget retry",
           "def parse arguments", "http request timeout", "exit code failure",
           "love marriage soul", "class method return", "deploy script bash",
           "configuration option value"]


def run(corpus_dir, root, out_dir, cert_sample=6, gate=0.005, font_px=11):
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    store = CanonicalStore(root)
    index = BM25Index(os.path.join(root, "index.json"))
    report = {"font_px": font_px, "gate": gate}

    # -- ingest ------------------------------------------------------------
    t0 = time.monotonic()
    total_chars = n_sections = 0
    for kind, files in KIND_FILES.items():
        for fname in files:
            path = os.path.join(corpus_dir, fname)
            if not os.path.exists(path):
                continue
            text = open(path, encoding="utf-8", errors="ignore").read()
            total_chars += len(text)
            for title, body in split(text, kind=kind):
                meta = extract_meta(title, body)
                sid = store.put(body, source=fname, kind=kind, title=title,
                                keywords=meta["keywords"], gist=meta["gist"])
                index.add({**store.meta(sid)})
                n_sections += 1
    index.save()
    ingest_s = time.monotonic() - t0
    report["ingest"] = {
        "chars": total_chars, "sections": n_sections,
        "seconds": round(ingest_s, 2),
        "chars_per_s": round(total_chars / ingest_s),
        "index_bytes": os.path.getsize(os.path.join(root, "index.json")),
    }
    print(f"ingest: {total_chars} chars -> {n_sections} sections "
          f"in {ingest_s:.1f}s")

    # -- render (flush) ----------------------------------------------------
    pages_dir = os.path.join(root, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    t0 = time.monotonic()
    all_pages = []
    for kind in KIND_FILES:
        secs = [(m["id"], store.get(m["id"])) for m in store.unpaged(kind)]
        if not secs:
            continue
        pages = render_batch(secs, pages_dir, RenderConfig(font_px=font_px),
                             kind=kind)
        for p in pages:
            covered = {s["id"] for s in p.sections}
            store.mark_paged(sorted(covered), p.page_id)
        all_pages.extend((kind, p) for p in pages)
    render_s = time.monotonic() - t0
    report["render"] = {
        "pages": len(all_pages), "seconds": round(render_s, 2),
        "pages_per_s": round(len(all_pages) / render_s, 2),
        "chars_per_page_avg": round(
            statistics.mean(p.chars for _, p in all_pages)),
    }
    print(f"render: {len(all_pages)} pages in {render_s:.1f}s")

    # -- certify (sampled) ---------------------------------------------------
    rng = random.Random(7)
    t0 = time.monotonic()
    cert_stats, n_certified = {}, 0
    by_kind = {}
    for kind, p in all_pages:
        by_kind.setdefault(kind, []).append(p)
    for kind, pages in by_kind.items():
        sample = rng.sample(pages, min(cert_sample, len(pages)))
        cers = []
        for p in sample:
            cert = certify(p.png_path, p.rendered_text, gate=gate)
            _stamp(p.manifest_path, cert.best_cer, cert.best_cer <= gate,
                   gate, extrapolated=False)
            cers.append(cert.best_cer)
            n_certified += 1
        kind_cer = statistics.median(cers)
        passed = kind_cer <= gate
        for p in pages:
            if p not in sample:
                _stamp(p.manifest_path, kind_cer, passed, gate,
                       extrapolated=True)
        cert_stats[kind] = {"sampled": len(sample), "total": len(pages),
                            "median_cer": round(kind_cer, 5), "passed": passed}
        print(f"certify {kind}: median CER {kind_cer*100:.2f}% "
              f"({len(sample)}/{len(pages)} sampled) "
              f"{'PASS' if passed else 'FAIL'} @ gate {gate*100:.1f}%")
    report["certify"] = {"seconds": round(time.monotonic() - t0, 2),
                         "gate": gate, "by_kind": cert_stats}

    # -- search latency ------------------------------------------------------
    lat = []
    for q in QUERIES * 10:
        t0 = time.monotonic()
        index.search(q, k=5)
        lat.append((time.monotonic() - t0) * 1000)
    lat.sort()
    report["search"] = {"n_queries": len(lat),
                        "p50_ms": round(lat[len(lat) // 2], 2),
                        "p95_ms": round(lat[int(len(lat) * 0.95)], 2)}
    print(f"search: p50 {report['search']['p50_ms']}ms "
          f"p95 {report['search']['p95_ms']}ms over {n_sections} sections")

    # -- window assembly ------------------------------------------------------
    windows = {}
    for model, budget in [("sonnet-5", 180_000), ("haiku-4.5", 180_000)]:
        t0 = time.monotonic()
        plan = build_window(store, index, token_budget=budget, model=model,
                            pages_dir=pages_dir)
        s = plan.stats
        windows[model] = {
            "build_ms": round((time.monotonic() - t0) * 1000, 1),
            "real_tokens": s.real_tokens,
            "text_equiv_tokens": s.text_equiv_tokens,
            "chars_carried": s.chars_carried,
            "effective_ratio": round(s.effective_ratio, 3),
            "n_pages": s.n_pages, "n_text_sections": s.n_text_sections,
            "first_turn_usd": round(s.first_turn_usd, 4),
            "cached_turn_usd": round(s.cached_turn_usd, 4),
        }
        print(f"window[{model}]: {s.real_tokens} tok carries "
              f"{s.chars_carried} chars (ratio {s.effective_ratio:.2f}x, "
              f"{s.n_pages} pages)")
    report["window"] = windows

    disk = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(root) for f in fs)
    report["disk_bytes"] = disk
    with open(os.path.join(out_dir, "scale.json"), "w") as f:
        json.dump(report, f, indent=2)
    return report


def _stamp(manifest_path, cer_value, passed, gate, extrapolated):
    m = json.load(open(manifest_path))
    m["cert"] = {"best_cer": round(cer_value, 5), "passed": passed,
                 "gate": gate, "extrapolated": extrapolated}
    json.dump(m, open(manifest_path, "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="bench-corpus")
    ap.add_argument("--root", default="bench-results/store")
    ap.add_argument("--out", default="bench-results")
    ap.add_argument("--cert-sample", type=int, default=6)
    ap.add_argument("--gate", type=float, default=0.005)
    ap.add_argument("--font-px", type=int, default=11)
    a = ap.parse_args()
    run(a.corpus, a.root, a.out, a.cert_sample, a.gate, a.font_px)


if __name__ == "__main__":
    main()
