"""Context window assembly: TOC + hot text + certified pages + overflow text.

Design per ../SCALE.md §2: the window is never "just images" — a text TOC
and one-line labels precede each page so the model knows what each page
holds, hot (frequently touched) sections ride as plain canonical text, and
only OCR-certified pages are carried as images (REPORT.md "OCR fidelity":
an uncertified page may be unreadable, so its sections fall back to text).
Token math delegates to budget.tokens_for_model (downscale-aware) and
constants.text_tokens_est; the plan never exceeds its token budget.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from .budget import WindowStats, tokens_for_model
from .constants import text_tokens_est


@dataclass
class WindowBlock:
    type: str            # 'text' | 'page_label' | 'page_image' | 'toc'
    content: str         # text, label line, or page png path
    tokens: int


@dataclass
class WindowPlan:
    blocks: list[WindowBlock]
    stats: WindowStats


def _toc_text(entries: list[dict]) -> str:
    lines = ["TOC:"]
    for e in entries:
        kws = ", ".join(e.get("top_keywords", []))
        lines.append(f"- {e.get('source', '')} [{e.get('kind', 'prose')}] "
                     f"{e.get('n_sections', 0)} sections | {kws}")
    return "\n".join(lines)


def _load_manifests(pages_dir: Path) -> list[dict]:
    """All page manifests under pages_dir, sorted by page_id for
    deterministic window plans."""
    manifests = []
    if not pages_dir.is_dir():
        return manifests
    for path in sorted(pages_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and "page_id" in data:
            manifests.append(data)
    manifests.sort(key=lambda m: m["page_id"])
    return manifests


def build_window(store, index, *, token_budget: int, model: str,
                 query: str | None = None, hot_text_budget: int = 8000,
                 pages_dir: str | Path) -> WindowPlan:
    """Assemble a WindowPlan per CONTRACT.md §window.py.

    Order: (1) TOC from index.toc(); (2) hot text sections — store.heat()
    desc, ties in jsonl order (plus, when `query` is given, BM25 hits as
    lower-priority hot candidates); (3) certified pages, each preceded by
    a page_label block; (4) uncertified/unpaged sections as plain text.
    Never exceeds token_budget; blocks that do not fit are skipped.
    text_equiv_tokens / chars_carried count ALL carried content as text.
    """
    pages_dir = Path(pages_dir)
    stats = WindowStats(model=model)
    blocks: list[WindowBlock] = []
    remaining = token_budget

    def try_add(block: WindowBlock, equiv_tokens: int, chars: int) -> bool:
        nonlocal remaining
        if block.tokens > remaining:
            return False
        blocks.append(block)
        remaining -= block.tokens
        stats.real_tokens += block.tokens
        stats.text_equiv_tokens += equiv_tokens
        stats.chars_carried += chars
        return True

    # ---- (1) TOC -------------------------------------------------------
    toc_entries = index.toc()
    if toc_entries:
        content = _toc_text(toc_entries)
        toc_tokens = text_tokens_est(len(content), "prose")
        try_add(WindowBlock("toc", content, toc_tokens),
                toc_tokens, len(content))

    # ---- (2) hot text sections ----------------------------------------
    metas = store.all_meta()
    jsonl_pos = {m["id"]: i for i, m in enumerate(metas)}
    hot = [m for m in metas if store.heat(m["id"]) > 0]
    hot.sort(key=lambda m: (-store.heat(m["id"]), jsonl_pos[m["id"]]))
    if query:
        hit_ids = [rec.get("id") for _, rec in index.search(query, k=10)]
        seen = {m["id"] for m in hot}
        hot += [m for m in metas
                if m["id"] in hit_ids and m["id"] not in seen]

    carried_ids: set[str] = set()
    hot_used = 0
    for m in hot:
        try:
            text = store.get(m["id"])
        except KeyError:
            continue
        t = text_tokens_est(len(text), m.get("kind", "prose"))
        if hot_used + t > hot_text_budget:
            continue
        if try_add(WindowBlock("text", text, t), t, len(text)):
            hot_used += t
            carried_ids.add(m["id"])
            stats.n_text_sections += 1

    # ---- (3) certified pages (label + image pairs) ---------------------
    manifests = _load_manifests(pages_dir)
    # A section may span pages, and its store record only keeps the LAST
    # page_id — so page membership comes from the manifests' section lists,
    # never from meta["page_id"] (review finding: last-wins overwrite let a
    # certified tail page suppress the text fallback for content that
    # actually lived on an uncertified earlier page).
    sec_pages: dict[str, list[tuple[str, int]]] = {}
    for man in manifests:
        for sec in man.get("sections", []):
            span = max(0, sec.get("char_end", 0) - sec.get("char_start", 0))
            sec_pages.setdefault(sec["id"], []).append((man["page_id"], span))

    # order pages by first appearance of their sections in the store
    # (append order, per SCALE.md §5 cache-churn rule); page_id ties.
    def _page_order(man):
        positions = [jsonl_pos[s["id"]] for s in man.get("sections", [])
                     if s["id"] in jsonl_pos]
        return (min(positions) if positions else len(jsonl_pos),
                man["page_id"])

    def _page_equiv(man) -> tuple[int, int]:
        """(text-equivalent tokens, canonical chars) for a page: canonical
        section chars prorated by the portion rendered on this page —
        NL_MARK/separator overhead must not inflate the ratio."""
        equiv_tokens = equiv_chars = 0
        kind = man.get("kind", "prose")
        for sec in man.get("sections", []):
            on_page = max(0, sec.get("char_end", 0) - sec.get("char_start", 0))
            total = sum(n for _, n in sec_pages.get(sec["id"], [])) or on_page
            try:
                canonical = store.meta(sec["id"]).get("chars", on_page)
            except KeyError:
                canonical = on_page
            frac = on_page / total if total else 0.0
            chars = round(canonical * frac)
            equiv_chars += chars
            equiv_tokens += text_tokens_est(chars, kind)
        return equiv_tokens, equiv_chars

    carried_page_ids: set[str] = set()
    image_n = 0
    for man in sorted(manifests, key=_page_order):
        if not (man.get("cert") or {}).get("passed"):
            continue
        png_path = pages_dir / f"{man['page_id']}.png"
        if not png_path.exists():
            continue
        img_tokens = tokens_for_model(model, man["page_w"], man["page_h"])
        titles = []
        for sec in man.get("sections", []):
            try:
                titles.append(store.meta(sec["id"]).get("title") or sec["id"])
            except KeyError:
                titles.append(sec["id"])
        label = (f"Image {image_n + 1}: page {man['page_id']} — "
                 f"sections: {', '.join(titles)}")
        label_tokens = text_tokens_est(len(label), "prose")
        if label_tokens + img_tokens > remaining:
            continue  # pair does not fit; keep pair atomic
        page_equiv, page_chars = _page_equiv(man)
        try_add(WindowBlock("page_label", label, label_tokens),
                label_tokens, len(label))
        try_add(WindowBlock("page_image", str(png_path), img_tokens),
                page_equiv, page_chars)
        carried_page_ids.add(man["page_id"])
        image_n += 1
        stats.n_pages += 1

    # ---- (4) text fallback ----------------------------------------------
    # Carry canonical text for every section not already in the window:
    # unpaged, on an uncertified page, on a page dropped for budget, or on
    # a page whose PNG is missing. Only sections whose EVERY page was
    # actually carried as an image are skipped.
    for m in metas:
        if m["id"] in carried_ids:
            continue
        pages_of = sec_pages.get(m["id"])
        if pages_of and all(pid in carried_page_ids for pid, _ in pages_of):
            continue  # fully carried as image(s)
        try:
            text = store.get(m["id"])
        except KeyError:
            continue
        t = text_tokens_est(len(text), m.get("kind", "prose"))
        if try_add(WindowBlock("text", text, t), t, len(text)):
            carried_ids.add(m["id"])
            stats.n_text_sections += 1

    return WindowPlan(blocks=blocks, stats=stats.finalize())
