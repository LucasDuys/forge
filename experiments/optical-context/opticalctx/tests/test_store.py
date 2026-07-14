"""Tests for opticalctx.store.CanonicalStore (CONTRACT.md §store.py)."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from ..store import CanonicalStore


def _put(store, text, **overrides):
    kwargs = {"source": "src.txt", "kind": "prose", "title": "T",
              "keywords": ["k"], "gist": "g"}
    kwargs.update(overrides)
    return store.put(text, **kwargs)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / ".opticalctx"
        self.store = CanonicalStore(self.root)

    def test_init_creates_dirs(self):
        self.assertTrue((self.root / "sections").is_dir())
        self.assertTrue((self.root / "pages").is_dir())

    def test_put_content_addressed_id(self):
        text = "hello canonical world"
        sid = _put(self.store, text)
        self.assertEqual(sid, hashlib.sha256(text.encode()).hexdigest()[:16])
        self.assertEqual(
            (self.root / "sections" / f"{sid}.txt").read_text(), text)

    def test_put_idempotent(self):
        sid1 = _put(self.store, "same text")
        sid2 = _put(self.store, "same text", title="different meta")
        self.assertEqual(sid1, sid2)
        lines = [l for l in (self.root / "sections.jsonl")
                 .read_text().splitlines() if l.strip()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(len(self.store.all_meta()), 1)

    def test_record_fields(self):
        sid = _put(self.store, "abc", source="moby.txt", kind="prose",
                   title="Ch 1", keywords=["whale"], gist="Call me")
        rec = self.store.meta(sid)
        self.assertEqual(rec, {"id": sid, "source": "moby.txt",
                               "kind": "prose", "title": "Ch 1",
                               "keywords": ["whale"], "gist": "Call me",
                               "chars": 3, "created": "", "page_id": None})

    def test_get_roundtrip_and_keyerror(self):
        sid = _put(self.store, "round trip étext\n")
        self.assertEqual(self.store.get(sid), "round trip étext\n")
        with self.assertRaises(KeyError):
            self.store.get("deadbeefdeadbeef")
        with self.assertRaises(KeyError):
            self.store.meta("deadbeefdeadbeef")

    def test_all_meta_jsonl_order(self):
        ids = [_put(self.store, f"text number {i}") for i in range(5)]
        self.assertEqual([r["id"] for r in self.store.all_meta()], ids)

    def test_unpaged_filtering(self):
        a = _put(self.store, "prose one", kind="prose")
        b = _put(self.store, "code one", kind="code")
        c = _put(self.store, "prose two", kind="prose")
        self.store.mark_paged([a], "page01")
        unpaged = self.store.unpaged()
        self.assertEqual({r["id"] for r in unpaged}, {b, c})
        unpaged_code = self.store.unpaged(kind="code")
        self.assertEqual([r["id"] for r in unpaged_code], [b])
        self.assertEqual(self.store.unpaged(kind="log"), [])

    def test_mark_paged_updates_and_persists(self):
        a = _put(self.store, "aaa")
        b = _put(self.store, "bbb")
        self.store.mark_paged([a, b], "pg42")
        self.assertEqual(self.store.meta(a)["page_id"], "pg42")
        self.assertEqual(self.store.meta(b)["page_id"], "pg42")
        # compact rewrite: one line per section, reload sees the update
        lines = [json.loads(l) for l in (self.root / "sections.jsonl")
                 .read_text().splitlines() if l.strip()]
        self.assertEqual(len(lines), 2)
        fresh = CanonicalStore(self.root)
        self.assertEqual(fresh.meta(a)["page_id"], "pg42")
        self.assertEqual(fresh.unpaged(), [])

    def test_mark_paged_unknown_id_raises(self):
        with self.assertRaises(KeyError):
            self.store.mark_paged(["deadbeefdeadbeef"], "pg1")

    def test_put_after_mark_paged_appends(self):
        a = _put(self.store, "first")
        self.store.mark_paged([a], "pg1")
        b = _put(self.store, "second")
        fresh = CanonicalStore(self.root)
        self.assertEqual([r["id"] for r in fresh.all_meta()], [a, b])
        self.assertEqual(fresh.meta(a)["page_id"], "pg1")
        self.assertIsNone(fresh.meta(b)["page_id"])

    def test_ledger_touch_heat(self):
        sid = _put(self.store, "hot section")
        self.assertEqual(self.store.heat(sid), 0)
        self.assertEqual(self.store.heat("neverseen"), 0)
        self.store.touch(sid)
        self.store.touch(sid)
        self.assertEqual(self.store.heat(sid), 2)
        # persisted to ledger.json, visible from a fresh instance
        fresh = CanonicalStore(self.root)
        self.assertEqual(fresh.heat(sid), 2)
        self.assertEqual(
            json.loads((self.root / "ledger.json").read_text()), {sid: 2})


if __name__ == "__main__":
    unittest.main()
