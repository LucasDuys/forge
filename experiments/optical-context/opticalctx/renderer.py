"""Render packed section streams into content-addressed PNG pages.

Ported/extended from ../render.py. Design rationale: SCALE.md §2 and
REPORT.md §2 — Claude image cost is patch-based (ceil(w/28)*ceil(h/28)),
so a 1092x1092 page costs 1521 tokens on every tier undistorted; text is
supersampled and Lanczos-downscaled for clean OCR-able glyph edges; pages
are a *view* over canonical text (content-addressed, immutable), never a
store.

Stream layout: each section contributes f' @[{section_id}]@ ' followed by
its asciified+packed text; pages are greedy fixed-capacity (cols*rows
chars) slices of that stream. char_start/char_end in the per-page
`sections` list are offsets into that page's slice of the stream
(i.e. into PageResult.rendered_text), clipped to the page.
"""

import hashlib
import json
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .constants import DEJAVU_MONO, RENDERER_VERSION, image_tokens
from .transforms import asciify, pack


@dataclass
class RenderConfig:
    font_path: str = DEJAVU_MONO
    font_px: int = 11
    page_w: int = 1092
    page_h: int = 1092
    margin: int = 12
    line_spacing: int = 2
    supersample: int = 4


@dataclass
class PageResult:
    page_id: str
    png_path: str
    manifest_path: str
    sections: list[dict] = field(default_factory=list)
    chars: int = 0
    image_tokens: int = 0
    rendered_text: str = ""


def _load_font(cfg: RenderConfig) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(cfg.font_path, cfg.font_px * cfg.supersample)


def _measure(font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    """(char_width, line_height) for a monospace font — same math as
    ../render.py so PIL pixel metrics match the prototype exactly."""
    bbox = font.getbbox("M")
    ascent, descent = font.getmetrics()
    return bbox[2] - bbox[0], ascent + descent


def page_geometry(cfg: RenderConfig) -> tuple[int, int]:
    """(cols, rows) of monospace character cells per page for a config."""
    ss = cfg.supersample
    font = _load_font(cfg)
    cw, lh = _measure(font)
    lh += cfg.line_spacing * ss
    cols = (cfg.page_w * ss - 2 * cfg.margin * ss) // cw
    rows = (cfg.page_h * ss - 2 * cfg.margin * ss) // lh
    if cols < 10 or rows < 3:
        raise ValueError(
            f"font_px={cfg.font_px} too large for page {cfg.page_w}x{cfg.page_h}")
    return int(cols), int(rows)


def _section_separator(section_id: str) -> str:
    return f" @[{section_id}]@ "


def build_stream(sections: list[tuple[str, str]]) -> tuple[str, list[tuple[str, int, int]]]:
    """asciify+pack each section and join into one stream, each section's
    content preceded by its separator. Returns (stream, spans) where spans
    are (section_id, content_start, content_end) in global stream offsets
    (content only — separators excluded)."""
    parts: list[str] = []
    spans: list[tuple[str, int, int]] = []
    pos = 0
    for section_id, text in sections:
        sep = _section_separator(section_id)
        packed = pack(asciify(text))
        parts.append(sep)
        pos += len(sep)
        spans.append((section_id, pos, pos + len(packed)))
        parts.append(packed)
        pos += len(packed)
    return "".join(parts), spans


def _render_page_image(lines: list[str], cfg: RenderConfig) -> Image.Image:
    """Draw lines at supersample scale, Lanczos-downscale to page size —
    exactly the ../render.py pipeline for clean glyph edges."""
    ss = cfg.supersample
    font = _load_font(cfg)
    _, lh = _measure(font)
    lh += cfg.line_spacing * ss
    img = Image.new("L", (cfg.page_w * ss, cfg.page_h * ss), 255)
    draw = ImageDraw.Draw(img)
    y = cfg.margin * ss
    for line in lines:
        if line:
            draw.text((cfg.margin * ss, y), line, font=font, fill=0)
        y += lh
    return img.resize((cfg.page_w, cfg.page_h), Image.LANCZOS)


def _page_id(stream_slice: str, cfg: RenderConfig) -> str:
    key = (f"{RENDERER_VERSION}|{cfg.font_px}|{cfg.page_w}x{cfg.page_h}|"
           + stream_slice)
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def render_batch(sections: list[tuple[str, str]], out_dir: str | Path,
                 cfg: RenderConfig, kind: str = "prose") -> list[PageResult]:
    """Render (section_id, canonical_text) pairs into content-addressed
    PNG pages + manifests under out_dir. Deterministic: same input + cfg
    => byte-identical PNGs and identical page_ids. A section may span
    pages; its per-page char_start/char_end are offsets into that page's
    stream slice (PageResult.rendered_text)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cols, rows = page_geometry(cfg)
    capacity = cols * rows
    stream, spans = build_stream(sections)

    results: list[PageResult] = []
    for page_start in range(0, len(stream), capacity):
        page_slice = stream[page_start:page_start + capacity]
        page_end = page_start + len(page_slice)
        lines = [page_slice[i:i + cols] for i in range(0, len(page_slice), cols)]
        page_id = _page_id(page_slice, cfg)

        img = _render_page_image(lines, cfg)
        png_path = out_dir / f"{page_id}.png"
        img.save(png_path)

        page_sections = []
        for section_id, s, e in spans:
            if s < page_end and e > page_start:
                page_sections.append({
                    "id": section_id,
                    "char_start": max(s, page_start) - page_start,
                    "char_end": min(e, page_end) - page_start,
                })

        manifest = {
            "page_id": page_id,
            "renderer_version": RENDERER_VERSION,
            "font_px": cfg.font_px,
            "page_w": cfg.page_w,
            "page_h": cfg.page_h,
            "kind": kind,
            "sections": page_sections,
            "chars": len(page_slice),
            "image_tokens": image_tokens(cfg.page_w, cfg.page_h),
            "cert": None,
            "line_crc32": [zlib.crc32(line.encode()) for line in lines],
        }
        manifest_path = out_dir / f"{page_id}.json"
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        results.append(PageResult(
            page_id=page_id,
            png_path=str(png_path),
            manifest_path=str(manifest_path),
            sections=page_sections,
            chars=len(page_slice),
            image_tokens=manifest["image_tokens"],
            rendered_text=page_slice,
        ))
    return results
