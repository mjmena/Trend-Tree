<!-- Title: 🟡 Migrating Fields — Data Sourcing -->
<!-- Parent: 🟡 Migrating Fields -->

# 🟡 Migrating Fields — Data Sourcing (warehouse scan)

Companion to [migrating.md](migrating.md). That page scoped each migrating field's
definition from **repo knowledge**. This page scopes the **data** for those fields from an
actual scan of the Snowflake warehouse — what already exists, verified live, vs. what we'd
truly have to source. Purpose: walk into the data-team conversation with tested claims, not
guesses.

## TL;DR

**Most of what `migrating.md` lists as "Missing / external" already exists in the warehouse,
live and fresh** — in schemas the Trend-Tree project simply doesn't read from today
(`GOOGLE_SEARCH_CONSOLE`, `STORY_DATA`, `AUDIENCE_IDENTITY`, `TABLEAU_REPORTING`,
`LIFESTYLE_ENTERTAINMENT`). The work shifts from **data acquisition** to three things:

1. **Access + ownership confirmation** — are these the canonical/blessed tables, who owns refresh, does our role keep read access in prod?
2. **Join-key definition** — how a trend (category / keyword / vector / geo) connects to content, search demand, and audience. **IAB taxonomy is the natural connective tissue** (content is already IAB-tagged; the audience taxonomy is IAB-shaped).
3. **Embedding compatibility** — the pre-computed content/search vectors are **768-dim**; our trend vectors are **1024-dim** (`arctic-embed-l-v2.0`). Not directly comparable — re-embed one side, or use the non-vector IAB/keyword path.

> ⚠️ **What's verified vs not.** Verified: these tables exist, are populated, are fresh (max
> dates = today), and a trend can be *joined* to them (smoke-tested on 3 real trends, see
> appendix). **Not** verified: that they're the blessed/canonical sources (some sit beside
> `_TEMP`/`_BACKUP` siblings), the embedding model behind the 768-dim vectors, join *quality*
> at scale, whether an ad-RPM/yield table exists, and whether `MCCLATCHY_EVAL` is the production
> account or a sandbox. Those are the data-team asks below.

Scan run 2026-06-03 via `snowsql`, role `MARKETING_ENGINEER`, account `WVB49304-MCCLATCHY_EVAL`.

---

## What our role can already read

| Database | Schema(s) of interest | Relevance |
|---|---|---|
| `MCC_RAW` | `GOOGLE_SEARCH_CONSOLE`, `STORY_DATA` | Search demand + SEO; published content + full text + vectors |
| `MCC_PRESENTATION` | `AUDIENCE_IDENTITY`, `TABLEAU_REPORTING`, `LIFESTYLE_ENTERTAINMENT`, `NAVIGA`, `AMPLITUDE` | Demographics/interests; content+traffic; revenue/subscriptions; web analytics |
| `MCC_CLEAN` | `NAVIGA_INSIGHT`, `AMPLITUDE` | Cleaned subscriber/engagement |
| `MCC_AMPLITUDE` | `AMPLITUDE` | Pageview/subscriber events |

All read today with our existing role — no new grant needed to *read* in this account.

---

## Per-field data sourcing

### 🟢 Confidence Score — buildable now, no external data

| | |
|---|---|
| **Needs** | source diversity, corroboration, signal volume, category confidence, recency |
| **Have (verified)** | `DT_TREND_DASHBOARD.{DISTINCT_SOURCE_COUNT, TOTAL_CLUSTER_SIZE, CATEGORY_CONFIDENCE, LOW_CONFIDENCE_FLAG, HEAT_INDEX}` — `DISTINCT_SOURCE_COUNT` + `TOTAL_CLUSTER_SIZE` on **217/217** live trends (avg 4.7 sources, 15.5 cluster), `CATEGORY_CONFIDENCE` 216/217, `PREDICTION_SCORE` 119. Distillation `CONFIDENCE` + `CLUSTER_SIZE` + `SOURCE_COUNT` confirmed on `FCT_PROMOTION_LEDGER`. |
| **Missing** | nothing data-wise — this is a **weighting + validation** problem |
| **Data-team ask** | none (internal). Editorial owns "what trustworthiness means" + a ground-truth set. |

> Doc drift note: `schema.md` lists `FCT_TRENDS.CONFIDENCE` / `TOTAL_CLUSTER_SIZE` /
> `DISTINCT_SOURCE_COUNT`, but the live `FCT_TRENDS` no longer carries them (14 cols, identity
> only). They're in the promotion ledger / derived in the dashboard. Build off the dashboard.

### 🟡 Content Gap — corpus exists (and the join works)

| | |
|---|---|
| **Needs** | our published-content corpus (topics + vectors) |
| **Have (verified)** | `MCC_RAW.STORY_DATA.PUBLISHED_STORIES` (**10.97M**, `HEADLINE`/`TOPICS_TAG`/`CATEGORY_TAG`/`URL`, 2016→today) · `MCC_RAW.STORY_DATA.CUE_CONTENT_PROCESSED` (**1.71M**, full `PLAINTEXT` on 67%, `IAB_TAXONOMY` on **95%**, `KEYWORDS`, `TOPIC`, →today) · `MCC_PRESENTATION.TABLEAU_REPORTING.CSA_CONTENT_LANDE` (**1.89M**, article + `PAGE_VIEWS`/`UNIQUES` by market/section) · `MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS` (876K, **768-dim** keyword vectors) |
| **Join test** | ✅ works — and surfaced a likely gap: **"gel nails" → near-zero published stories (narrow headline match) despite live search demand.** "fiber" 74 stories/90d, "zero-proof" 6/90d, both on-topic. |
| **Open decisions** | corpus choice (PUBLISHED_STORIES vs CUE vs CSA); gap metric (semantic distance vs recent-count); matching method (re-embed 1024 from `PLAINTEXT`, IAB-tag overlap, or keyword); time window |
| **Caveat** | corpus skews **local news**; lifestyle/consumer coverage is genuinely thinner → some "gaps" are real whitespace, some are corpus-mix. Validate before trusting a zero. |

### 🟡 AI Match % — the "CSA content library" is right here

| | |
|---|---|
| **Needs** | CSA content library with vectorized metadata |
| **Have (verified)** | `MCC_PRESENTATION.TABLEAU_REPORTING.CSA_CONTENT_LANDE` (the literal CSA library) + `CSA_CONTENT_TRACKER` · `CUE_CONTENT_VECTORS` (768-dim topical vectors, ready) · `CUE_CONTENT_PROCESSED` (IAB + full text, re-embeddable) |
| **The catch** | **768-dim vectors ≠ our 1024-dim.** Resolve by (a) re-embed content with `arctic-embed-l-v2.0` from `PLAINTEXT`, (b) re-embed trends at 768 to match their library, or (c) skip vectors, use IAB-tag overlap |
| **Open decisions** | which side re-embeds; threshold→percent curve; max-similarity vs collection-coverage; what a "Collection" maps to (CSA section / `CLUSTER_ID`?) |
| **Data-team ask** | embedding **model** behind the 768-dim vectors; what the Collections graph keys on |

### 🟡 Revenue Potential — GSC is already ingested (6.5B rows)

| | |
|---|---|
| **Needs** | search demand, content performance (traffic→revenue), RPM/yield by category |
| **Have (verified)** | `MCC_RAW.GOOGLE_SEARCH_CONSOLE.SEARCH_CONSOLE` (**6.49B rows**, `QUERY`/`CLICKS`/`IMPRESSIONS`/position by `DATA_DATE` + `SITE_URL`, 2024-09→2026-05-30, ~4-day lag) · `SEARCH_TERM_VECTORS` (143.9M, 768-dim) for semantic demand match · `DATAFORSEO` (1.34M, SERP rank/features + `SEARCH_CAT`) · `CSA_CONTENT_LANDE.PAGE_VIEWS`/`UNIQUES` + `TABLEAU_REPORTING.STORY_TRAFFIC_METRICS` (content performance) · `LIFESTYLE_ENTERTAINMENT.DIM_REVENUE_*` / `FCT_TRANSACTION_ITEMS_REVENUE_METRICS` (subscription revenue) · in-repo `FCT_TREND_GTRENDS_DAILY` (`INTEREST_PEAK_PCT`/`AVG_PCT`, 208 trends) |
| **Join test** | ✅ demand join works, per-paper via `SITE_URL`. ⚠️ polysemy: "fiber" was only **29% on-topic** (rest = fiber-optic/internet) → needs **semantic** matching, not `LIKE` |
| **Important** | GSC here is **first-party** (our 34 properties), not generic market volume — arguably better for revenue (it's clicks we actually capture), but frame it as "demand on our sites" |
| **Genuinely missing** | an explicit **ad-RPM / yield-by-category** table and a clean **pageviews→ad-revenue** bridge. Subscription revenue exists; ad yield is unconfirmed. The revenue *model* is the real open question. |

### 🟡 Audience Match — demographics + interests exist (per-publication works)

| | |
|---|---|
| **Needs** | audience/demographic profiles (per publication) + a trend→audience representation |
| **Have (verified)** | `MCC_PRESENTATION.AUDIENCE_IDENTITY`: `NAVIGA_SUBSCRIBERS_INTERESTS` (20.8K; ~80-interest survey taxonomy incl. `DIETING`/`HEALTHY_LIVING`/`COSMETICS`/`HEALTH_BEAUTY_PRODUCTS`/`COOKING`/`HOME_DECOR`, by `PRIMARY_MARKET`+status) · `NAVIGA_SUBSCRIBERS_DEMOS` (40.4K, demo survey by market) · `ZIP_INTERESTS` (38.2K ZIPs × ~80 interests) · `ZIP_ETHNICITY`/`ZIP_FINANCIAL`/`ZIP_HOUSEHOLD`/`ZIP_READING` · `IAB_CATEGORIES` (704-cat taxonomy) · `US_ZIP_CODES_WITH_LAT_LONG` (geo join) · `B2B_SIGNALS`/`B2C_SIGNALS` (mirrors our B2B/B2C names). Also `NAVIGA.SAI_DEMOGRAPHIC_*`, `AMPLITUDE.AMPLITUDE_EVENTS_DEMOGRAPHICS` |
| **Join test** | ✅ interest taxonomy aligns to our consumer trends, but **coarse** (~80 fixed buckets — "skincare" vs "nails" both collapse to `HEALTH_BEAUTY_PRODUCTS`; "fiber" → `DIETING`). IAB (704 cats) is finer but needs a trend→IAB step. **Per-publication is supported** via `PRIMARY_MARKET` (audience) / `SITE_URL` (GSC). |
| **Open decisions** | grain (ZIP-propensity vs subscriber-survey vs both); trend→interest mapping (category-rule vs IAB-via-content); "100% match" definition (editorial) |
| **Data-team ask** | ⚠️ **governance**: `AUDIENCE_IDENTITY` also holds raw PII (`EMAIL`/`PHONE`/`MAIDS`/`PII`). We'd use **only aggregated** ZIP/market tables — need sign-off. Confirm market crosswalk to trend `geographic_hotspots`. |

### 🟡 Overall Score — define last

Rollup of the four above. Trend Strength proxy = `HEAT_INDEX` (live). No new data; blocked on
the inputs being defined. Confirm input set, weights, band thresholds, missing-input behavior.

### 🧭 Reasoning-based related matching — no external data

Internal: our `TREND_VECTOR` + an LLM relatedness judgment. Optionally enrich with
`GOOGLE_SEARCH_CONSOLE.SEARCH_TERM_CLUSTER_DESCRIPTION`. Not blocked on the data team.

---

## Vector-match build (chosen direction — Content Gap & AI Match)

**Approach:** semantic vector match (not the IAB-code bridge — too coarse for subcategory
distinctions).

> **Decision (2026-06-03): start with Path A — reuse the data team's vectors.** Embed only the
> ~217 trends at `arctic-m-v1.5`/768 and cosine against the existing `CUE_CONTENT_VECTORS`
> (876K) — **no content-embedding job**. Accepts keyword-level (coarse) matching for now; the
> 143M `SEARCH_TERM_VECTORS` come along free for the demand side. **Upgrade path (B):** re-embed
> full `PLAINTEXT` at 768 for fine-grained matching, swappable without changing the field logic.
> The substrate/recipe/proof below describe that fuller fresh-embedding path (B/C) — Path A is
> the same minus the content-embedding table.

**Substrate (verified):**
- **Corpus:** `MCC_RAW.STORY_DATA.CUE_CONTENT_PROCESSED.PLAINTEXT` — full article bodies (avg ~3.8K chars), **~32K distinct articles in the last 90 days.** Coverage is partial (many rows are non-text CUE events) — filter to `PLAINTEXT IS NOT NULL AND LENGTH(PLAINTEXT) > 300`.
- **Embedder:** `SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', …)` — confirmed callable by our role, 1024-dim, fully in-warehouse (no external embedding service). The recipe re-embeds **both** sides through this same call, so trend and content vectors share one space by construction.

**Proof it works** (fiber trend, richer trend doc, deduped): vector cosine cleanly separates
on-topic from the polysemy noise `LIKE '%fiber%'` could not —

| article bucket | n | avg cosine | max |
|---|---|---|---|
| fiber **diet / gut / nutrition** | 20 | **0.28** | **0.47** |
| fiber optic / broadband | 6 | 0.14 | 0.19 |
| fiber other | 34 | 0.09 | 0.23 |

(Sanity: same-model "high fiber diet" ↔ "eating more fiber" = 0.65 vs ↔ "fiber optic cable" = 0.30.)

**Recipe:**
1. **Content vector table** — `CONTENTID → EMBED_TEXT_1024(plaintext)`, canonical + text-bearing, rolling window (start 90–180d ≈ 32–60K rows; backfill as budget allows). Carry `PUBLISHEDAT` + market + a `CSA_CONTENT_LANDE` pageviews join so Content Gap can weight by performance.
2. **Trend vector** — (re)embed each trend from a trend doc (topic + summary + drivers) into the same space, refreshed on enrichment.
3. **Content Gap** = nearest-content cosine per trend; "gap" = nothing above threshold in a recent window. **AI Match %** = same cosine → calibrated percent, aggregated to CSA section/collection.

**Decisions to lock:**
- **Model + dims.** The data team's 768 vectors are `arctic-m-v1.5` (fingerprinted) — *reusable* if we embed trends with that same model/dim (their 876K content + 143M search vectors come free), but they're keyword-level. For fine-grained, embed `PLAINTEXT` fresh: `arctic-m-v1.5`/768 to stay interoperable with the data team's vectors, or `arctic-l-v2`/1024 for max quality (isolated). For the **content** side you embed yourself regardless. The **trend** side, though, is now served reliably: `DT_TREND_DASHBOARD.TREND_VECTOR_ARCTIC_EMBED_L_V2_0` (added 2026-06-08, #37) exposes the canonical 1024-dim trend vector, and the dashboard CTE serves each trend's latest *non-NULL* vector — so all 250 live trends are populated (see the resolved NULL-write note below; the earlier "42% populated" figure was a point-in-time low during the May 20–28 NULL window). Dims are independent of fine-grained-ness; `arctic-l-v2` is Matryoshka, so 1024 truncates to 256 (¼ storage, ~lossless) if size matters.
- **Trend-doc construction is the real lever** — embedding a richer trend doc (topic + summary + drivers) rather than the bare topic phrase is what lifted matching. The `query:` prefix some e5/arctic variants use made **no difference** for `arctic-embed-l-v2.0` in a held-constant test (avg 0.26 plain vs 0.256 prefixed) — skip it.
- **Dedup** by `CONTENTID` — `ISCANONICAL` is useless (only 115 'true' rows); market-variants repeat the same article many times.
- **Chunk vs whole-article** — most fit arctic's 8K-token window whole; for genuinely *fine-grained* matching, chunk long articles into passages and take max-similarity.
- **History depth → Cortex cost.** Rolling 90-day window ≈ 32K articles ≈ **~30M tokens**; full-corpus backfill (~1.7M articles) ≈ **~1.5–2B tokens**. Embedding is among the cheapest Cortex functions (orders of magnitude under LLM calls), but the full backfill is the line item to price — decide rolling-window vs full-history up front.
- **Threshold calibration** (~0.4 separated the buckets here) and **refresh cadence**.

> **Separate bug surfaced (root-caused) — RESOLVED as of 2026-05-29:** `write-p_o7CWa2K`
> passed `NULL::ARRAY` as the vector arg to `PROC_ENRICHMENT_APPLY` while the enrichment agent
> emitted no embedding, so a window of `initial` rows wrote a NULL `TREND_VECTOR`. The fix —
> embed inline via Cortex (as `proc_promotion_apply` already does at
> `EMBED_TEXT_1024(... TREND_TOPIC ...)`) rather than rely on a caller-supplied vector — landed
> ~2026-05-29: `initial` rows have written non-NULL vectors every day since (verified
> 2026-06-08). The **92/217 (42%)** figure was the point-in-time low during the May 20–28 NULL
> window; today **250/250 live trends carry a current (absolute-latest) vector**, so
> `RELATED_TRENDS` and the new `TREND_VECTOR_ARCTIC_EMBED_L_V2_0` column are fully populated.
> (Note the dashboard already tolerated the gap: its `trend_vectors` CTE serves the latest
> *non-NULL* vector per trend, so coverage was always better than the raw row-level NULL rate.)

---

## Cross-cutting findings

- **Embedding split → resolved (model fingerprinted).** The pre-computed `CUE_CONTENT_VECTORS`/`SEARCH_TERM_VECTORS` are **`snowflake-arctic-embed-m-v1.5`** (768-dim), determined empirically — re-embedding the source text reproduces the stored vector at cosine 1.0 (vs 0.22 for e5-base). It is *not* a foreign space; it's a Cortex model we can call. Two valid paths: **(a)** match it — embed trends with `arctic-m-v1.5`/768 and reuse the data team's 876K content + 143M search vectors directly; or **(b)** go fine-grained + higher quality — re-embed `PLAINTEXT` at `arctic-l-v2`/1024 (isolated space). Caveat for (a): their content vectors are **keyword-level** (they embed the keywords list, not the body). See **Vector-match build**.
- **Don't standardize on v1.5 — keep two spaces by purpose.** Measured: `arctic-m-v1.5` compresses similarity (unrelated pairs ≈ 0.60 vs `arctic-l-v2`'s ≈ 0.32 — i.e. it sits *under* the live 0.65 related/cluster threshold) and is blind past ~512 tokens (identical vector for a 6K-char article and its first 1.8K). So keep the **internal pipeline** (signals, trend identity, `RELATED_TRENDS`, clustering, lifecycle neighbors) on `arctic-l-v2`/1024, and use `arctic-m-v1.5`/768 **only** as a per-trend companion for content/demand interop. If one org-wide space is ever wanted, standardize *up* on l-v2 (ask the data team to also emit l-v2 content vectors) — never down to v1.5.
- **IAB taxonomy is the connective tissue.** Content is 95% IAB-tagged; the audience side is IAB-shaped (`IAB_CATEGORIES`). A trend→IAB mapping (14 cats → IAB Tier1, e.g. food_beverage→"Food & Drink", wellness→"Healthy Living") gives a **vector-free** path for Content Gap, AI Match, and Audience Match.
- **Per-publication is real.** GSC `COMPANY` is just the corp parent (`MCCLATCHY`); the per-paper key is `SITE_URL` (34 papers) + `PRIMARY_MARKET` on the audience side. The doc's "global vs per-paper" question resolves to: **per-paper is fully supported.**
- **String matching is not enough.** Polysemous keywords ("fiber") drown in noise. The 768-dim search/content vectors (or our re-embedding) exist precisely to disambiguate — budget for semantic matching.
- **Corpus skews local news.** Real lifestyle coverage exists but is thinner than the trend mix; don't read every "zero coverage" as pure whitespace without a sanity check.

## What to ask the data team

1. **Canonical?** Are these the blessed production tables (vs the `_TEMP`/`_BACKUP`/dev siblings next to them)? Who owns refresh + SLA?
2. **Prod vs sandbox.** Confirm `MCCLATCHY_EVAL` is the production account (the name implies eval) and the Trend-Tree service role keeps read access there.
3. ~~Embedding model behind the 768-dim vectors~~ — **resolved ourselves: `snowflake-arctic-embed-m-v1.5`** (fingerprinted, cosine 1.0). It's a callable Cortex model, so the data team's 876K content + 143M search vectors are reusable if we match it. Still confirm refresh ownership/SLA + the content vectors' keyword-level grain.
4. **IAB as join key** — bless trend→IAB; does a topic→IAB crosswalk already exist, or do we build it?
5. **Ad-RPM / yield-by-category** — does a revenue-per-pageview / ad-yield table exist (ad server / Amplitude)? This is the one real gap for Revenue.
6. **PII governance** — sign-off to use aggregated `AUDIENCE_IDENTITY` ZIP/market tables.
7. **Why not in scope before?** (They may know of staleness/quality reasons we can't see.)

---

## Appendix — smoke-test evidence (3 trends, 2026-06-03)

Trends: **Fibermaxxing** (wellness, kw "high fiber diet"), **Couch Curing** (beauty, "DIY gel
nails"), **Zero-Proof Entertaining** (social_lifestyle, "Non-alcoholic cocktail parties").

**GSC demand** (`SEARCH_CONSOLE`, 2026-05-29→30, McClatchy properties):

| trend | impressions | distinct queries | papers | on-topic |
|---|---|---|---|---|
| fiber | 1,918 | 688 | 25 | only 549 (29%) — rest fiber-optic/internet |
| zero-proof | 1,636 | 228 | 14 | clean ("zero proof", "strawberry mocktail") |
| gel nails | 1,267 | 247 | 5 | clean ("gel nails ideas", "cherry red gel nails") |

**Content coverage** (`PUBLISHED_STORIES`, headline match):

| trend | all-time | last 90d |
|---|---|---|
| fiber | 1,106 | 74 |
| zero-proof | 334 | 6 |
| gel nails | **~0** | **~0** ← narrow match; demand-rich, content-poor = likely gap |

**Audience taxonomy alignment** — `ZIP_INTERESTS` / `NAVIGA_SUBSCRIBERS_INTERESTS` share an
~80-term interest set covering `DIETING`, `HEALTHY_LIVING`, `FITNESS`, `COOKING`, `EPICUREAN`,
`COSMETICS`, `HEALTH_BEAUTY_PRODUCTS`, `HOME_DECOR` — maps to our trends at category grain
(coarse), at both ZIP and subscriber level, by market.

(Smoke-test used simple string matching on purpose — the polysemy noise it exposed is the
argument for semantic matching in the real build.)

---

← Back to [Migrating Fields](migrating.md) · [hub](index.md)
