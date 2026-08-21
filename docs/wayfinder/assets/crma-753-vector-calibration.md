# CRMA-753 — trend→product vector-space calibration readout

Prototype calibration for the sourcing retrieval stage (map CRMA-745). Run 2026-08-20
against the full live corpus: **443 live trends** (latest real enrichment row each,
`WRITTEN_BY <> 'promotion'`, non-RETIRED) × **187 products** (the Shopify admin CSV export
of 2026-08-20, `~/dev/trend-tree-data/products_export_2026-08-20.csv`, out of git). All
embedding and cosine work ran in-warehouse on Cortex; nine variant combinations were
scored over the full 82,841-pair matrix, plus a tenth (doc D) scored against the winner.

## Decisions

| Question | Answer |
| --- | --- |
| Space | **arctic-l / 1024** (`EMBED_TEXT_1024`, `snowflake-arctic-embed-l-v2.0`) |
| Trend anchor | **The persisted `TREND_VECTOR`** on the latest real enrichment row — no trend-side re-embed |
| Product embed doc (v1) | `title. Type: <type>. Vendor: <vendor>. Tags: <tags>. <body first 600 chars, HTML-stripped>` |
| Threshold | **`SEMANTIC_THRESHOLD = 0.40`**, one global floor — not category-aware |
| Candidates shown | **`TOP_N = 10`** (all products ≥ 0.40, score-descending, capped at 10) |

### Which space, which anchor

- **arctic-m/768 fails.** It compresses the range (pair median 0.283 vs 0.165 for L) and
  cannot separate: **242 of 443** trends clear a 0.45 top-1 in M, vs **50** in L. Its
  negatives run hot — 'Heeled Flip-Flops' 0.36, 'DIY Tooth Gems' 0.479 (vs 0.30/0.34 in L).
- **The persisted vector performs equal-or-better than a fresh `NAME + '. ' + SUMMARY_SHORT`
  doc** (the CRMA-452 recipe) in the same L space: on the labeled positives the persisted
  anchor scored higher (Tallow 0.773 vs 0.713), and top-1 floor counts differ only
  marginally (50 vs 36 trends ≥ 0.45). The CRMA-452 finding that a fresh short doc beats
  the canonical vector **does not transfer** to this corpus — the product side is not the
  keyword-level content space. Using the persisted vector costs nothing per run and keeps
  sourcing on the pipeline's canonical trend identity.

### The embed doc

Four product-doc variants, all measured against the persisted-L anchor:

| Variant | Fields | Tallow top-1 | Trends ≥ 0.45 | Verdict |
| --- | --- | --- | --- | --- |
| A | title + tags | 0.644 | 31 | recall too shallow |
| B | A + type/vendor/Google-category leaf | 0.689 | — | superseded by C |
| C | B + body excerpt (600 chars) | 0.773 | 50 | best scores |
| D | **C minus Google category** | 0.763 | 48 | **winner** |

Doc D correlates with doc C at **0.997** (mean top-1 delta 0.001; every labeled case within
±0.01). The Google taxonomy category — present on only 119/187 products in the CSV and
**absent from the REST product payload** — contributes nothing measurable, so v1 drops it.
Consequence: **the v1 embed doc needs only REST product-record fields**
(`title`, `product_type`, `vendor`, `tags`, `body_html`), so the CRMA-752 sync stays on
REST with no GraphQL dependency. `Type` is skipped when it holds the literal `'0'` (28
products in this store); `body_html` is HTML-stripped and truncated to 600 chars; `tags`
is the comma-split, comma-rejoined string. This recipe is `EMBED_DOC_VERSION = 'v1'`.

### The threshold, and why it is not category-aware

Pair-level noise: P50 0.152, P99 0.365 (persisted × doc C/D). Labeled positives top out
0.45–0.77. The decisive measurements at the boundary:

- **A perfect match scored 0.45**: 'Whole-Body Deodorant' → *Native Whole Body Deodorant
  Spray* (0.453 doc C, 0.450 doc D). A 0.45 floor keeps it only by rounding luck.
- **The same score held a wrong match**: 'Circadian Light Glasses' → *Red Light Therapy
  Hat* at 0.453. Geometry cannot separate these two; judgement can.

So the floor sits at **0.40** — below perfect-match territory, above the P99 noise bulk —
and admission control beyond it belongs to the selector. At 0.40, **93 of 443 live trends
(21%)** get a non-empty candidate pool (~4.6 candidates average); the other 350 correctly
return nothing. 'Sun-Setting Dust' (beauty/sun_care, RETIRED — scored ad hoc) tops out at
**0.328**: the store stocks no sun-care product, and the floor correctly gives it nothing.

Category-awareness is rejected: the legitimate matches routinely cross the 14-value
`CATEGORY` axis (wellness trend → tallow balm, food trend → kitchen hardware), the catalog
has no aligned category column to condition on, and the trend-to-trend dual-threshold
precedent solves a different problem (same-space trend pairs). `CATEGORY`/`SUBCATEGORY`
stay selector signal, per the standing constraint.

### TOP_N

Among trends clearing the floor the pool averages ~4.6 and is usually ≤ 7; the deep pools
are catalog clusters ('Tallow Skincare' 33 ≥ 0.40, mushroom-coffee trends ~16–22). A cap
of **10** bounds the selector's context and the per-run candidate-ledger write while
leaving every measured pool's real matches inside the cap. `MAX_SOURCED_PRODUCTS` stays 5
(picks), per the standing constraint.

## The test case

Marcelo's literal worked example cannot run: **the current 187-product catalog stocks no
SPF or sun-care product at all** — 'brush-on mineral SPF powder' is not in the store, and
the trend 'Sun-Setting Dust' is RETIRED. It ran as the floor (negative) test instead, and
passed. The semantic reach it was meant to demonstrate shows up elsewhere with no token
overlap: 'Adaptogenic Coffee Swaps' → *Mushroom Coffee Blend* (0.616), 'Passive Toilet
Biometrics' → *Bluetooth Digital Bathroom Scale with Heart Rate Tracking* (0.464),
'Bedtime Magnesium Sprays' → *Whipped Magnesium Tallow Balm* (0.477) — none reachable by
substring matching.

## Evidence forward to CRMA-754 (selector contract)

The retrieval stage is **not** collapsed — the collapse condition (vector ranking adds
nothing) was not met; recall is doing real work. But the score-tie at 0.453
(perfect match vs wrong match) is direct evidence the selector **earns its place**: a
threshold alone cannot finish the job at any setting. The selector's refusal permission is
load-bearing in the 0.40–0.45 band, where this run saw both perfect matches and junk.

## Measured side-facts for the map

- **701 distinct trends** hold at least one real (non-seed) enrichment row; **443** of
  them are live (non-RETIRED) with a persisted `TREND_VECTOR`. The ledger profile:
  `enrichment` 942 rows / 701 trends, `promotion` (seed) 378/378, backfills 76/76,
  `lifecycle_request` 1/1. This answers the map's open "size of the first poll tick"
  question: **443** under a live-scoped poll.
- Full-matrix cost is negligible: embedding 187 products × 4 variants in both spaces plus
  443 fresh trend docs and the 82,841-pair cosine matrix ran in seconds-to-minutes on the
  default warehouse.

## Reproduction

Scratch tables (transient, `MCC_RAW.MARKETING_DEV`, **dropped after the run**):
`PROTO_CRMA753_CATALOG`, `PROTO_CRMA753_CATVEC`, `PROTO_CRMA753_CATD`,
`PROTO_CRMA753_TRENDS`, `PROTO_CRMA753_SCORES`. The corpus builder
(`build_catalog.py`) parses the CSV grouping rows by `Handle`, strips HTML, splits the
comma-separated tags, and excludes every cost field; the trend table takes the latest
`WRITTEN_BY <> 'promotion'` enrichment row per non-RETIRED trend; scoring is
`VECTOR_COSINE_SIMILARITY` over a cross join. The CSV export never entered git or
Snowflake beyond the doc fields listed above.
