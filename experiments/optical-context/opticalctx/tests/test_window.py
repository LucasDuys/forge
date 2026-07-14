"""Tests for opticalctx.window.build_window and the CLI wiring
(CONTRACT.md §window.py / §cli.py).

Uses a hand-written page manifest + blank 1092x1092 PNG so no OCR engine
runs; window assembly only reads manifests.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from ..budget import tokens_for_model, usd
from ..constants import text_tokens_est
from ..index import BM25Index
from ..store import CanonicalStore
from ..window import build_window

MODEL = "sonnet-5"
PAGE_TOKENS = tokens_for_model(MODEL, 1092, 1092)  # 1521, no downscale


def _fake_page(pages_dir: Path, page_id: str, section_specs: list[dict],
               chars: int, passed: bool, kind: str = "prose") -> None:
    """Write a manifest + blank PNG the way renderer.render_batch would."""
    manifest = {
        "page_id": page_id, "renderer_version": "r1", "font_px": 11,
        "page_w": 1092, "page_h": 1092, "kind": kind,
        "sections": section_specs, "chars": chars, "image_tokens": 1521,
        "cert": {"tesseract_cer": 0.0 if passed else 0.5,
                 "rapidocr_cer": None,
                 "best_cer": 0.0 if passed else 0.5,
                 "passed": passed, "gate": 0.001},
        "line_crc32": [],
    }
    (pages_dir / f"{page_id}.json").write_text(json.dumps(manifest),
                                               encoding="utf-8")
    Image.new("L", (1092, 1092), 255).save(pages_dir / f"{page_id}.png")


class WindowFixture(unittest.TestCase):
    """Store with hot/cold text sections + one certified and one
    uncertified fake page."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / ".opticalctx"
        self.store = CanonicalStore(self.root)
        self.pages_dir = self.root / "pages"
        self.index = BM25Index(self.root / "index.json")

        def put(text, title):
            sid = self.store.put(text, source="doc.txt", kind="prose",
                                 title=title, keywords=[title.lower()],
                                 gist=text[:40])
            self.index.add(self.store.meta(sid))
            return sid

        self.hot_text = "hottest section body text. " * 20     # 540 chars
        self.warm_text = "warm section body text here. " * 15  # 435 chars
        self.cold_text = "cold never-touched section text. " * 10
        self.paged1_text = "first paged section content. " * 12
        self.paged2_text = "second paged section content. " * 12
        self.bad_text = "section on the page that failed OCR. " * 8

        self.s_hot = put(self.hot_text, "Hot")
        self.s_warm = put(self.warm_text, "Warm")
        self.s_cold = put(self.cold_text, "Cold")
        self.s_paged1 = put(self.paged1_text, "PagedOne")
        self.s_paged2 = put(self.paged2_text, "PagedTwo")
        self.s_bad = put(self.bad_text, "BadPage")

        for _ in range(3):
            self.store.touch(self.s_hot)
        self.store.touch(self.s_warm)

        self.good_page_id = "feedface00000001"
        self.bad_page_id = "deadbeef00000002"
        self.good_page_chars = 2000
        _fake_page(self.pages_dir, self.good_page_id,
                   [{"id": self.s_paged1, "char_start": 20,
                     "char_end": 1000},
                    {"id": self.s_paged2, "char_start": 1020,
                     "char_end": 2000}],
                   chars=self.good_page_chars, passed=True)
        _fake_page(self.pages_dir, self.bad_page_id,
                   [{"id": self.s_bad, "char_start": 20, "char_end": 320}],
                   chars=320, passed=False)
        self.store.mark_paged([self.s_paged1, self.s_paged2],
                              self.good_page_id)
        self.store.mark_paged([self.s_bad], self.bad_page_id)

    def plan(self, budget=20000, **kw):
        kw.setdefault("model", MODEL)
        kw.setdefault("pages_dir", self.pages_dir)
        return build_window(self.store, self.index,
                            token_budget=budget, **kw)


class BuildWindowTest(WindowFixture):
    def test_never_exceeds_budget(self):
        for budget in (0, 50, 200, 1600, 20000):
            plan = self.plan(budget=budget)
            self.assertLessEqual(plan.stats.real_tokens, budget)
            self.assertEqual(plan.stats.real_tokens,
                             sum(b.tokens for b in plan.blocks))

    def test_block_ordering(self):
        plan = self.plan()
        types = [b.type for b in plan.blocks]
        self.assertEqual(types[0], "toc")
        self.assertEqual(types.count("toc"), 1)
        # label immediately precedes its image
        for i, t in enumerate(types):
            if t == "page_image":
                self.assertEqual(types[i - 1], "page_label")
        # phase order: toc(0) -> hot text(1) -> pages(2) -> overflow text(3)
        phase = {"toc": 0, "text": None, "page_label": 2, "page_image": 2}
        seen_page = False
        last_phase = -1
        for b in plan.blocks:
            p = phase[b.type]
            if p is None:
                p = 3 if seen_page else 1
            else:
                seen_page = seen_page or p == 2
            self.assertGreaterEqual(p, last_phase)
            last_phase = p
        # hot texts come before the page; higher heat first
        contents = [b.content for b in plan.blocks]
        i_hot = contents.index(self.hot_text)
        i_warm = contents.index(self.warm_text)
        i_label = next(i for i, b in enumerate(plan.blocks)
                       if b.type == "page_label")
        self.assertLess(i_hot, i_warm)
        self.assertLess(i_warm, i_label)
        # cold + failed-page sections carried as text after the page
        self.assertGreater(contents.index(self.cold_text), i_label)
        self.assertGreater(contents.index(self.bad_text), i_label)

    def test_uncertified_page_excluded(self):
        plan = self.plan()
        image_paths = [b.content for b in plan.blocks
                       if b.type == "page_image"]
        self.assertEqual(
            image_paths, [str(self.pages_dir / f"{self.good_page_id}.png")])
        self.assertEqual(plan.stats.n_pages, 1)
        # the failed page's section rides as plain text instead
        self.assertIn(self.bad_text,
                      [b.content for b in plan.blocks if b.type == "text"])

    def test_page_tokens_use_model_downscale_math(self):
        plan = self.plan()
        image_blocks = [b for b in plan.blocks if b.type == "page_image"]
        self.assertEqual(image_blocks[0].tokens, PAGE_TOKENS)
        self.assertEqual(PAGE_TOKENS, 1521)  # 39*39 patches, high tier

    def test_page_label_mentions_titles(self):
        plan = self.plan()
        label = next(b for b in plan.blocks if b.type == "page_label")
        self.assertIn(self.good_page_id, label.content)
        self.assertIn("PagedOne", label.content)
        self.assertIn("PagedTwo", label.content)
        self.assertTrue(label.content.startswith("Image 1:"))

    def test_stats_arithmetic_real_vs_text_equiv(self):
        plan = self.plan()
        exp_real = exp_equiv = exp_chars = 0
        for b in plan.blocks:
            exp_real += b.tokens
            if b.type == "page_image":
                # text-equivalent counts CANONICAL section chars (per
                # section, prorated by on-page portion) — NOT the manifest
                # stream chars, which include NL_MARK/separator overhead
                exp_equiv += (text_tokens_est(len(self.paged1_text), "prose")
                              + text_tokens_est(len(self.paged2_text), "prose"))
                exp_chars += len(self.paged1_text) + len(self.paged2_text)
            else:
                exp_equiv += b.tokens
                exp_chars += len(b.content)
        s = plan.stats
        self.assertEqual(s.real_tokens, exp_real)
        self.assertEqual(s.text_equiv_tokens, exp_equiv)
        self.assertEqual(s.chars_carried, exp_chars)
        self.assertEqual(s.n_text_sections,
                         sum(1 for b in plan.blocks if b.type == "text"))
        self.assertAlmostEqual(s.effective_ratio, exp_equiv / exp_real)
        # finalize() ran: costs match budget.usd
        self.assertAlmostEqual(s.first_turn_usd, usd(MODEL, exp_real))
        self.assertAlmostEqual(s.cached_turn_usd,
                               usd(MODEL, exp_real, cache_read=True))

    def test_small_budget_drops_pages(self):
        big = self.plan()
        pre_page = sum(b.tokens for b in big.blocks[
            :next(i for i, b in enumerate(big.blocks)
                  if b.type == "page_label")])
        plan = self.plan(budget=pre_page + 500)  # page pair (1521+) won't fit
        self.assertEqual(plan.stats.n_pages, 0)
        self.assertLessEqual(plan.stats.real_tokens, pre_page + 500)

    def test_hot_text_budget_cap(self):
        plan = self.plan(hot_text_budget=0)
        types = [b.type for b in plan.blocks]
        # no hot text: first block after toc is the page label
        self.assertEqual(types[1], "page_label")
        # hot sections still arrive later as overflow text (they are unpaged)
        contents = [b.content for b in plan.blocks]
        self.assertIn(self.hot_text, contents)

    def test_hot_section_not_duplicated(self):
        plan = self.plan()
        contents = [b.content for b in plan.blocks]
        self.assertEqual(contents.count(self.hot_text), 1)

    def test_paged_certified_sections_not_repeated_as_text(self):
        plan = self.plan()
        texts = [b.content for b in plan.blocks if b.type == "text"]
        self.assertNotIn(self.paged1_text, texts)
        self.assertNotIn(self.paged2_text, texts)

    def test_zero_budget_empty_plan(self):
        plan = self.plan(budget=0)
        self.assertEqual(plan.blocks, [])
        self.assertEqual(plan.stats.real_tokens, 0)
        self.assertEqual(plan.stats.effective_ratio, 0.0)

    def test_query_pulls_search_hits_into_hot_text(self):
        plan = self.plan(query="cold never-touched")
        contents = [b.content for b in plan.blocks]
        i_cold = contents.index(self.cold_text)
        i_label = next(i for i, b in enumerate(plan.blocks)
                       if b.type == "page_label")
        self.assertLess(i_cold, i_label)  # promoted ahead of pages


class CliTest(unittest.TestCase):
    """Smoke tests for the OCR-free CLI paths (init/ingest/search/window)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.root = self.base / ".opticalctx"

    def _run(self, argv) -> tuple[int, str]:
        from .. import cli
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(argv)
        return code, out.getvalue()

    def test_init_ingest_search_window_json(self):
        doc = self.base / "notes.txt"
        doc.write_text("alpha section about parsers.\n\n"
                       "beta section about tokenizers and budgets.\n",
                       encoding="utf-8")
        code, _ = self._run(["init", "--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertTrue((self.root / "config.json").exists())

        code, out = self._run(["ingest", "--root", str(self.root), str(doc)])
        self.assertEqual(code, 0)
        self.assertIn("notes.txt", out)
        self.assertTrue((self.root / "index.json").exists())

        code, out = self._run(["search", "--root", str(self.root),
                               "tokenizers"])
        self.assertEqual(code, 0)
        self.assertIn("notes.txt", out)

        code, out = self._run(["window", "--root", str(self.root),
                               "--budget", "5000", "--model", MODEL,
                               "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertLessEqual(payload["stats"]["real_tokens"], 5000)
        self.assertEqual(payload["blocks"][0]["type"], "toc")
        self.assertEqual(payload["stats"]["model"], MODEL)

    def test_ingest_kind_autodetect_code(self):
        src = self.base / "tool.py"
        src.write_text("def alpha():\n    return 1\n\n"
                       "def beta():\n    return 2\n", encoding="utf-8")
        code, out = self._run(["init", "--root", str(self.root)])
        self.assertEqual(code, 0)
        code, out = self._run(["ingest", "--root", str(self.root), str(src)])
        self.assertEqual(code, 0)
        self.assertIn("(code)", out)

    def test_get_touches_ledger(self):
        doc = self.base / "a.txt"
        doc.write_text("just one paragraph of text.\n", encoding="utf-8")
        self._run(["init", "--root", str(self.root)])
        self._run(["ingest", "--root", str(self.root), str(doc)])
        store = CanonicalStore(self.root)
        sid = store.all_meta()[0]["id"]
        code, out = self._run(["get", "--root", str(self.root), sid])
        self.assertEqual(code, 0)
        self.assertIn("just one paragraph", out)
        self.assertEqual(CanonicalStore(self.root).heat(sid), 1)

    def test_stats_runs(self):
        self._run(["init", "--root", str(self.root)])
        code, out = self._run(["stats", "--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertIn("sections:", out)


if __name__ == "__main__":
    unittest.main()
