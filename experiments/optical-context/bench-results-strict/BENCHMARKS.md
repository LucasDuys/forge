# opticalctx — measured benchmarks (local-only)

Local proxies only: OCR CER is tesseract/rapidocr (a frontier VLM generally reads better); token costs are computed from the verified patch formula and public pricing, not API calls.

## Scale

- corpus: **7,450,491 chars** -> 2,262 sections in 1.18s (6,340,131 chars/s)
- index: 973,480 bytes on disk
- pages: **700** rendered in 352.89s (1.98/s), avg 11,408 chars/page
- search: p50 49.8ms / p95 55.65ms
- store size on disk: 278,130,436 bytes

## Fidelity (CER by kind x font size; gate 0.1%)

| kind | px | chars/page | tesseract CER | rapidocr CER | gate |
|---|---|---|---|---|---|
| prose | 9 | 16,351 | 3.54% | 47.63% | fail |
| prose | 10 | 13,452 | 1.44% | 18.43% | fail |
| prose | 11 | 11,431 | 0.86% | 30.90% | fail |
| prose | 12 | 9,555 | 0.67% | 19.45% | fail |
| prose | 14 | 7,182 | 0.25% | 14.95% | fail |
| code | 9 | 16,351 | 11.74% | 13.67% | fail |
| code | 10 | 13,452 | 8.14% | 10.47% | fail |
| code | 11 | 11,431 | 4.62% | 7.02% | fail |
| code | 12 | 9,555 | 3.83% | 8.46% | fail |
| code | 14 | 7,182 | 2.42% | 7.79% | fail |
| log | 9 | 16,351 | 5.28% | 54.32% | fail |
| log | 10 | 13,452 | 1.90% | 12.48% | fail |
| log | 11 | 11,431 | 1.27% | 24.37% | fail |
| log | 12 | 9,555 | 0.82% | 4.70% | fail |
| log | 14 | 7,182 | 0.49% | 10.04% | fail |
| docs | 9 | 16,351 | 5.80% | 45.07% | fail |
| docs | 10 | 13,452 | 3.70% | 14.56% | fail |
| docs | 11 | 11,431 | 3.37% | 40.83% | fail |
| docs | 12 | 9,555 | 2.47% | 24.99% | fail |
| docs | 14 | 7,182 | 2.49% | 29.64% | fail |

## Effective context (window simulation, 180k budget)

| model | real tok | chars carried | text-equiv tok | ratio | pages | first turn | cached turn |
|---|---|---|---|---|---|---|---|
| sonnet-5 | 179,997 | 729,434 | 182,363 | 1.013x | 2 | $0.54 | $0.054 |
| opus-4.8 | 179,997 | 729,434 | 182,363 | 1.013x | 2 | $0.9 | $0.09 |
| haiku-4.5 | 179,997 | 729,434 | 182,363 | 1.013x | 2 | $0.18 | $0.018 |

## Session cost (40-turn agent session, 150k carried window)

| model | text, no cache | text + cache | optical + cache | ratio used | saving vs text+cache |
|---|---|---|---|---|---|
| sonnet-5 | $18.84 | $3.1575 | $3.1278 | 1.013x | 1% |
| opus-4.8 | $31.4 | $5.2625 | $5.2129 | 1.013x | 1% |
| haiku-4.5 | $6.28 | $1.0525 | $1.0426 | 1.013x | 1% |

Note: 1092x1092 pages survive every model tier undistorted (1,521 visual tokens). Standard-tier models simply price the same tokens differently; larger 1568px pages would be silently downscaled there.

## Certification verdict

- **prose**: median CER 0.64% (6/413 pages sampled) — FAIL at gate 0.5%
- **code**: median CER 4.75% (6/244 pages sampled) — FAIL at gate 0.5%
- **log**: median CER 1.08% (6/41 pages sampled) — FAIL at gate 0.5%
- **docs**: median CER 3.39% (2/2 pages sampled) — FAIL at gate 0.5%
