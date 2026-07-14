"""Shared constants: Claude vision token math, model tiers, pricing.

Sources (verified 2026-07-14, see ../RESEARCH.md §3 and ../SCALE.md §2):
- platform.claude.com/docs/en/build-with-claude/vision — patch formula
  ceil(w/28)*ceil(h/28), tier table (high-res: 2576px/4784 tok; standard:
  1568px/1568 tok), downscale-when-over-limit behavior, 100 images per
  request on 200k-context models, >20 images => 2000px per-image cap.
- claude.com/pricing — per-MTok input/output prices.
- Cache multipliers: reads ~0.1x, 5-min writes 1.25x (Anthropic docs).
"""

import math

RENDERER_VERSION = "r1"
DEJAVU_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

# chars per text token by content kind (REPORT.md §3; English prose ~4,
# code ~3.5, logs are repetitive/structured ~3.8, docs between)
CHARS_PER_TOKEN = {"prose": 4.0, "code": 3.5, "log": 3.8, "docs": 3.9}

# model -> (tier, usd_per_mtok_in, usd_per_mtok_out)
MODELS = {
    "sonnet-5":  ("high", 3.0, 15.0),
    "opus-4.8":  ("high", 5.0, 25.0),
    "haiku-4.5": ("standard", 1.0, 5.0),
}

# tier -> (max_long_edge_px, max_visual_tokens)
TIERS = {"high": (2576, 4784), "standard": (1568, 1568)}

CACHE_READ_MULT = 0.1
CACHE_WRITE_MULT = 1.25

MANY_IMAGE_THRESHOLD = 20      # >20 images => per-image cap below
MANY_IMAGE_MAX_EDGE = 2000
MAX_IMAGES_PER_REQUEST_200K = 100


def image_tokens(w: int, h: int) -> int:
    """Visual tokens for an image at its delivered size (patch formula)."""
    return math.ceil(w / 28) * math.ceil(h / 28)


def downscaled_dims(w: int, h: int, tier: str) -> tuple[int, int]:
    """Dimensions after the API's silent downscale for a tier: scale to
    fit the long-edge limit AND the visual-token limit, preserving aspect
    ratio. Returns (w, h) unchanged if already within both."""
    max_edge, max_tokens = TIERS[tier]
    scale = 1.0
    long_edge = max(w, h)
    if long_edge > max_edge:
        scale = max_edge / long_edge
    while image_tokens(max(1, int(w * scale)), max(1, int(h * scale))) > max_tokens:
        scale *= 0.99
    return max(1, int(w * scale)), max(1, int(h * scale))


def text_tokens_est(chars: int, kind: str = "prose") -> int:
    return round(chars / CHARS_PER_TOKEN.get(kind, 4.0))
