#!/usr/bin/env bash
# Full local benchmark: fidelity grid -> at-scale ingest/render/certify ->
# economics report. No API key needed; runtime is dominated by OCR (CPU).
# Results land in bench-results/ (BENCHMARKS.md + JSON).
set -euo pipefail
cd "$(dirname "$0")"

[ -s bench-corpus/war-and-peace.txt ] || bench-corpus/fetch_corpus.sh

echo "== fidelity grid (kind x font size x engine) =="
python3 -m opticalctx.bench.bench_fidelity --corpus bench-corpus --out bench-results

echo
echo "== scale bench (full corpus ingest -> pages -> window sim) =="
python3 -m opticalctx.bench.bench_scale --corpus bench-corpus --out bench-results

echo
echo "== economics report =="
python3 -m opticalctx.bench.bench_economics --out bench-results

echo
echo "done: bench-results/BENCHMARKS.md"
