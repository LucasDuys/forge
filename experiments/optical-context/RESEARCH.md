# Optical Context Memory for Agentic Coding: Technical Research Brief

**Prepared:** 2026-07-14 · **Audience:** developer designing an image-paged cold-context backend (rendered pages + section-metadata index) for token reduction in agentic coding loops (Forge).

---

## 1. Executive Summary — Verified Economics Verdict

**The token arithmetic is real; the "100% readability" half of the pitch is not.** Adversarial verification against Anthropic's live vision docs ([platform.claude.com/docs/en/build-with-claude/vision](https://platform.claude.com/docs/en/build-with-claude/vision)) confirms that on Claude's **high-resolution-tier models only** (Fable 5, Mythos 5, Opus 4.7/4.8, Sonnet 5), a 1568×1568 image costs exactly **3,136 visual tokens** while holding ~30–37K characters of legible 10–11px text (~7,500–9,300 text tokens) — a genuine **2.4–3.0× input-token saving**, and image blocks are valid prompt-cache targets.

But the saving and reliability sit at **opposite ends of the same curve**:

| Font size | Token saving vs text |
|---|---|
| 10px | **2.95×** |
| 12px | 1.96× |
| 14px | 1.49× |
| 16px | 1.11× |
| ~20px x-height (near-perfect OCR regime) | **0.59× — image costs 70% MORE than text** |

Anthropic publishes **no OCR accuracy figure** and explicitly warns Claude "might hallucinate or make mistakes" on small text. Third-party evals put Claude at ~2% character error rate on printed text — at which a 30K-char page has essentially **zero probability of verbatim-perfect recall**. For an agentic *coding* memory — code, hashes, UUIDs, file paths, whitespace-exact diffs — the documented failure modes of optical compression land precisely on the highest-stakes content ([Glyph README limitations](https://github.com/thu-coai/Glyph)).

**Verdict:** viable for *approximate* cold context (logs, transcripts, prose summaries, reference docs) at 2–3× compression on high-res-tier Claude models; **not viable as the fidelity-critical store for code and identifiers**, and the cache-invalidation economics can invert the saving entirely in a mutating agent loop (Section 8). The 2–3× headline must also be weighed against Claude's cheaper existing levers: prompt caching at ~0.1×, compaction, context editing, and the 1M-token window.

---

## 2. Prior Art

### DeepSeek-OCR — "Contexts Optical Compression" ([arXiv 2510.18234](https://arxiv.org/abs/2510.18234), [paper PDF](https://raw.githubusercontent.com/deepseek-ai/DeepSeek-OCR/main/DeepSeek_OCR_paper.pdf))
- ~380M DeepEncoder (SAM-base 80M + CLIP-large 300M + 16× conv compressor) → DeepSeek-3B-MoE decoder (570M active). 1024×1024 image → 256 vision tokens.
- Modes: Tiny 512² = 64 tokens; Small 640² = 100; Base 1024² = 256; Large 1280² = 400; Gundam n×100+256.
- **The reliability cliff (Fox benchmark, 100 vision tokens):** 98.5% precision @ 6.7× compression, 96.8% @ 9.7×, then **91.5% @ 10.6×, 87.1% @ 12.6×, ~60% @ 20×**. The near-lossless regime ends almost exactly at **10×** — for a purpose-trained OCR decompressor.
- Failure modes: dense multi-column layouts (newspapers collapse at edit distance 0.94 in Tiny mode) and text blur at high compression.
- Throughput: 200k+ pages/day on one A100-40G (self-reported).

### DeepSeek-OCR 2 ([arXiv 2601.20552](https://github.com/deepseek-ai/DeepSeek-OCR-2), Jan 2026)
Causal-flow visual token reordering; OmniDocBench v1.5 overall **91.09 vs 87.36** for v1 at the same ~1120-token budget; beats Gemini-3 Pro (ED 0.100 vs 0.115). Same compression ratio — better fidelity, not more compression.

### Glyph ([arXiv 2510.17800](https://arxiv.org/abs/2510.17800), [repo](https://github.com/thu-coai/Glyph)) — the only end-to-end *reasoning* evidence
- Renders long text to images for a GLM-4.1V-9B VLM. **Average effective compression only 3.3× on LongBench, ~3.0× on MRCR** at parity with Qwen3-8B.
- Official README: dpi=72 → 3–4× compression, but dpi=96 (2–3×) "usually leads to better results" — **accuracy already degrades between 2–3× and 3–4×**.
- Documented limitations: rendering-parameter sensitivity, and "recognizing fine-grained or rare alphanumeric strings (e.g., UUIDs) remains difficult." Speedups: ~4.8× prefill, ~4.4× decode at 128K inputs.

### The critical takeaway
**Reading ≠ reasoning.** DeepSeek's 97%-below-10× measures *transcription*; Glyph shows task performance holds only at **3–4×**. And two 2026 papers complicate the thesis: [arXiv 2512.03643](https://arxiv.org/abs/2512.03643) argues trivial mean pooling matches the optical encoder for reconstruction ("the pixel detour discards learned representations for no gain"), and [arXiv 2605.06708](https://arxiv.org/abs/2605.06708) shows downstream utility is **not predicted by compression ratio** — some tasks collapse unpredictably, motivating per-input routing (matched per-dataset oracle on 17/24 datasets).

Also directly on-point: "Text or Pixels? It Takes Half" ([arXiv 2510.18279](https://arxiv.org/abs/2510.18279)) — ~2:1 compression on GPT-4.1-mini/Qwen2.5-VL-72B within 3 points of text baseline; and [pixelprompt](https://github.com/sinaptik-ai/pixelprompt) — 38–80% cost savings claimed on a small benchmark.

---

## 3. Token Economics on the Claude API — the Arithmetic

The current official formula (verified live 2026-07-14) is **patch-based, not the legacy (w×h)/750**:

```
image_tokens = ceil(w/28) × ceil(h/28)      // 1 token per 28×28px patch
```

Tiers: standard tier caps at 1568px long edge AND 1568 visual tokens; high-res tier (Fable 5, Mythos 5, Opus 4.7/4.8, Sonnet 5) caps at 2576px / 4784 tokens. Oversized images are **silently downscaled**.

**The 1568×1568 page on a high-res-tier model:**

```
ceil(1568/28)² = 56² = 3,136 image tokens          (under the 4,784 cap, no downscale)

Text capacity at 10–11px sans, 12px line pitch, ~5.5px avg char width:
  ~285 chars/line × ~130 lines ≈ 30,000–37,000 chars
  ÷ 4 chars/token ≈ 7,500–9,300 English text tokens
  ÷ 3.3 chars/token ≈ ~10,300–11,200 code tokens

Saving: 7,500–9,300 / 3,136 ≈ 2.4–3.0× (prose), ~3.3–3.6× (code, on paper)
Break-even: image wins whenever legible chars > 4 × image_tokens ≈ 12,500 chars/page
```

**Standard-tier models break the trick:** the same image is downscaled to ~1092×1092 = **1,521 tokens** (the docs' own fixed point for the 1568-token cap), a 0.696 scale factor that shrinks 10px text to ~7px — below reliable legibility. Haiku 4.5 is standard-tier.

**Dollar math can invert even when token math wins:** cheapest high-res-tier model is Sonnet 5 at $3/MTok. Per page: 7,500 text tokens on Haiku 4.5 ($1/MTok) = **$0.0075** vs 3,136 image tokens on Sonnet 5 = **$0.0094**. If the task tolerates a cheaper model, text-on-Haiku beats image-on-Sonnet.

**Additional verified constraints:**
- Requests with **>20 images** enforce a ~2000px per-image cap — bulk page-stuffing cannot use the 2576px long edge.
- Image blocks are cacheable (reads ~0.1×, 5-min writes 1.25×), but minimum cacheable prefix is **4096 tokens on the Opus family** — a single 3,136-token image doesn't clear it alone.
- Any need to **quote text back out** erases everything: output tokens cost ~5× input; transcribing ~7,500 tokens of content costs >10× the input saving — and coding agents constantly echo exact strings (`old_string`/`new_string` edits).
- Comparison landscape: OpenAI tile models force downscale to 768px (dense text illegible at 765 tokens max); Gemini's 258-tokens-per-768px-tile implies ~8.5× compression — right at the DeepSeek cliff edge.

---

## 4. OCR / Readability Limits and Recommended Rendering Parameters

Hard floors from the literature ([Tesseract tessdoc](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html), [arXiv 2604.12371](https://arxiv.org/abs/2604.12371), [arXiv 2502.06445](https://arxiv.org/abs/2502.06445)):

- **Tesseract-class engines:** x-height <10px unreliable, <8px discarded as noise; near-perfect requires **20–30px x-height**, strokes ≥2px. What matters is rendered pixel height, not DPI.
- **VLMs:** reliable reading begins at ~8–10px font; 6px collapses to 0.3–24% read rates. **Line spacing ≤20px drives Claude/GPT-4o/Qwen to near-zero** in one benchmark — tight leading kills VLM reading before small glyphs do.
- The only documented **100%-accuracy** pipeline ([monperrus.net](https://www.monperrus.net/martin/perfect-ocr-digital-data)) used monospace fonts (Inconsolata 11pt, 4.2KB/A4 page) plus **base32 + Reed-Solomon ECC (+74% overhead for 1.5% error tolerance)**. True guarantees require ECC, not trust in raw OCR.

**Recommended rendering recipe:**
- Grayscale anti-aliasing; **no subpixel/ClearType** (color fringes become topology-breaking halos after grayscale conversion), no pre-binarization (LSTM OCR prefers grayscale, [tesseract#1780](https://github.com/tesseract-ocr/tesseract/issues/1780)), no JPEG (artifacts; use PNG).
- Black-on-white, clean monospace (Inconsolata/Free Mono) or common training-set font; quiet border margin.
- **For the Claude high-res tier: 10–12px font minimum, line pitch >20px, canvas ≤1568×1568** so no silent downscale ever occurs (and stay under the >20-image dimension cap). Never emit a page assuming the 2576px edge.
- Single column; keep effective compression **≤3–4×** (the Glyph end-to-end ceiling), not the 8–10× transcription ceiling.
- Validate empirically before shipping: render known text at 10/12/14px, measure CER against Claude — no published number exists for this exact setup.

---

## 5. Deterministic Text Compression (Do This *Before* Reaching for Pixels)

- **gzip/brotli into the prompt is a dead end:** binary output shreds in the tokenizer; even models trained from scratch can't learn arithmetic-coded text ([arXiv 2404.03626](https://arxiv.org/abs/2404.03626)).
- **Serialization-format choice is the biggest cheap win:** [TOON](https://github.com/toon-format/toon) uses 40–60% fewer tokens than pretty JSON on uniform tabular data with equal-or-better retrieval accuracy (76.4% vs 75.0%); compact JSON wins on irregular nesting. Deterministic and reversible.
- **Schema compilation:** [TSCG](https://github.com/SKZL-AI/tscg) ([arXiv 2605.04107](https://arxiv.org/abs/2605.04107)) — 50–72% savings on tool schemas with a formal ≥51% bound, zero-dependency 34.7KB MIT JS, and *improves* accuracy (Claude Sonnet 4: 46.8% savings, +7.5pp on BFCL). Directly compatible with Forge's zero-npm-dependency constraint.
- **Selective pruning:** CompactPrompt ([arXiv 2510.18043](https://arxiv.org/abs/2510.18043)) — 53–58% reduction with <5% accuracy loss via self-information pruning + deterministic n-gram abbreviation (~1.44× alone).
- **Avoid naive stopword/caveman stripping:** LLM-Microscope ([arXiv 2502.15007](https://arxiv.org/abs/2502.15007)) shows filler tokens carry the most contextual memory — stopword removal cost 12.8–20.5% relative accuracy, worst on long-context recall. Consistent with Forge's own below-target 12% caveman result (`docs/benchmarks/caveman-integration.md`).
- Neural compressors ([LLMLingua-2](https://github.com/microsoft/LLMLingua), 2–5×) work but need a ~560M-param model — violates Forge's zero-dependency posture.

**Use:** TOON/compact-JSON format selection + TSCG-style schema compilation + n-gram abbreviation with legend. These deliver 20–70% deterministically on exactly Forge's content (state files, checkpoints, schemas, plans) with **zero** fidelity risk — often matching the optical path's 2–3× without touching pixels.

---

## 6. Page/Section Indexing Design

The 2025–2026 field has converged on exactly the proposed design — **structured metadata TOC + lazy hydration by ID, with embeddings as an optional overlay, not the backbone:**

- **Claude Code microcompact:** tool results to disk, path reference in context, hot tail visible (measured 204k → 82k tokens, 58.6%).
- **Anthropic memory tool** (`memory_20250818`): a plain file directory, no index, no embeddings — 84% token savings + 39% performance gain on a 100-turn benchmark. Filesystem-as-index with good naming beats vector search at agent scale.
- **[claude-mem](https://github.com/thedotmack/claude-mem)-style 3-layer progressive disclosure:** search returns ~50–100 tokens/result index entries; full detail (~500–1,000 tokens) fetched only for pre-filtered IDs (~10× savings from filter-before-fetch).
- **MemGPT/Letta, Zep/Graphiti ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)), Mem0 ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)):** all agent-driven paging over summaries/community metadata; Mem0: ~1.8K vs ~26K tokens per conversation, 91% lower p95 latency.

**Recommendations:** SQLite + FTS5 (BM25, single-digit-ms at 100k–1M docs, zero infra) as the lexical backbone; section metadata (title, symbols, file paths, summary, page ID, byte offsets) in the always-hot index; agent-driven fetch tool for hydration. Embeddings optional (all-MiniLM-L6-v2 is ~46MB if wanted; cloud embedding of 100k sections ≈ $1 one-time — the reason to skip is dependency, not cost). **Node.js gotcha:** built-in `node:sqlite` ships **without FTS5** ([nodejs/node#56951](https://github.com/nodejs/node/issues/56951), still open) — Forge needs `better-sqlite3` (native dep), a loaded extension, or a pure-JS inverted index.

**Critical design rule:** always keep the *searchable index as text*. Only page **bodies** go optical. Retrieval must never depend on reading pixels.

## 7. "Colibri" — What Was Probably Meant

No system named "Colibri" appears in the optical-compression or agent-memory literature surveyed. The user almost certainly means **ColPali** ([arXiv 2407.01449](https://arxiv.org/abs/2407.01449), "ColPali: Efficient Document Retrieval with Vision Language Models") — possibly conflated with its ancestor **ColBERT** ([arXiv 2004.12832](https://arxiv.org/abs/2004.12832)). ColPali embeds **document page images directly** (via a PaliGemma-class VLM) into multi-vector representations, and retrieves with ColBERT-style late interaction (per-patch/per-query-token MaxSim scoring), skipping OCR/layout parsing entirely; it leads the ViDoRe benchmark, with ColQwen2 as the stronger successor. **Relevance here: high for retrieval, zero for compression.** It solves "which image page matches this query" without ever transcribing the page — a natural upgrade path for the index layer if lexical search over section metadata proves insufficient. Costs: a local VLM embedder (GPU-preferred), multi-vector storage (~100–1000 vectors/page), and it conflicts with Forge's zero-dependency constraint — so treat it as an optional Phase-2 retrieval overlay, not a foundation. (Caveat: this identification is inferred; if the user meant something else by "Colibri," it should be clarified.)

## 8. Risks and Open Questions

1. **The accuracy/economics inversion:** responding to misreads by bumping font size silently walks the saving from 2.95× down through 1.11× to **0.59× (net loss)**. There is no stable operating point that is both dense and guaranteed-accurate.
2. **No accuracy floor exists:** Anthropic publishes no OCR eval; ~2% CER ⇒ ~0% chance of verbatim-perfect 30K-char pages. One silently misread identifier in agent memory can cascade into wrong edits.
3. **Prompt-cache landmine:** changing an image invalidates the messages-tier cache. Re-rendering context each turn ⇒ zero cache hits, while an append-only text transcript rides at ~0.1×. **Optical pages must be immutable, append-only blocks** — which conflicts with mutating agent state (`state.md`, rolling summaries).
4. **Reasoning-over-pixels is unmeasured on Claude:** Glyph's 3–4× ceiling is the only end-to-end datapoint, on a different model. Nobody has measured Claude's reasoning degradation over rendered text at any density.
5. **Tier fragility:** any fallback/subagent on a standard-tier model (Haiku 4.5) silently downscales pages to illegibility with no error.
6. **Quote-back costs:** agentic coding constantly echoes exact strings; output tokens at ~5× input price erase the saving many times over.
7. **Open questions:** empirical CER at 10/12/14px on Claude (must be measured locally); whether frontier models resist telegraphic-input degradation better than the 3–8B models tested; Gemini tile counts for large images; whether the mean-pooling critique ([2512.03643](https://arxiv.org/abs/2512.03643)) holds for production systems; no published deterministic phrase→rare-token codec with net-positive savings on unmodified API models.

## 9. Recommended Architecture

Build the memory backend **text-first with an optional optical tier, not optical-first**: keep a hot, always-text index (SQLite FTS5/BM25 over section metadata — titles, symbols, paths, 1–2-line summaries, page IDs) plus agent-driven hydration tools, apply deterministic transforms (TOON/compact-JSON serialization, TSCG-style schema compilation, n-gram abbreviation) to everything structured for a fidelity-free 20–70% cut, and store fidelity-critical cold content (code, diffs, identifiers) as plain text files hydrated by path exactly as Claude Code microcompact does; reserve rendered-image pages (PNG, grayscale AA, 10–12px monospace, >20px line pitch, ≤1568×1568, immutable append-only blocks with cache_control, high-res-tier models only, ≤3× effective compression) for genuinely cold, approximate-tolerance prose — old transcripts, logs, reference docs — where a misread word is recoverable by re-hydrating the canonical text file that must always exist as ground truth behind every image; gate the optical path behind a config flag and an empirical CER benchmark at your exact rendering parameters before enabling it by default, because the verified economics say the 2.4–3× saving is real but only inside a narrow regime that agentic coding workloads exit constantly.
---

## Correction (2026-07-14, post-brief)

Section 7's ColPali identification was wrong. The user meant
**[JustVugg/colibri](https://github.com/JustVugg/colibri)**: a ~2,400-line
pure-C inference engine running GLM-5.2 (744B MoE) in ~25GB RAM by
streaming routed experts from NVMe (dense ~17B core resident at int4
~9.9GB; 21,504 experts on ~370GB disk; MLA compressed KV 576 floats/token;
MTP speculative decoding 2.2–2.8 tok/forward; measured ~0.05–1.2 tok/s).
Corrected assessment and at-scale architecture: see `SCALE.md`.
