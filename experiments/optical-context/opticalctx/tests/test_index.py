"""Tests for opticalctx.index.BM25Index."""

import tempfile
import unittest
from pathlib import Path

from ..index import BM25Index


def rec(rid, source, kind, title, keywords, gist):
    return {"id": rid, "source": source, "kind": kind, "title": title,
            "keywords": keywords, "gist": gist, "chars": len(gist),
            "created": "", "page_id": None}


def sample_records():
    return [
        rec("aaa1", "forge.md", "docs", "Token budget enforcement",
            ["token", "budget", "enforcement", "ceiling", "session"],
            "Per-task token budgets are enforced at every state machine "
            "transition; budget exhaustion writes a handoff."),
        rec("bbb2", "forge.md", "docs", "Git worktree isolation",
            ["worktree", "git", "isolation", "merge"],
            "Each task runs in an isolated git worktree; success squash-"
            "merges into the parent branch."),
        rec("ccc3", "moby.txt", "prose", "Loomings",
            ["ishmael", "whale", "sea", "ship"],
            "Call me Ishmael. Some years ago, never mind how long "
            "precisely, having little money in my purse."),
        rec("ddd4", "kernel.log", "log", "Boot sequence",
            ["kernel", "boot", "init", "driver"],
            "Kernel boot sequence initialized drivers and mounted the "
            "root filesystem."),
    ]


class TestSearch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.idx = BM25Index(Path(self.tmp.name) / "index.json")
        for r in sample_records():
            self.idx.add(r)

    def test_relevance_ordering(self):
        results = self.idx.search("token budget")
        self.assertTrue(results, "expected at least one hit")
        top_score, top_rec = results[0]
        self.assertEqual(top_rec["id"], "aaa1")
        self.assertGreater(top_score, 0.0)
        # No other result outranks the budget record.
        for score, r in results[1:]:
            self.assertLessEqual(score, top_score)
            self.assertNotEqual(r["id"], "aaa1")

    def test_search_k_limit(self):
        results = self.idx.search("budget worktree whale kernel", k=2)
        self.assertLessEqual(len(results), 2)

    def test_no_match_returns_empty(self):
        self.assertEqual(self.idx.search("zzzznonexistentterm"), [])

    def test_empty_index_search(self):
        empty = BM25Index(Path(self.tmp.name) / "other.json")
        self.assertEqual(empty.search("token budget"), [])

    def test_readd_same_id_replaces(self):
        n = len(self.idx)
        self.idx.add(sample_records()[0])
        self.assertEqual(len(self.idx), n)


class TestPersistence(unittest.TestCase):
    def test_save_load_roundtrip_preserves_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "index.json"
            idx = BM25Index(path)
            for r in sample_records():
                idx.add(r)
            before = idx.search("token budget", k=5)
            idx.save()
            self.assertTrue(path.exists())

            idx2 = BM25Index(path)
            after = idx2.search("token budget", k=5)
            self.assertEqual(len(before), len(after))
            for (s1, r1), (s2, r2) in zip(before, after):
                self.assertAlmostEqual(s1, s2, places=12)
                self.assertEqual(r1, r2)

    def test_load_missing_file_starts_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx = BM25Index(Path(tmp) / "nope" / "index.json")
            self.assertEqual(len(idx), 0)
            idx.add(sample_records()[0])
            idx.save()  # creates parent dir
            self.assertEqual(len(BM25Index(Path(tmp) / "nope" / "index.json")), 1)


class TestToc(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.idx = BM25Index(Path(self.tmp.name) / "index.json")
        for r in sample_records():
            self.idx.add(r)

    def test_grouping_counts(self):
        entries = self.idx.toc()
        by_source = {e["source"]: e for e in entries}
        self.assertEqual(set(by_source), {"forge.md", "moby.txt", "kernel.log"})
        self.assertEqual(by_source["forge.md"]["n_sections"], 2)
        self.assertEqual(by_source["moby.txt"]["n_sections"], 1)
        self.assertEqual(by_source["kernel.log"]["n_sections"], 1)
        # sorted by n_sections desc: forge.md first
        self.assertEqual(entries[0]["source"], "forge.md")
        self.assertEqual(sorted(by_source["forge.md"]["section_ids"]),
                         ["aaa1", "bbb2"])
        self.assertEqual(by_source["forge.md"]["kind"], "docs")

    def test_top_keywords_capped_at_six(self):
        entries = self.idx.toc()
        for e in entries:
            self.assertLessEqual(len(e["top_keywords"]), 6)
        forge = next(e for e in entries if e["source"] == "forge.md")
        # 9 distinct keywords across the two forge.md sections -> capped
        self.assertEqual(len(forge["top_keywords"]), 6)

    def test_truncation_to_max_entries(self):
        entries = self.idx.toc(max_entries=2)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["source"], "forge.md")

    def test_empty_index_toc(self):
        empty = BM25Index(Path(self.tmp.name) / "other.json")
        self.assertEqual(empty.toc(), [])


if __name__ == "__main__":
    unittest.main()
