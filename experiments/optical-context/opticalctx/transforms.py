"""Deterministic text transforms applied before optical rendering.

Ported from ../translate.py (normalize/terse substitution tables) and
../render.py (pack/unpack/asciify). Design rationale: REPORT.md §3 and
SCALE.md §2 — packing reflows text into a continuous stream so every
rendered row is full (otherwise list-heavy text wastes rows and pages
cost MORE tokens than raw text); asciify keeps glyphs OCR-unambiguous;
terse is a lossy but meaning-preserving shrink (caveman-style), never
for source code or anything requiring verbatim recovery.

All transforms are pure and deterministic: same input -> same output.
"""

import re

# Reversible newline marker used by pack(). Chosen to be OCR-unambiguous
# ASCII and vanishingly rare in real text.
NL_MARK = " @@ "

ASCII_MAP = {"├": "|-", "└": "`-", "─": "-", "│": "|", "→": "->", "←": "<-",
             "✓": "[x]", "✗": "[ ]", "—": "--", "–": "-", "…": "...",
             "“": '"', "”": '"', "‘": "'", "’": "'",
             "•": "*", "≈": "~=", "≥": ">=", "≤": "<="}

SUBSTITUTIONS = [
    (r"\bin order to\b", "to"),
    (r"\bis able to\b", "can"),
    (r"\bare able to\b", "can"),
    (r"\bit is important to note that\b", ""),
    (r"\bnote that\b", ""),
    (r"\bplease note\b", ""),
    (r"\bfor example\b", "e.g."),
    (r"\bfor instance\b", "e.g."),
    (r"\bthat is\b", "i.e."),
    (r"\bin the event that\b", "if"),
    (r"\bat this point in time\b", "now"),
    (r"\bcurrently\b", "now"),
    (r"\bapproximately\b", "~"),
    (r"\bconfiguration\b", "config"),
    (r"\bimplementation\b", "impl"),
    (r"\bdocumentation\b", "docs"),
    (r"\brepository\b", "repo"),
    (r"\benvironment\b", "env"),
    (r"\bdirectory\b", "dir"),
    (r"\bfunction\b", "fn"),
    (r"\bnumber of\b", "#"),
    (r"\bin addition\b", "also"),
    (r"\bhowever\b", "but"),
    (r"\btherefore\b", "so"),
    (r"\bwhether or not\b", "whether"),
    (r"\bas well as\b", "and"),
    (r"\bmake sure\b", "ensure"),
    (r"\bthe following\b", "these"),
]


def normalize(text: str) -> str:
    """Lossless-ish cleanup: strip trailing whitespace per line, collapse
    runs of 3+ blank lines, collapse 3+ terminal-punctuation runs."""
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"([.!?]){3,}", r"\1", text)
    return text


def terse(text: str) -> str:
    """Lossy but meaning-preserving shrink via a fixed substitution table.
    NOT for source code, specs, or anything requiring verbatim recovery."""
    text = normalize(text)
    for pat, rep in SUBSTITUTIONS:
        text = re.sub(pat, rep, text, flags=re.I)
    text = re.sub(r"  +", " ", text)
    text = re.sub(r" ([,.;:])", r"\1", text)
    return text


def asciify(text: str) -> str:
    """Deterministically transliterate non-ASCII to OCR-safe ASCII;
    anything unmapped becomes '?' (errors='replace')."""
    for k, v in ASCII_MAP.items():
        text = text.replace(k, v)
    return text.encode("ascii", "replace").decode()


def pack(text: str) -> str:
    """Reflow text into a continuous stream so every rendered row is full.

    Trailing spaces/tabs before newlines are stripped (they carry no
    information and break reversibility), then newlines become NL_MARK.
    Reversible via unpack() for text without trailing whitespace and
    without literal NL_MARK occurrences.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.replace("\n", NL_MARK)


def unpack(text: str) -> str:
    return text.replace(NL_MARK, "\n")
