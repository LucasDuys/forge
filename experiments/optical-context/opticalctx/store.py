"""Canonical section store: content-addressed text + append-only metadata.

Architecture rule #1 (SCALE.md §1, REPORT.md §2): pages are a view, not a
store. Canonical section text is the source of truth; this module owns it.
Sections are content-addressed (sha256(text)[:16]) so identical text is
stored exactly once, records live in an append-only ``sections.jsonl``
(compact-rewritten only by ``mark_paged``), and an access-count ledger
(``ledger.json``) records per-section heat for window assembly.
"""

import hashlib
import json
from pathlib import Path


def _section_id(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class CanonicalStore:
    """Content-addressed store per CONTRACT.md §store.py."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.sections_dir = self.root / "sections"
        self.pages_dir = self.root / "pages"
        for d in (self.root, self.sections_dir, self.pages_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.jsonl_path = self.root / "sections.jsonl"
        self.ledger_path = self.root / "ledger.json"
        # id -> record; dict preserves first-insertion (jsonl) order and a
        # later duplicate line for the same id updates values in place.
        self._records: dict[str, dict] = {}
        self._load_records()

    # ------------------------------------------------------------- records

    def _load_records(self) -> None:
        self._records = {}
        if not self.jsonl_path.exists():
            return
        for line in self.jsonl_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec["id"] in self._records:
                self._records[rec["id"]].update(rec)  # last wins, keep order
            else:
                self._records[rec["id"]] = rec

    def _append_record(self, rec: dict) -> None:
        with self.jsonl_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _rewrite_records(self) -> None:
        tmp = self.jsonl_path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for rec in self._records.values():
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        tmp.replace(self.jsonl_path)

    # ----------------------------------------------------------------- api

    def put(self, text: str, *, source: str, kind: str, title: str,
            keywords: list[str], gist: str) -> str:
        """Write section text + jsonl record; idempotent by content hash."""
        sid = _section_id(text)
        if sid in self._records:
            return sid
        (self.sections_dir / f"{sid}.txt").write_text(text, encoding="utf-8")
        rec = {"id": sid, "source": source, "kind": kind, "title": title,
               "keywords": list(keywords), "gist": gist, "chars": len(text),
               "created": "", "page_id": None}
        self._records[sid] = rec
        self._append_record(rec)
        return sid

    def get(self, section_id: str) -> str:
        path = self.sections_dir / f"{section_id}.txt"
        if not path.exists():
            raise KeyError(section_id)
        return path.read_text(encoding="utf-8")

    def meta(self, section_id: str) -> dict:
        if section_id not in self._records:
            raise KeyError(section_id)
        return dict(self._records[section_id])

    def all_meta(self) -> list[dict]:
        return [dict(rec) for rec in self._records.values()]

    def unpaged(self, kind: str | None = None) -> list[dict]:
        return [dict(rec) for rec in self._records.values()
                if rec["page_id"] is None
                and (kind is None or rec["kind"] == kind)]

    def mark_paged(self, section_ids: list[str], page_id: str) -> None:
        for sid in section_ids:
            if sid not in self._records:
                raise KeyError(sid)
        for sid in section_ids:
            self._records[sid]["page_id"] = page_id
        self._rewrite_records()

    # -------------------------------------------------------------- ledger

    def _read_ledger(self) -> dict:
        if not self.ledger_path.exists():
            return {}
        return json.loads(self.ledger_path.read_text(encoding="utf-8"))

    def touch(self, section_id: str) -> None:
        ledger = self._read_ledger()
        ledger[section_id] = ledger.get(section_id, 0) + 1
        self.ledger_path.write_text(
            json.dumps(ledger, ensure_ascii=False), encoding="utf-8")

    def heat(self, section_id: str) -> int:
        return self._read_ledger().get(section_id, 0)
