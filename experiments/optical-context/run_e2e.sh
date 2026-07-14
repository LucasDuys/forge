#!/usr/bin/env bash
# End-to-end test of the optical context pipeline:
#   corpus -> [translate] -> render pages -> OCR fidelity check
#          -> font-size sweep (density vs accuracy vs token ratio)
#          -> section index -> search demo
#          -> (optional) real Claude API round trip if ANTHROPIC_API_KEY is set
#
# Deps: python3, pillow, pytesseract, python-Levenshtein, tesseract-ocr binary
#   pip install pillow pytesseract python-Levenshtein && apt-get install tesseract-ocr
set -euo pipefail
cd "$(dirname "$0")"

CORPUS="${1:-corpus/sample.md}"
OUT="${OUT:-e2e-out}"
FONT_PX="${FONT_PX:-11}"

rm -rf "${OUT}"
mkdir -p "${OUT}"

echo "== 1. deterministic translate (terse mode) =="
python3 translate.py "${CORPUS}" --mode terse -o "${OUT}/corpus.terse.txt"

echo
echo "== 2. render pages @ ${FONT_PX}px (packed, ascii-safe) =="
python3 render.py "${OUT}/corpus.terse.txt" -o "${OUT}/pages" --font-px "${FONT_PX}" --pack --ascii

echo
echo "== 3. OCR fidelity check (tesseract lower bound) =="
python3 ocr_check.py "${OUT}/pages"

echo
echo "== 4. font-size sweep: density vs accuracy vs Claude token ratio =="
python3 sweep.py "${CORPUS}" -o "${OUT}/sweep" --sizes "${SWEEP_SIZES:-8,9,10,11,12,14}"

echo
echo "== 5. section index + metadata =="
python3 sectionize.py index "${OUT}/corpus.terse.txt" "${OUT}/pages/manifest.json" \
  -o "${OUT}/index.json"

echo
echo "== 6. search demo =="
python3 sectionize.py search "${OUT}/index.json" "${QUERY:-token budget}"

echo
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "== 7. Claude round trip (page 0) =="
  python3 claude_roundtrip.py "${OUT}/pages" "${OUT}/corpus.terse.txt" --pages 0
else
  echo "== 7. Claude round trip: SKIPPED (set ANTHROPIC_API_KEY to run) =="
fi

echo
echo "done. artifacts in ${OUT}/"
