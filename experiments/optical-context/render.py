#!/usr/bin/env python3
"""Render text into OCR-readable PNG 'pages' for optical context compression.

Pages default to 1072x1072 px. This is deliberate: the Claude API downscales
any image over ~1.15 megapixels (and over 1568px on the long edge), so a page
rendered larger than that arrives at the model smaller than you drew it and
readability silently degrades. 1072x1072 = 1.149 MP = the largest square page
that reaches the model at full resolution, costing (1072*1072)/750 ~= 1533
image tokens.

Text is rendered at SUPERSAMPLE x the target size and downscaled with Lanczos,
which gives cleaner glyph edges than direct small-size rendering.

Outputs: page-NNN.png files plus manifest.json describing exactly which
character range of the source landed on which page (needed by the indexer).
"""

import argparse
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
SUPERSAMPLE = 4

# Reversible newline marker used by --pack. Chosen to be OCR-unambiguous
# ASCII and vanishingly rare in real text.
NL_MARK = " @@ "


def pack_text(text):
    """Reflow text into a continuous stream so every rendered row is full.

    Newlines become NL_MARK (reversible via unpack_text). Without this,
    list-heavy markdown wastes most of each row and images cost MORE
    tokens than the raw text.
    """
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.replace("\n", NL_MARK)


def unpack_text(text):
    return text.replace(NL_MARK, "\n")


ASCII_MAP = {"├": "|-", "└": "`-", "─": "-", "│": "|", "→": "->", "←": "<-",
             "✓": "[x]", "✗": "[ ]", "—": "--", "–": "-", "…": "...",
             "“": '"', "”": '"', "‘": "'", "’": "'", "•": "*", "≈": "~=",
             "≥": ">=", "≤": "<="}


def asciify(text):
    """Deterministically transliterate non-ASCII to OCR-safe ASCII."""
    for k, v in ASCII_MAP.items():
        text = text.replace(k, v)
    return text.encode("ascii", "replace").decode()


def load_font(path, px):
    return ImageFont.truetype(path, px)


def measure(font):
    """Return (char_width, line_height) for a monospace font."""
    bbox = font.getbbox("M")
    ascent, descent = font.getmetrics()
    return bbox[2] - bbox[0], ascent + descent


def wrap_text(text, cols):
    """Hard-wrap preserving existing newlines. Returns list of (line, char_start)."""
    lines = []
    pos = 0
    for raw in text.split("\n"):
        if raw == "":
            lines.append(("", pos))
        start = 0
        while start < len(raw):
            lines.append((raw[start:start + cols], pos + start))
            start += cols
        pos += len(raw) + 1  # +1 for the newline
    return lines


def render_pages(text, out_dir, font_path=DEFAULT_FONT, font_px=11,
                 page_w=1072, page_h=1072, margin=12, line_spacing=2,
                 pack=False, ascii_safe=False):
    if ascii_safe:
        text = asciify(text)
    if pack:
        text = pack_text(text)
    os.makedirs(out_dir, exist_ok=True)
    ss = SUPERSAMPLE
    font = load_font(font_path, font_px * ss)
    cw, lh = measure(font)
    lh += line_spacing * ss

    cols = (page_w * ss - 2 * margin * ss) // cw
    rows = (page_h * ss - 2 * margin * ss) // lh
    if cols < 10 or rows < 3:
        raise SystemExit(f"font_px={font_px} too large for page {page_w}x{page_h}")

    lines = wrap_text(text, cols)
    pages = []
    for i in range(0, len(lines), rows):
        chunk = lines[i:i + rows]
        img = Image.new("L", (page_w * ss, page_h * ss), 255)
        draw = ImageDraw.Draw(img)
        y = margin * ss
        for line, _ in chunk:
            if line:
                draw.text((margin * ss, y), line, font=font, fill=0)
            y += lh
        img = img.resize((page_w, page_h), Image.LANCZOS)
        n = len(pages)
        fname = f"page-{n:03d}.png"
        img.save(os.path.join(out_dir, fname))
        char_start = chunk[0][1]
        last_line, last_start = chunk[-1]
        pages.append({
            "file": fname,
            "page": n,
            "char_start": char_start,
            "char_end": last_start + len(last_line),
            "lines": len(chunk),
        })

    # Ground truth for OCR checks is the text as actually rendered
    # (post pack/ascii transforms), so always persist it alongside pages.
    with open(os.path.join(out_dir, "rendered.txt"), "w") as f:
        f.write(text)

    manifest = {
        "font": font_path, "font_px": font_px,
        "pack": pack, "ascii": ascii_safe,
        "page_w": page_w, "page_h": page_h,
        "cols": int(cols), "rows_per_page": int(rows),
        "chars_capacity_per_page": int(cols * rows),
        "source_chars": len(text),
        "claude_image_tokens_per_page": round(page_w * page_h / 750),
        "pages": pages,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("input", help="text file to render ('-' for stdin)")
    ap.add_argument("-o", "--out", default="pages", help="output directory")
    ap.add_argument("--font-px", type=int, default=11)
    ap.add_argument("--font", default=DEFAULT_FONT)
    ap.add_argument("--page-w", type=int, default=1072)
    ap.add_argument("--page-h", type=int, default=1072)
    ap.add_argument("--pack", action="store_true",
                    help="reflow newlines to fill every row (reversible)")
    ap.add_argument("--ascii", action="store_true",
                    help="transliterate non-ASCII to OCR-safe ASCII")
    args = ap.parse_args()

    text = sys.stdin.read() if args.input == "-" else open(args.input).read()
    m = render_pages(text, args.out, font_path=args.font, font_px=args.font_px,
                     page_w=args.page_w, page_h=args.page_h,
                     pack=args.pack, ascii_safe=args.ascii)
    est_text_tokens = round(m["source_chars"] / 4)
    img_tokens = m["claude_image_tokens_per_page"] * len(m["pages"])
    print(f"{len(m['pages'])} page(s), {m['source_chars']} chars, "
          f"{m['cols']} cols x {m['rows_per_page']} rows @ {args.font_px}px")
    print(f"est. text tokens ~{est_text_tokens} vs image tokens {img_tokens} "
          f"(ratio {est_text_tokens / max(img_tokens, 1):.2f}x)")


if __name__ == "__main__":
    main()
