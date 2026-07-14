"""Tests for opticalctx.ocr — cer math, certify on a rendered image,
manifest cert update, and engine degradation."""

import json
import os
import shutil
import tempfile
import unittest

from PIL import Image, ImageDraw, ImageFont

from ..ocr import CertResult, cer, certify, update_manifest_cert

DEJAVU_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

HAVE_TESSERACT = shutil.which("tesseract") is not None
try:
    import rapidocr_onnxruntime  # noqa: F401
    HAVE_RAPIDOCR = True
except Exception:
    HAVE_RAPIDOCR = False


def render_text_png(path, text, font_px=20):
    """Render black-on-white text large enough for tesseract to read."""
    font = ImageFont.truetype(DEJAVU_MONO, font_px)
    lines = text.split("\n")
    char_w = int(font.getlength("M")) + 1
    w = max(len(ln) for ln in lines) * char_w + 40
    h = len(lines) * (font_px + 8) + 40
    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    y = 20
    for ln in lines:
        draw.text((20, y), ln, fill="black", font=font)
        y += font_px + 8
    img.save(path)


class TestCer(unittest.TestCase):
    def test_identical_is_zero(self):
        self.assertEqual(cer("abc", "abc"), 0.0)

    def test_known_noise_value(self):
        # Levenshtein.ratio('abcd','abxd') == 0.75 (substitution costs 2
        # over lensum 8), so cer == 0.25.
        self.assertAlmostEqual(cer("abcd", "abxd"), 0.25)

    def test_whitespace_normalized(self):
        self.assertEqual(cer("a  b\n\tc ", "a b c"), 0.0)

    def test_empty_vs_empty(self):
        self.assertEqual(cer("", ""), 0.0)

    def test_totally_different(self):
        self.assertGreater(cer("xyz", "abc"), 0.9)


class TestCertify(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_no_engines_raises(self):
        png = os.path.join(self.dir, "x.png")
        Image.new("RGB", (10, 10), "white").save(png)
        with self.assertRaises(RuntimeError):
            certify(png, "hello", engines=("bogus-engine",))

    def test_missing_engine_degrades_to_none(self):
        if not HAVE_TESSERACT:
            self.skipTest("tesseract not installed")
        truth = "HELLO WORLD 42"
        png = os.path.join(self.dir, "page.png")
        render_text_png(png, truth)
        res = certify(png, truth, gate=0.5, engines=("tesseract", "bogus"))
        self.assertIsInstance(res, CertResult)
        self.assertIsNotNone(res.tesseract_cer)
        self.assertIsNone(res.rapidocr_cer)
        self.assertEqual(res.best_cer, res.tesseract_cer)

    def test_certify_tesseract_reads_clean_render(self):
        if not HAVE_TESSERACT:
            self.skipTest("tesseract not installed")
        truth = "The quick brown fox jumps over the lazy dog 0123456789"
        png = os.path.join(self.dir, "page.png")
        render_text_png(png, truth, font_px=20)
        res = certify(png, truth, gate=0.05, engines=("tesseract",))
        self.assertIsNotNone(res.tesseract_cer)
        self.assertLess(res.tesseract_cer, 0.05)
        self.assertEqual(res.best_cer, res.tesseract_cer)
        self.assertTrue(res.passed)

    def test_certify_rapidocr(self):
        if not HAVE_RAPIDOCR:
            self.skipTest("rapidocr not installed")
        truth = "HELLO WORLD"
        png = os.path.join(self.dir, "small.png")
        render_text_png(png, truth, font_px=20)
        res = certify(png, truth, gate=0.5, engines=("rapidocr",))
        self.assertIsNotNone(res.rapidocr_cer)
        self.assertIsNone(res.tesseract_cer)
        self.assertLessEqual(res.best_cer, 1.0)
        self.assertEqual(res.passed, res.best_cer <= 0.5)

    def test_gate_controls_passed(self):
        if not HAVE_TESSERACT:
            self.skipTest("tesseract not installed")
        truth = "GATE CHECK TEXT"
        png = os.path.join(self.dir, "gate.png")
        render_text_png(png, truth)
        loose = certify(png, truth, gate=1.0, engines=("tesseract",))
        self.assertTrue(loose.passed)
        # gate below any achievable nonzero CER but consistent either way
        strict = certify(png, "completely different truth text zzz",
                         gate=0.0001, engines=("tesseract",))
        self.assertFalse(strict.passed)


class TestUpdateManifestCert(unittest.TestCase):
    def test_writes_cert_block(self):
        with tempfile.TemporaryDirectory() as d:
            manifest_path = os.path.join(d, "page.json")
            manifest = {
                "page_id": "deadbeef00000000",
                "renderer_version": "r1",
                "font_px": 11,
                "page_w": 1092,
                "page_h": 1092,
                "kind": "prose",
                "sections": [{"id": "abc", "char_start": 0, "char_end": 10}],
                "chars": 10,
                "image_tokens": 1521,
                "cert": None,
                "line_crc32": [1, 2, 3],
            }
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f)

            cert = CertResult(tesseract_cer=0.021, rapidocr_cer=0.004,
                              best_cer=0.004, passed=False)
            update_manifest_cert(manifest_path, cert, gate=0.001)

            with open(manifest_path, encoding="utf-8") as f:
                updated = json.load(f)
            self.assertEqual(updated["cert"], {
                "tesseract_cer": 0.021,
                "rapidocr_cer": 0.004,
                "best_cer": 0.004,
                "passed": False,
                "gate": 0.001,
            })
            # rest of the manifest untouched
            self.assertEqual(updated["page_id"], "deadbeef00000000")
            self.assertEqual(updated["line_crc32"], [1, 2, 3])
            self.assertEqual(updated["sections"], manifest["sections"])


if __name__ == "__main__":
    unittest.main()
