"""Tests for opticalctx.sectionizer (CONTRACT.md §sectionizer.py)."""

import unittest

from ..sectionizer import STOPWORDS, extract_meta, split


def rejoin(sections):
    return "".join(body for _, body in sections)


class SplitTest(unittest.TestCase):
    def test_empty_text(self):
        self.assertEqual(split(""), [])

    def test_markdown_headings(self):
        text = ("intro before any heading\n\n"
                "# First\nalpha body\n\n"
                "## Second\nbeta body\n\n"
                "# Third\ngamma body\n")
        sections = split(text)
        self.assertEqual(rejoin(sections), text)
        titles = [t for t, _ in sections]
        self.assertEqual(titles, ["(preamble)", "First", "Second", "Third"])
        self.assertIn("alpha body", sections[1][1])
        self.assertTrue(sections[1][1].startswith("# First"))

    def test_single_heading_falls_back_to_paragraphs(self):
        text = "# Only One\n\npara a\n\npara b\n"
        sections = split(text, max_chars=5)
        self.assertEqual(rejoin(sections), text)
        self.assertGreater(len(sections), 1)
        self.assertNotIn("(preamble)", [t for t, _ in sections])

    def test_paragraph_merge_up_to_max_chars(self):
        paras = [f"paragraph number {i} " + "x" * 50 for i in range(20)]
        text = "\n\n".join(paras)
        sections = split(text, max_chars=200)
        self.assertEqual(rejoin(sections), text)
        self.assertGreater(len(sections), 3)
        # merged blocks: every non-final section reached the threshold
        for _, body in sections[:-1]:
            self.assertGreaterEqual(len(body), 200)
        # titles come from the first line of the first paragraph in a block
        self.assertTrue(sections[0][0].startswith("paragraph number 0"))
        self.assertLessEqual(max(len(t) for t, _ in sections), 60)

    def test_determinism(self):
        text = "\n\n".join(f"block {i} " + "y" * 80 for i in range(10))
        self.assertEqual(split(text, max_chars=300),
                         split(text, max_chars=300))

    def test_code_split_on_def_class_boundaries(self):
        code = ('"""module docstring"""\n'
                "import os\n\n"
                "def alpha(x):\n    return x + 1\n\n"
                "class Beta:\n"
                "    def method(self):\n"
                "        return 2\n\n"
                "async def gamma():\n    pass\n")
        sections = split(code, kind="code")
        self.assertEqual(rejoin(sections), code)
        titles = [t for t, _ in sections]
        self.assertEqual(titles, ["(preamble)", "def alpha(x):",
                                  "class Beta:", "async def gamma():"])
        # indented def stays inside its class section (top-level only)
        self.assertIn("def method", sections[2][1])

    def test_code_hash_comments_not_headings(self):
        code = ("# comment one\nx = 1\n\n"
                "# comment two\ny = 2\n\n"
                "def f():\n    return x\n")
        sections = split(code, kind="code")
        self.assertEqual(rejoin(sections), code)
        titles = [t for t, _ in sections]
        self.assertEqual(titles, ["(preamble)", "def f():"])

    def test_code_without_defs_is_single_section(self):
        code = "x = 1\ny = 2\n"
        sections = split(code, kind="code")
        self.assertEqual(sections, [("x = 1", code)])

    def test_every_char_in_exactly_one_section(self):
        cases = [
            ("prose", "one\n\n\n\ntwo\n \nthree", 4),
            ("prose", "   \n\n   \n\n  ", 4),
            ("prose", "# A\nbody\n\n# B\nbody\n\n\ntrailing", 4000),
            ("prose", "no blank lines at all just one long line " * 10, 50),
            ("code", "def a():\n    pass\ndef b():\n    pass", 4000),
            ("code", "\n\ndef a():\n    pass\n\n# tail comment\n", 4000),
            ("docs", "alpha\n\nbeta\n\ngamma\n", 3),
            ("log", "line1\nline2\n\nline3\n", 4000),
        ]
        for kind, text, max_chars in cases:
            with self.subTest(kind=kind, text=text[:30]):
                sections = split(text, kind=kind, max_chars=max_chars)
                # exact partition: concatenation reproduces the input, so
                # every char lands in exactly one section
                self.assertEqual(rejoin(sections), text)
                self.assertEqual(sum(len(b) for _, b in sections), len(text))


class ExtractMetaTest(unittest.TestCase):
    def test_keywords_stopword_filtered_and_capped(self):
        text = ("the whale and the sea and the ship " * 3
                + "harpoon voyage captain deck mast sail rigging anchor "
                  "compass keel")
        meta = extract_meta("A Title", text)
        self.assertLessEqual(len(meta["keywords"]), 8)
        for kw in meta["keywords"]:
            self.assertNotIn(kw, STOPWORDS)
            self.assertEqual(kw, kw.lower())
        self.assertIn("whale", meta["keywords"])

    def test_keywords_ordered_by_frequency(self):
        meta = extract_meta("t", "zebra zebra zebra yak yak xerus")
        self.assertEqual(meta["keywords"][:2], ["zebra", "yak"])

    def test_gist_whitespace_normalized_and_truncated(self):
        text = "  leading   spaces\nand\tnewlines  " + "z" * 300
        meta = extract_meta("t", text)
        self.assertTrue(meta["gist"].startswith("leading spaces and newlines"))
        self.assertEqual(len(meta["gist"]), 160)
        self.assertNotIn("\n", meta["gist"])
        self.assertNotIn("\t", meta["gist"])
        self.assertNotIn("  ", meta["gist"])

    def test_empty_text(self):
        self.assertEqual(extract_meta("t", ""), {"keywords": [], "gist": ""})


if __name__ == "__main__":
    unittest.main()
