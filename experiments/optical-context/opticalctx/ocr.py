"""OCR certification for rendered pages.

Ports ../ocr_check.py into the library: char-level fidelity is scored as
1 - Levenshtein ratio after whitespace normalization (line wrapping
legitimately changes whitespace — see ../REPORT.md "OCR fidelity" and
../SCALE.md certification gate discussion). Tesseract is the conservative
local proxy for machine readability; RapidOCR is the second opinion. A page
is certified when the best available engine's CER clears the gate.

Engines degrade gracefully: an unavailable or failing engine records None
for its CER and never raises. Only when *no* engine produces a reading does
`certify` raise RuntimeError.
"""

import json
import re
from dataclasses import dataclass

from Levenshtein import ratio as _lev_ratio

_WS = re.compile(r"\s+")


@dataclass
class CertResult:
    tesseract_cer: float | None
    rapidocr_cer: float | None
    best_cer: float
    passed: bool


def _normalize(s: str) -> str:
    return _WS.sub(" ", s).strip()


def cer(ocr_text: str, truth: str) -> float:
    """Character error rate: 1 - Levenshtein.ratio on whitespace-normalized
    strings. 0.0 = perfect, 1.0 = nothing in common."""
    return 1.0 - _lev_ratio(_normalize(ocr_text), _normalize(truth))


def _run_tesseract(png_path: str) -> str:
    import pytesseract
    from PIL import Image

    with Image.open(png_path) as img:
        return pytesseract.image_to_string(img, config="--psm 6")


# RapidOCR init loads onnx models (slow); cache one instance per process.
_rapidocr_engine = None


def _run_rapidocr(png_path: str) -> str:
    global _rapidocr_engine
    from rapidocr_onnxruntime import RapidOCR

    if _rapidocr_engine is None:
        _rapidocr_engine = RapidOCR()
    out = _rapidocr_engine(png_path)
    # RapidOCR returns (result, elapse_times); result is a list of
    # [box, text, confidence] triples, or None when nothing was detected.
    if isinstance(out, tuple):
        out = out[0]
    if not out:
        return ""
    return "\n".join(item[1] for item in out)


_ENGINES = {
    "tesseract": _run_tesseract,
    "rapidocr": _run_rapidocr,
}


def certify(png_path: str, truth_text: str, gate: float = 0.001,
            engines: tuple = ("tesseract", "rapidocr")) -> CertResult:
    """OCR `png_path` with each requested engine and score against
    `truth_text`. Missing/failing engines yield None; best_cer is the min
    over the engines that ran; passed = best_cer <= gate. Raises
    RuntimeError only if no engine produced a reading."""
    scores: dict[str, float | None] = {"tesseract": None, "rapidocr": None}
    for name in engines:
        runner = _ENGINES.get(name)
        if runner is None:
            continue
        try:
            text = runner(png_path)
        except Exception:
            continue  # import error, missing binary, engine crash: skip
        scores[name] = cer(text, truth_text)
    available = [v for v in scores.values() if v is not None]
    if not available:
        raise RuntimeError(
            f"no OCR engines available (tried: {', '.join(engines)})")
    best = min(available)
    return CertResult(
        tesseract_cer=scores["tesseract"],
        rapidocr_cer=scores["rapidocr"],
        best_cer=best,
        passed=best <= gate,
    )


def update_manifest_cert(manifest_path: str, cert: CertResult,
                         gate: float) -> None:
    """Write the cert block into an existing page manifest JSON (see
    CONTRACT.md page manifest schema)."""
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["cert"] = {
        "tesseract_cer": cert.tesseract_cer,
        "rapidocr_cer": cert.rapidocr_cer,
        "best_cer": cert.best_cer,
        "passed": cert.passed,
        "gate": gate,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
