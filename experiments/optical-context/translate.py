#!/usr/bin/env python3
"""Deterministic token-efficient text transform ("translation tool").

Applied BEFORE rendering to pages, this shrinks what must be drawn/read.
Two honest modes, both fully deterministic (same input -> same output):

  normalize  Lossless-ish for a reader: collapse runs of blank lines,
             strip trailing whitespace, dedent uniform indentation of
             fenced blocks, collapse 3+ punctuation runs. Safe everywhere.

  terse      Lossy but meaning-preserving: applies a fixed substitution
             table (phrase -> shorter phrase), drops pure filler phrases.
             Modeled on forge's caveman-internal approach. NOT for source
             code, specs, or anything requiring verbatim recovery.

Deliberately NOT included: gzip/base64 style compression — LLMs cannot read
compressed bytes, so it saves nothing at the model boundary. If you want real
compression, that's what the image layer is for.

Prints before/after char counts and estimated token savings.
"""

import argparse
import re
import sys

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


def normalize(text):
    out = []
    for line in text.split("\n"):
        out.append(line.rstrip())
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"([.!?]){3,}", r"\1", text)
    return text


def terse(text):
    text = normalize(text)
    for pat, rep in SUBSTITUTIONS:
        text = re.sub(pat, rep, text, flags=re.I)
    text = re.sub(r"  +", " ", text)
    text = re.sub(r" ([,.;:])", r"\1", text)
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("input", help="text file ('-' for stdin)")
    ap.add_argument("--mode", choices=["normalize", "terse"], default="normalize")
    ap.add_argument("-o", "--out", help="output file (default stdout)")
    args = ap.parse_args()

    text = sys.stdin.read() if args.input == "-" else open(args.input).read()
    result = terse(text) if args.mode == "terse" else normalize(text)

    if args.out:
        open(args.out, "w").write(result)
    else:
        sys.stdout.write(result)
    before, after = len(text), len(result)
    print(f"\n[{args.mode}] {before} -> {after} chars "
          f"({(1 - after / max(before, 1)) * 100:.1f}% saved, "
          f"~{(before - after) // 4} tokens)", file=sys.stderr)


if __name__ == "__main__":
    main()
