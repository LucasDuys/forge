# Optical Context at Scale — architecture without an API key in the loop

Answers two questions: (1) how the system runs at scale when the build/
verify/index pipeline must not depend on a paid API, and (2) whether a
context window made of images + a metadata map is actually faster, cheaper,
and bigger. Companion to `RESEARCH.md` (sources) and `REPORT.md` (local
measurements). Colibri section corrected to the real repo:
[JustVugg/colibri](https://github.com/JustVugg/colibri).

## 1. The core at-scale insight: pages are a view, not a store

Storing text as PNG is strictly worse than storing text as text — disk is
cheap and gzip beats PNG for text. The image form only pays off at the
model boundary. So at scale:

- **Canonical store**: plain text sections on disk (append-only,
  content-addressed: `sha256(canonical_text) = section_id`).
- **Pages are rendered lazily** from canonical text by a deterministic
  renderer (same input → same PNG bytes → same hash), then cached.
- **Nothing ever quotes from an image.** Quote-backs, edits, and exact
  reads are served from canonical text. Images exist only to make a
  Claude context window denser.

This kills the fidelity problem at the root: a misread page can never
corrupt state because the page was never the source of truth.

## 2. The window arithmetic ("more images = bigger window"?)

Yes — bounded. Confirmed limits (platform.claude.com/docs, 2026-07):
patch formula `ceil(w/28)×ceil(h/28)`; high-res tier (Fable/Mythos 5,
Opus 4.7/4.8, Sonnet 5) 2576px/4784 tok per image; 100 images/request on
200k-context models, 600 on larger; >20 images caps each at 2000px.

**200k window on Sonnet 5, reserving 20k for system + hot text + output:**

| layout | pages | chars carried | text-token equivalent | effective window |
|---|---|---|---|---|
| all text | — | ~720k | 180k | 1.0x |
| 1568² pages, 11px mono (measured density scaled) | 57 | ~1.37M | ~343k | **~1.9x** |
| 1568² pages, 10px proportional (research est.) | 57 | ~1.9M | ~475k | **~2.6x** |

So a 200k window behaves like a 380–520k window. **Faster**: prefill and
per-turn cost scale with real tokens, so a 2x-denser window is ~2x cheaper
and lower-latency than the text window carrying the same content (Glyph
measured ~4.8x prefill speedup at 128k). **Bigger**: 2–2.6x, not 10x —
transcription survives ~10x compression but *reasoning* degrades past
~3–4x, and nobody has published reasoning-over-pixels numbers for Claude.

The window is never "just images": every page is preceded by a one-line
text label (the docs' own multi-image guidance) carrying its metadata —
`Image 7: page a3f2, sections: auth-flow, token-budget, retry-logic` —
so the model knows what each page holds without reading it, and the hot
index maps queries to page numbers. That labeled map is your "metadata
pointing to what each chunk means," and it stays text forever.

**The two multipliers that dwarf the 2x:**

1. **Prompt caching.** Pages are immutable and appended in stable order →
   the whole page block is a cache hit at ~0.1x on every subsequent turn.
   Optical 2x × cache 10x ≈ one-twentieth the steady-state input cost of
   an uncached text window with the same content. Mutating even one page
   invalidates the suffix — immutability is load-bearing, not a nicety.
2. **Files API.** Upload each page once, reference by `file_id` — request
   payloads stay small no matter how many pages accumulate (vs re-sending
   base64 every turn), and one page dedupes across every agent/session
   that references it. Content-addressing makes this automatic.

## 3. Running without an API key: the three loops

**Build loop (fully local, no key):** sectionize → deterministic
transforms → canonical store → index (BM25/FTS5). Render + certify pages
in the background: tesseract as the floor, a modern local OCR as the real
gate (PaddleOCR or RapidOCR-ONNX ~2GB RAM; Surya; GOT-OCR2 with a small
GPU), plus a per-line CRC32 column rendered into the page margin so ANY
reader can detect (not just suspect) a misread line and re-fetch canonical
text. A page ships only if local CER < 0.1%; otherwise the section stays
text-only. No Claude tokens are ever spent building or verifying.

**Read loop, key-present mode:** the agent's context = hot text + labeled
page block (cached, file_id-referenced) + index. Claude reads pages
in-place; exact quotes come from `memory_get(section_id)` → canonical
text.

**Read loop, key-absent mode (local interpretation):** a local VLM is the
reader instead of Claude — Qwen2.5-VL-7B int4 via llama.cpp runs in
~8-10GB RAM at usable tok/s on a 20GB machine; DeepSeek-OCR (3B MoE) if a
GPU exists. But note the inversion: a local reader has no token meter, so
feeding it images saves nothing — feed it canonical text directly. The
honest role of local models is **distillation**: local model reads the
big corpus, emits summaries/answers/metadata; Claude (when used at all)
receives only the distilled text. Images then matter only as the
*transport* into Claude, never as the local format.

## 4. Colibri (JustVugg/colibri) — corrected assessment

What it actually is: a ~2,400-line pure-C inference engine running
**GLM-5.2 (744B MoE) in ~25GB RAM** by treating VRAM/RAM/NVMe as one
memory hierarchy. Dense ~17B params resident at int4 (~9.9GB); 21,504
routed experts live on disk (~370GB) and stream on demand (~11GB of
experts change per token). MLA compressed KV (576 floats/token, 57x
smaller), MTP speculative decoding (2.2–2.8 tok/forward), DSA sparse
attention, GBNF grammar-forced output, LRU expert cache + learning cache
(`.coli_usage`) that improves hit rates with use, KV persistence across
restarts. Measured: ~0.05–0.1 tok/s cold, **~0.3–1.2 tok/s warm** across
community hardware. Apache 2.0.

**Fit for this project:**

- **Interactive reading path: no.** At ~1 tok/s an answer takes minutes;
  agentic loops need hundreds of tok/s. Not the query-time interpreter.
- **Offline librarian: plausible niche.** ~1 tok/s ≈ 86k output tok/day.
  Section metadata is ~100 tokens each → a nightly Colibri pass can
  summarize/tag hundreds of new sections with 744B-class quality on a
  20GB box, for electricity. Its GBNF grammar-forcing (acceptance ~1.0)
  is exactly right for emitting strict metadata JSON. Pair with cheap
  local embeddings for the index and you have a $0 build loop with
  frontier-adjacent summary quality.
- **The architecture is the real import.** Colibri's thesis — hot dense
  core resident, cold experts streamed by learned access patterns, KV
  persisted — is isomorphic to this design: hot index pinned in context,
  warm canonical text hydrated on demand, cold content promoted by an
  access-frequency ledger (our `.coli_usage` equivalent: track which
  sections get hydrated and pre-pack the hot ones onto shared pages).
- **Not general-purpose**: `glm.c` is GLM-5.2-specific. Don't plan around
  running arbitrary VLMs through it; use llama.cpp for those.

## 5. Failure modes that appear only at scale

1. **Cache-order churn**: any reordering/eviction of the page block
   invalidates the prompt cache suffix. Fix: pages append-only, evict
   only from the tail, rebuild windows on session boundaries.
2. **Index bloat**: at ~350 bytes/section, 10k sections = 3.5MB ≈ 875k
   tokens — the hot index itself no longer fits. Fix: two-level index
   (in-context: domain-level TOC, ~100 entries; on-disk: full section
   index queried via tool call). The in-context layer never grows.
3. **Page fragmentation**: sections churn, pages are immutable → old
   pages accumulate dead sections. Fix: generational GC — re-pack live
   sections onto new pages when a page's live ratio < 50%, like an LSM
   compaction; old file_ids expire naturally.
4. **Tier drift**: a subagent on Haiku silently gets downscaled pages.
   Fix: tier check by model id; standard-tier consumers get 1092² pages
   or text fallback, never 1568².
5. **Renderer drift**: any font/pixel change alters page hashes and
   orphans every cached file_id. Pin renderer version into the content
   address: `page_id = sha256(renderer_version || text)`.
