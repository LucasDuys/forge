"""Token accounting and cost simulation for optical vs text context.

All 'measurement' in local-only mode is arithmetic over verified constants
(constants.py); this module is the single place that arithmetic lives.
Design: SCALE.md §2 (window math, cache stacking), RESEARCH.md §3.
"""

from dataclasses import dataclass, field

from .constants import (CACHE_READ_MULT, CACHE_WRITE_MULT, MODELS,
                        downscaled_dims, image_tokens, text_tokens_est)


def tokens_for_model(model: str, w: int, h: int) -> int:
    """Visual tokens a page actually costs on a model, after any silent
    downscale for that model's tier."""
    tier = MODELS[model][0]
    dw, dh = downscaled_dims(w, h, tier)
    return image_tokens(dw, dh)


def usd(model: str, tokens: int, *, out: bool = False,
        cache_read: bool = False, cache_write: bool = False) -> float:
    _, pin, pout = MODELS[model]
    rate = pout if out else pin
    if cache_read:
        rate = pin * CACHE_READ_MULT
    elif cache_write:
        rate = pin * CACHE_WRITE_MULT
    return tokens * rate / 1_000_000


@dataclass
class WindowStats:
    model: str
    real_tokens: int = 0            # what the window actually costs
    text_equiv_tokens: int = 0      # what the same content would cost as text
    chars_carried: int = 0
    n_pages: int = 0
    n_text_sections: int = 0
    first_turn_usd: float = 0.0     # uncached input cost
    cached_turn_usd: float = 0.0    # steady-state (whole window cache-read)

    @property
    def effective_ratio(self) -> float:
        return self.text_equiv_tokens / self.real_tokens if self.real_tokens else 0.0

    def finalize(self) -> "WindowStats":
        self.first_turn_usd = usd(self.model, self.real_tokens)
        self.cached_turn_usd = usd(self.model, self.real_tokens, cache_read=True)
        return self


@dataclass
class SessionProfile:
    """A simulated agent session for cost comparison."""
    turns: int = 40
    window_tokens: int = 150_000     # context carried per turn
    fresh_tokens_per_turn: int = 3_000   # new uncached input each turn
    output_tokens_per_turn: int = 800
    cache_enabled: bool = True


def session_cost(model: str, profile: SessionProfile,
                 effective_ratio: float = 1.0) -> dict:
    """USD for a whole session. effective_ratio compresses the carried
    window (optical backend); 1.0 = plain text baseline. With caching,
    the carried window is written once (1.25x) and read (0.1x) on every
    subsequent turn; without, it is paid full price every turn."""
    carried = round(profile.window_tokens / effective_ratio)
    fresh_total = profile.fresh_tokens_per_turn * profile.turns
    out_total = profile.output_tokens_per_turn * profile.turns
    if profile.cache_enabled:
        window_cost = (usd(model, carried, cache_write=True)
                       + usd(model, carried, cache_read=True) * (profile.turns - 1))
    else:
        window_cost = usd(model, carried) * profile.turns
    total = (window_cost + usd(model, fresh_total)
             + usd(model, out_total, out=True))
    return {"model": model, "carried_tokens_per_turn": carried,
            "window_usd": round(window_cost, 4),
            "fresh_usd": round(usd(model, fresh_total), 4),
            "output_usd": round(usd(model, out_total, out=True), 4),
            "total_usd": round(total, 4)}
