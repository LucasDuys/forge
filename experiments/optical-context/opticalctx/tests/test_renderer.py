"""Tests for opticalctx.renderer (render_batch: packing, determinism,
page fill, multi-page section offsets, manifests)."""

import json
import tempfile
import unittest
import zlib
from pathlib import Path

from ..constants import RENDERER_VERSION, image_tokens
from ..renderer import RenderConfig, page_geometry, render_batch
from ..transforms import asciify, pack

# Small pages keep the supersampled draws fast in most tests.
SMALL_CFG = RenderConfig(font_px=10, page_w=280, page_h=280, margin=6)


def prose(n_chars: int) -> str:
    sentences = [
        "The whale surfaced slowly beneath a pale morning sky.",
        "Every rope on deck had been coiled twice before dawn watch.",
        "Ishmael counted the barrels and wrote the tally in chalk.",
        "A low fog rolled over the water and hid the distant sails.",
    ]
    out, i = [], 0
    while sum(len(s) + 1 for s in out) < n_chars:
        out.append(sentences[i % len(sentences)])
        i += 1
    return "\n".join(out)[:n_chars]


class TestPageGeometry(unittest.TestCase):
    def test_reasonable_grid(self):
        cols, rows = page_geometry(RenderConfig())
        self.assertGreater(cols, 100)
        self.assertGreater(rows, 40)

    def test_too_large_font_raises(self):
        with self.assertRaises(ValueError):
            page_geometry(RenderConfig(font_px=500, page_w=280, page_h=280))


class TestDeterminism(unittest.TestCase):
    def test_two_runs_byte_identical(self):
        sections = [("aaaa000011112222", prose(600)),
                    ("bbbb000011112222", "short second section\nwith lines")]
        with tempfile.TemporaryDirectory() as d1, \
                tempfile.TemporaryDirectory() as d2:
            r1 = render_batch(sections, d1, SMALL_CFG)
            r2 = render_batch(sections, d2, SMALL_CFG)
            self.assertEqual([p.page_id for p in r1], [p.page_id for p in r2])
            self.assertEqual([p.rendered_text for p in r1],
                             [p.rendered_text for p in r2])
            for p1, p2 in zip(r1, r2):
                self.assertEqual(Path(p1.png_path).read_bytes(),
                                 Path(p2.png_path).read_bytes())

    def test_different_content_different_page_id(self):
        with tempfile.TemporaryDirectory() as d:
            ra = render_batch([("aaaa000011112222", "content A")], d, SMALL_CFG)
            rb = render_batch([("aaaa000011112222", "content B")], d, SMALL_CFG)
            self.assertNotEqual(ra[0].page_id, rb[0].page_id)

    def test_page_id_depends_on_config(self):
        cfg2 = RenderConfig(font_px=11, page_w=280, page_h=280, margin=6)
        with tempfile.TemporaryDirectory() as d1, \
                tempfile.TemporaryDirectory() as d2:
            ra = render_batch([("aaaa000011112222", "same content")], d1, SMALL_CFG)
            rb = render_batch([("aaaa000011112222", "same content")], d2, cfg2)
            self.assertNotEqual(ra[0].page_id, rb[0].page_id)


class TestPageFill(unittest.TestCase):
    def test_50k_prose_fills_pages_over_80_percent(self):
        cfg = RenderConfig()  # default 1092x1092 @ 11px
        cols, rows = page_geometry(cfg)
        capacity = cols * rows
        text = prose(50_000)
        with tempfile.TemporaryDirectory() as d:
            pages = render_batch([("cccc000011112222", text)], d, cfg)
        self.assertGreater(len(pages), 1)
        # every page except possibly the last is filled to exact capacity
        for p in pages[:-1]:
            self.assertEqual(p.chars, capacity)
        for p in pages:
            self.assertGreater(p.chars / capacity, 0.0)
        self.assertGreater(pages[0].chars / capacity, 0.8)
        # overall fill across full pages
        full = pages[:-1]
        fill = sum(p.chars for p in full) / (capacity * len(full))
        self.assertGreater(fill, 0.8)


class TestSectionOffsets(unittest.TestCase):
    def test_section_spanning_pages_has_correct_offsets(self):
        cols, rows = page_geometry(SMALL_CFG)
        capacity = cols * rows
        sec_a = ("aaaa000011112222", "intro section, quite short")
        sec_b = ("bbbb000011112222", prose(3 * capacity))  # must span pages
        sec_c = ("cccc000011112222", "closing section text")
        sections = [sec_a, sec_b, sec_c]
        with tempfile.TemporaryDirectory() as d:
            pages = render_batch(sections, d, SMALL_CFG)

        self.assertGreater(len(pages), 2)
        pages_with_b = [p for p in pages
                        if any(s["id"] == sec_b[0] for s in p.sections)]
        self.assertGreater(len(pages_with_b), 1)

        # reassemble each section's content by slicing rendered_text with
        # the per-page offsets; it must equal the packed+asciified input
        for sid, raw in sections:
            expected = pack(asciify(raw))
            got = []
            for p in pages:
                for s in p.sections:
                    if s["id"] == sid:
                        got.append(p.rendered_text[s["char_start"]:s["char_end"]])
            self.assertEqual("".join(got), expected, f"section {sid} mangled")

        # offsets are within each page's slice and ordered
        for p in pages:
            for s in p.sections:
                self.assertGreaterEqual(s["char_start"], 0)
                self.assertLessEqual(s["char_end"], len(p.rendered_text))
                self.assertLess(s["char_start"], s["char_end"])


class TestManifest(unittest.TestCase):
    def test_manifest_contents(self):
        cols, _ = page_geometry(SMALL_CFG)
        with tempfile.TemporaryDirectory() as d:
            pages = render_batch(
                [("dddd000011112222", prose(500))], d, SMALL_CFG, kind="prose")
            for p in pages:
                self.assertTrue(Path(p.png_path).exists())
                self.assertEqual(Path(p.png_path).name, f"{p.page_id}.png")
                m = json.loads(Path(p.manifest_path).read_text())
                self.assertEqual(m["page_id"], p.page_id)
                self.assertEqual(m["renderer_version"], RENDERER_VERSION)
                self.assertEqual(m["font_px"], SMALL_CFG.font_px)
                self.assertEqual(m["page_w"], SMALL_CFG.page_w)
                self.assertEqual(m["page_h"], SMALL_CFG.page_h)
                self.assertEqual(m["kind"], "prose")
                self.assertIsNone(m["cert"])
                self.assertEqual(m["chars"], len(p.rendered_text))
                self.assertEqual(
                    m["image_tokens"],
                    image_tokens(SMALL_CFG.page_w, SMALL_CFG.page_h))
                self.assertEqual(m["sections"], p.sections)
                lines = [p.rendered_text[i:i + cols]
                         for i in range(0, len(p.rendered_text), cols)]
                self.assertEqual(m["line_crc32"],
                                 [zlib.crc32(l.encode()) for l in lines])

    def test_empty_sections_list(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(render_batch([], d, SMALL_CFG), [])

    def test_separator_present_in_stream(self):
        with tempfile.TemporaryDirectory() as d:
            pages = render_batch([("eeee000011112222", "hello")], d, SMALL_CFG)
            self.assertEqual(len(pages), 1)
            self.assertEqual(pages[0].rendered_text,
                             " @[eeee000011112222]@ hello")


if __name__ == "__main__":
    unittest.main()
