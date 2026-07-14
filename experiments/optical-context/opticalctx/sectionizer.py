"""Deterministic text sectionizer + cheap metadata extraction.

Ported from ../sectionize.py (see REPORT.md §4: the section index is the
tiny searchable layer an agent keeps in context; full fidelity lives in
canonical text / rendered pages). Splitting is pure and deterministic —
markdown headings when a document has >=2, top-level def/class boundaries
for code, blank-line paragraph blocks merged up to ``max_chars`` otherwise.
Invariant: every character of the input lands in exactly one section, so
``"".join(s for _, s in split(text)) == text``.
"""

import re
from collections import Counter

# Same tokenizer as ../sectionize.py (shared with index.py per CONTRACT.md).
STOPWORDS = set("""a an and are as at be by for from has have if in into is it
its of on or that the this to was were will with we you your not no can via
each which when what how all any been than then them they i""".split())

TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_\-]{1,}")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.M)
# Top-level only: '^' + no leading whitespace means column 0.
CODE_BOUNDARY_RE = re.compile(r"^(?:async[ \t]+def|def|class)\b", re.M)
PARA_BREAK_RE = re.compile(r"\n\s*\n")
_WS_RE = re.compile(r"\s+")


def _terms(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text)
            if t.lower() not in STOPWORDS]


def _sections_from_marks(text: str, marks: list[tuple[int, str]]
                         ) -> list[tuple[str, str]]:
    """marks = [(char_pos, title)] sorted ascending; partition the text."""
    out: list[tuple[str, str]] = []
    if marks[0][0] > 0:
        out.append(("(preamble)", text[:marks[0][0]]))
    bounds = [pos for pos, _ in marks] + [len(text)]
    for i, (pos, title) in enumerate(marks):
        out.append((title, text[pos:bounds[i + 1]]))
    return out


def _split_code(text: str) -> list[tuple[str, str]]:
    marks = []
    for m in CODE_BOUNDARY_RE.finditer(text):
        nl = text.find("\n", m.start())
        first_line = text[m.start(): nl if nl != -1 else len(text)]
        marks.append((m.start(), first_line.strip()[:60]))
    if not marks:
        stripped = text.strip()
        title = stripped.split("\n")[0][:60] if stripped else "(code)"
        return [(title, text)]
    return _sections_from_marks(text, marks)


def _split_paragraphs(text: str, max_chars: int) -> list[tuple[str, str]]:
    breaks = [m.end() for m in PARA_BREAK_RE.finditer(text)]
    spans, prev = [], 0
    for b in breaks:
        spans.append((prev, b))
        prev = b
    if prev < len(text):
        spans.append((prev, len(text)))
    sections: list[tuple[str, str]] = []
    start, title = 0, None
    for a, b in spans:
        if title is None:
            stripped = text[a:b].strip()
            if stripped:
                title = stripped.split("\n")[0][:60]
        if b - start >= max_chars:
            sections.append((title or "(section)", text[start:b]))
            start, title = b, None
    if start < len(text):
        sections.append((title or "(section)", text[start:]))
    return sections


def split(text: str, kind: str = "prose",
          max_chars: int = 4000) -> list[tuple[str, str]]:
    """Deterministic split into [(title, section_text)]; lossless partition."""
    if not text:
        return []
    if kind == "code":
        # Skip heading detection for code: '# comment' lines would false-
        # positive as markdown headings.
        return _split_code(text)
    heads = [(m.start(), m.group(2).strip())
             for m in HEADING_RE.finditer(text)]
    if len(heads) >= 2:
        return _sections_from_marks(text, heads)
    return _split_paragraphs(text, max_chars)


def extract_meta(title: str, text: str) -> dict:
    """Keywords (<=8 stopword-filtered TF terms over the body, matching the
    ../sectionize.py prototype) + gist (first 160 chars, whitespace
    normalized)."""
    keywords = [w for w, _ in Counter(_terms(text)).most_common(8)]
    gist = _WS_RE.sub(" ", text.strip())[:160]
    return {"keywords": keywords, "gist": gist}
