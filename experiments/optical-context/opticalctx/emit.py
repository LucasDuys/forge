"""Emit a WindowPlan as Claude Messages API content blocks.

This is the last mile that makes optical windows *usable*: build_window
decides what to carry; this module turns the plan into the exact JSON the
API expects — labels before images (per Anthropic's multi-image guidance),
base64 or Files-API sources, and a cache_control breakpoint on the final
block so the whole assembled window rides the prompt cache (~0.1x) on
every later turn. See ../SCALE.md §2-3.

Usage:
    from opticalctx.emit import plan_to_content
    content = plan_to_content(plan)                      # base64 images
    content = plan_to_content(plan, file_ids={...})      # Files API refs
    resp = client.messages.create(model=..., max_tokens=...,
        messages=[{"role": "user", "content": content + [
            {"type": "text", "text": task_prompt}]}])

With the Files API, upload each page PNG once (files.upload) and pass
{page_png_path: file_id}; payloads stay small no matter how many pages the
window carries.
"""

import base64
from pathlib import Path

from .window import WindowPlan


def plan_to_content(plan: WindowPlan, *, file_ids: dict | None = None,
                    cache_last_block: bool = True) -> list[dict]:
    """Content blocks for one user message, in window order.

    file_ids: optional {png_path_str: files_api_id}; pages found in the map
    are emitted as Files-API references, everything else as base64 PNG.
    cache_last_block: stamp cache_control on the final block so the entire
    window prefix is cacheable — keep the window byte-stable across turns
    (append-only pages, same ordering) or the cache write is wasted.
    """
    file_ids = file_ids or {}
    content: list[dict] = []
    for block in plan.blocks:
        if block.type == "page_image":
            path = block.content
            if path in file_ids:
                source = {"type": "file", "file_id": file_ids[path]}
            else:
                data = base64.b64encode(Path(path).read_bytes()).decode()
                source = {"type": "base64", "media_type": "image/png",
                          "data": data}
            content.append({"type": "image", "source": source})
        else:  # toc / text / page_label are all plain text blocks
            content.append({"type": "text", "text": block.content})
    if cache_last_block and content:
        content[-1]["cache_control"] = {"type": "ephemeral"}
    return content
