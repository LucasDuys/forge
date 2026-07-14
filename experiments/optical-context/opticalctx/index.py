"""BM25 index over section metadata — the searchable "table of contents".

Design per ../SCALE.md / ../REPORT.md: the full-fidelity content lives in
rendered page images (or canonical text on disk); this small index of
title + keywords + gist per section is what an agent keeps in context or
queries. BM25 (k1=1.5, b=0.75) with the same tokenizer/stopwords as
../sectionize.py is the zero-dependency retrieval baseline; embeddings can
replace it later if recall proves insufficient.

Persistence: raw section records are stored in index.json; postings are
rebuilt on load (index is tiny — a few hundred bytes per section).
"""

import json
import math
import re
from collections import Counter
from pathlib import Path

# Same tokenizer + stopwords as ../sectionize.py (kept local so this module
# does not depend on sectionizer internals).
STOPWORDS = set("""a an and are as at be by for from has have if in into is it
its of on or that the this to was were will with we you your not no can via
each which when what how all any been than then them they i""".split())

TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_\-]{1,}")

K1 = 1.5
B = 0.75


def _terms(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text)
            if t.lower() not in STOPWORDS]


def _doc_terms(record: dict) -> list[str]:
    parts = [record.get("title", ""),
             " ".join(record.get("keywords", []) or []),
             record.get("gist", "")]
    return _terms(" ".join(parts))


class BM25Index:
    """BM25 over section records' title + keywords + gist terms."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._records: list[dict] = []
        self._by_id: dict[str, int] = {}
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for rec in data.get("records", []):
                self.add(rec)

    def add(self, record: dict) -> None:
        """Add a section record. Re-adding the same section id replaces it."""
        rid = record.get("id")
        if rid is not None and rid in self._by_id:
            self._records[self._by_id[rid]] = dict(record)
            return
        if rid is not None:
            self._by_id[rid] = len(self._records)
        self._records.append(dict(record))

    def __len__(self) -> int:
        return len(self._records)

    def search(self, query: str, k: int = 5) -> list[tuple[float, dict]]:
        docs = [(rec, _doc_terms(rec)) for rec in self._records]
        n = len(docs)
        if n == 0:
            return []
        avgdl = sum(len(d) for _, d in docs) / n
        df: Counter = Counter()
        for _, d in docs:
            df.update(set(d))
        q_terms = _terms(query)
        scored = []
        for rec, d in docs:
            tf = Counter(d)
            score = 0.0
            for q in q_terms:
                if q not in tf:
                    continue
                idf = math.log(1 + (n - df[q] + 0.5) / (df[q] + 0.5))
                denom = tf[q] + K1 * (1 - B + B * len(d) / max(avgdl, 1e-9))
                score += idf * tf[q] * (K1 + 1) / denom
            if score > 0:
                scored.append((score, rec))
        scored.sort(key=lambda x: -x[0])
        return scored[:k]

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps({"records": self._records}),
                       encoding="utf-8")
        tmp.replace(self.path)

    def toc(self, max_entries: int = 100) -> list[dict]:
        """Two-level table of contents: sections grouped by source.

        Per source: {'source', 'kind', 'n_sections', 'top_keywords' (<=6,
        aggregated term frequency over the group's keyword lists),
        'section_ids'}; sorted by n_sections desc, truncated to max_entries.
        """
        groups: dict[str, list[dict]] = {}
        for rec in self._records:
            groups.setdefault(rec.get("source", ""), []).append(rec)
        entries = []
        for source, recs in groups.items():
            kw: Counter = Counter()
            for rec in recs:
                kw.update(rec.get("keywords", []) or [])
            entries.append({
                "source": source,
                "kind": recs[0].get("kind", "prose"),
                "n_sections": len(recs),
                "top_keywords": [w for w, _ in kw.most_common(6)],
                "section_ids": [rec.get("id") for rec in recs],
            })
        entries.sort(key=lambda e: -e["n_sections"])
        return entries[:max_entries]
