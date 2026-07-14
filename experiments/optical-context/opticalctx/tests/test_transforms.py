"""Tests for opticalctx.transforms (pack/unpack/asciify/normalize/terse)."""

import unittest

from ..transforms import NL_MARK, asciify, normalize, pack, terse, unpack


class TestPackUnpack(unittest.TestCase):
    def test_nl_mark_value(self):
        self.assertEqual(NL_MARK, " @@ ")

    def test_roundtrip_multiline(self):
        text = "first line\nsecond line\n\nfourth line\nno trailing newline"
        self.assertEqual(unpack(pack(text)), text)

    def test_roundtrip_empty_and_single_line(self):
        self.assertEqual(unpack(pack("")), "")
        self.assertEqual(unpack(pack("one line no newline")),
                         "one line no newline")

    def test_pack_strips_trailing_whitespace_before_newline(self):
        self.assertEqual(pack("a  \nb\t\nc"), "a" + NL_MARK + "b" + NL_MARK + "c")

    def test_pack_produces_stream_without_newlines(self):
        packed = pack("a\nb\nc\n")
        self.assertNotIn("\n", packed)
        self.assertEqual(packed.count(NL_MARK), 3)

    def test_roundtrip_of_50_line_document(self):
        text = "\n".join(f"line {i}: some content here" for i in range(50))
        self.assertEqual(unpack(pack(text)), text)


class TestAsciify(unittest.TestCase):
    def test_known_mappings(self):
        self.assertEqual(asciify("a → b"), "a -> b")
        self.assertEqual(asciify("x — y – z"), "x -- y - z")
        self.assertEqual(asciify("“quoted” and ‘single’"),
                         '"quoted" and \'single\'')
        self.assertEqual(asciify("✓ done ✗ todo"), "[x] done [ ] todo")
        self.assertEqual(asciify("├── file"), "|--- file")
        self.assertEqual(asciify("a ≥ b ≤ c ≈ d"), "a >= b <= c ~= d")
        self.assertEqual(asciify("wait…"), "wait...")
        self.assertEqual(asciify("• bullet"), "* bullet")

    def test_unmapped_unicode_replaced(self):
        self.assertEqual(asciify("café"), "caf?")
        self.assertEqual(asciify("日本"), "??")

    def test_pure_ascii_unchanged(self):
        text = "plain ASCII text 123 !@# with\nnewlines\tand tabs"
        self.assertEqual(asciify(text), text)

    def test_result_is_always_ascii(self):
        mixed = "α β γ → δ … ≈"
        asciify(mixed).encode("ascii")  # must not raise

    def test_deterministic(self):
        text = "→ … ✓ é ß"
        self.assertEqual(asciify(text), asciify(text))


class TestNormalize(unittest.TestCase):
    def test_strips_trailing_whitespace(self):
        self.assertEqual(normalize("hello   \nworld\t"), "hello\nworld")

    def test_collapses_blank_line_runs(self):
        self.assertEqual(normalize("a\n\n\n\n\nb"), "a\n\nb")
        # two newlines (one blank line) preserved
        self.assertEqual(normalize("a\n\nb"), "a\n\nb")

    def test_collapses_punctuation_runs(self):
        self.assertEqual(normalize("what!!!!"), "what!")
        self.assertEqual(normalize("really????"), "really?")
        self.assertEqual(normalize("wait....."), "wait.")
        # runs of 1-2 kept
        self.assertEqual(normalize("ok.. fine"), "ok.. fine")

    def test_deterministic_and_idempotent(self):
        text = "a   \n\n\n\nb!!!!\nend"
        once = normalize(text)
        self.assertEqual(normalize(once), once)


class TestTerse(unittest.TestCase):
    def test_substitutions(self):
        self.assertEqual(terse("in order to win"), "to win")
        self.assertEqual(terse("edit the configuration file"),
                         "edit the config file")
        self.assertEqual(terse("check the repository directory"),
                         "check the repo dir")

    def test_case_insensitive(self):
        self.assertEqual(terse("In Order To win"), "to win")

    def test_drops_filler_and_tidies_spacing(self):
        out = terse("Note that this works, however it is slow.")
        self.assertNotIn("Note that", out)
        self.assertNotIn("however", out)
        self.assertNotIn("  ", out)
        self.assertNotIn(" ,", out)

    def test_never_longer_input_shrinks(self):
        text = ("It is important to note that the implementation of the "
                "configuration is able to work in order to succeed, "
                "for example when the repository environment is set.")
        self.assertLess(len(terse(text)), len(text))

    def test_deterministic(self):
        text = "in order to test the implementation, note that we retry"
        self.assertEqual(terse(text), terse(text))


if __name__ == "__main__":
    unittest.main()
