<!-- Title: Data Contract -->
<!-- Parent: ATLAS Dashboard -->

**Audience:** Engineers consuming the Trend Tree Snowflake tables — the Insights Agent backend and the Trend Hunter B2C feed. (For the plain-English, strategist-facing card reference, see [ATLAS Dashboard — Field Reference](https://mcclatchy.atlassian.net/wiki/x/CgARdw).)

**Purpose:** The full column schema, type, meaning, and an example value for the two dynamic tables the downstream platforms read.

**Source of truth:** the table DDL in the Trend-Tree repo — `sql/dt_trend_dashboard.sql`, `sql/dt_trend_daily.sql`, `sql/dt_trend_connections.sql` (+ `sql/fct_trend_connections_ledger.sql`), `sql/task_recompute_content_matches.sql` (+ `sql/fct_trend_content_matches_ledger.sql`), `sql/fct_prediction_verdict_ledger.sql`. This page is the canonical engineer-facing schema reference. **Database:** `MCC_PRESENTATION.TREND_AGENT` · **Account:** `WVB49304-MCCLATCHY_EVAL`. **Last updated:** 2026-08-24.

**Example values are real, pulled 2026-06-08** — mostly from the live trend **Hyper-Tactile Interiors** (`c51f1620-a832-4f13-a443-a7df03bf6a99`). A few fields that are null for that trend (geographic hotspots, macrotrend tags, the social-evidence object) use a populated row from another live trend to show the shape. Column names and types are authoritative.

**Three tables, three questions.** `DT_TREND_DASHBOARD` answers _"what is this trend right now"_ — one row per trend, latest state. `DT_TREND_DAILY` answers _"how did it get here, day by day"_ — one row per `(TREND_ID, DAY)`. `DT_TREND_CONNECTIONS` answers _"which trends relate to each other"_ — one row per undirected trend pair, latest recompute. All three join on `TREND_ID` (`DT_TREND_CONNECTIONS` via `TREND_ID_A` / `TREND_ID_B`).

<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter><ac:parameter ac:name="exclude">See also</ac:parameter></ac:structured-macro>

---

## DT_TREND_DASHBOARD

One row per trend, joining trend identity, the latest enrichment payload, lifecycle state, and the current prediction verdict. Dynamic table, `TARGET_LAG = '15 minutes'`, `REFRESH_MODE = AUTO` on `TREND_AGENT_WH`.

**Never** `SELECT *`**.** Select columns explicitly so the \~4 KB/row `TREND_VECTOR_ARCTIC_EMBED_L_V2_0` doesn't ride into payloads that don't need it.

### Identity

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `TREND_ID` | VARCHAR | UUID. Stable across all enrichment and lifecycle runs. Universal join key. | `c51f1620-a832-4f13-a443-a7df03bf6a99` |
| `TREND_NAME` | VARCHAR | Singular canonical display name (ADR-0001, singular-name cutover 2026-05-27). COALESCE starts with singular `TREND_NAME`, then falls back to legacy B2C/B2B and topic. | `Hyper-Tactile Interiors` |
| `TREND_NAME_B2B` | VARCHAR | Retired legacy fallback (dual B2C/B2B scheme retired). Frozen at first enrichment. | `Sensory-First Home Furnishing` |

### Categorization

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `CATEGORY` | VARCHAR | One of 14: `wellness` `food_beverage` `beauty` `fitness` `fashion` `home_living` `sustainability` `consumer_tech` `personal_care` `social_lifestyle` `entertainment` `travel` `parenting` `other`. Frozen at first enrichment. | `home_living` |
| `SUBCATEGORY` | VARCHAR | Snake_case finer classification within the category. | `tactile_maximalism` |
| `CATEGORY_CONFIDENCE` | FLOAT | Enrichment agent's confidence. **0–1 scale** (⚠ not 0–100). | `0.95` |
| `LOW_CONFIDENCE_FLAG` | BOOLEAN | TRUE when `CATEGORY_CONFIDENCE < 0.6`. | `false` |

### Summaries

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `SUMMARY_SHORT` | VARCHAR | 1–2 sentences, action-oriented. Card-preview length. | `Consumers are swapping sleek minimalism for soft-edged interiors, prioritizing tactile materials like bouclé, fluted millwork, and curved furniture to create warm, inviting homes.` |
| `SUMMARY_LONG` | VARCHAR | One paragraph (≤500 chars). Card-detail length. | `Driven by a desire for comfort and authentic self-expression, homeowners are actively rejecting stark, clinical minimalism. Instead, they are investing in tactile and textured interior design, incorporating elements like rounded sofas, fluted wood paneling, and dimensional fabrics such as bouclé and rattan…` |

### Heat & lifecycle

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `HEAT_INDEX` | FLOAT | Smoothed heat, 0–100 (1dp). **The single latest evaluation** — the headline number. Reflects signal velocity, recency, source breadth. | `68.3` |
| `LIFECYCLE_STATUS` | VARCHAR | Current trajectory. Updated hourly by the lifecycle agent. Enum below. | `STABLE` |
| `VELOCITY_DIRECTION` | VARCHAR | Back-compat alias for `LIFECYCLE_STATUS` — same value, older name. | `STABLE` |

**Lifecycle stage enum** (expected progression is roughly linear):

| Stage | Meaning |
| --- | --- |
| `NEW` | Just promoted; first 24–48h, heat ≥ 60 |
| `GROWING` | Heat increasing; signal volume trending up |
| `STABLE` | Consistent heat; not accelerating or decelerating |
| `DECLINING` | Heat falling; signal volume tapering |
| `DORMANT` | Heat low and flat; signal volume thin |
| `RESURGENT` | Previously dormant; heat spiking again |
| `RETIRED` | Two consecutive retire proposals; signal volume flatlined |

### Cluster size

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `TOTAL_CLUSTER_SIZE` | NUMBER | Distinct signals linked to the trend. | `40` |
| `DISTINCT_SOURCE_COUNT` | NUMBER | Distinct **publisher domains** contributing (four GDELT articles from four publishers = 4). Higher = more credible. | `27` |
| `DISTINCT_PUBLISHER_COUNT` | NUMBER | Alias for `DISTINCT_SOURCE_COUNT` — same value, clearer name. | `27` |
| `ORIGINALLY_SURFACED_AT` | TIMESTAMP | When the trend first appeared in the distillation pipeline. | `2026-04-27T00:39:45Z` |

### Prediction (verdict projection)

Projected from the **latest active matched verdict per trend** in `FCT_PREDICTION_VERDICT_LEDGER` — the append-only ledger the prediction pillar's Cloud Run service writes on every evaluation. **Additive and isolated** — never read by `HEAT_INDEX`, `LIFECYCLE_STATUS`, or any other scoring path. See [Prediction (Score / Flag / Eligible)](https://mcclatchy.atlassian.net/wiki/x/GQAjdw).

> ⚠ **Semantics changed 2026-08-24 (CRMA-769). Names, types and ranges did not.**
>
> These three columns used to hold a deterministic emergence score — a week-over-week formula run daily over every trend old enough to divide. They now describe **the system's current call about the trend**: the calibrated confidence of the latest active, matched prediction, its banding, and whether such a prediction exists at all.
>
> The consequences, in order of how likely they are to bite:
>
> 1. **`NULL` means "no active call", not "scored low"** and not "too young to score". A trend reads `NULL` in all three whenever no active prediction currently matches it — which is most trends.
> 2. **`PREDICTION_ELIGIBLE` is `TRUE` or `NULL`, never `FALSE`.** It says "has an active queued prediction"; the pillar has no mechanism for saying no. `WHERE PREDICTION_ELIGIBLE` and `WHERE PREDICTION_ELIGIBLE IS NOT TRUE` keep working. **`WHERE PREDICTION_ELIGIBLE = FALSE` silently returns nothing** — it matched 490 of 506 trends before the cutover.
> 3. **The scored population shrinks and does not overlap the old one.** At cutover: 279 scored trends → 4, and none of the 4 were scored by the old formula (all were younger than its 14-day floor). Do not trend the mean score across the cutover — the population changed, not the scale. Measurements in [Prediction projection — shadow run](prediction-projection-shadow-run.md).
> 4. **White-space predictions — those matching no trend — reach no column here.** They are ledger-only in v1; read `FCT_PREDICTION_VERDICT_LEDGER` directly for them.
>
> The old `FCT_TREND_PREDICTION_LEDGER` is **frozen, not dropped** — v1/v2 history stays queryable and is fenced by `COMPUTATION_VERSION`.

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `PREDICTION_SCORE` | NUMBER(5,1) | Calibrated confidence of the current verdict, 0–100. **Not** an emergence score — it is how sure the system is of a specific falsifiable claim. `NULL` when no active matched prediction. | `72.0` |
| `PREDICTION_FLAG` | VARCHAR | Banding of `PREDICTION_SCORE`, thresholds unchanged: `Emerging` (40–65), `Watchlist` (65–80), `High Potential` (80+). `NULL` below 40 / NULL score. | `Watchlist` |
| `PREDICTION_ELIGIBLE` | BOOLEAN | `TRUE` = an active matched prediction exists, so the trend belongs in the Predictions Queue. `NULL` otherwise. **Never `FALSE`.** | `true` |

**One card per trend.** Several active predictions can match the same trend. The projection elects one: most recently evaluated, then most confident, then lowest `PREDICTION_ID` — a total order, so the dashboard does not flicker between them across refreshes. The others are **not suppressed**; they remain queryable in `FCT_PREDICTION_VERDICT_LEDGER` and continue to be re-evaluated. A trend's dashboard row is a summary of the system's strongest current call about it, not the complete set.

**Narrative columns (additive, 2026-08-24).** All from the same verdict as the three above, all `NULL` when no active matched prediction. Appended at the **end** of the row, after `NEAREST_CONTENT`, so the change is additive by ordinal position as well as by name. Listed here in the order a card reads them.

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `PREDICTION_CITED_EXAMPLES` | ARRAY | Up to 5 already-true source signals behind the call, in the order the agent cited them. Shape: `{ url, title, source }`. `NULL` — never an empty array — when the prediction cited nothing. | see shape below |
| `PREDICTION_CLAIM` | VARCHAR | The rendered claim sentence — the four frozen claim parts (subject, directional claim, horizon, observable check) composed in SQL, so the card states an explicit call. Never `NULL` when `PREDICTION_SCORE` is not: all four parts are `NOT NULL` on the ledger and frozen at mint. | `matcha perfume: prestige beauty retail listings for tea-gourmand fragrance profiles expand beyond indie perfume houses by Feb 2027, observable when Sephora US online catalog returns at least five distinct full-size eau de parfum or eau de toilette SKUs featuring 'matcha' in their title or primary scent profile.` |
| `PREDICTION_REASONING` | VARCHAR | The agent's rationale for this verdict. | `Gourmand tea notes satisfy consumer demand for comforting, subtle, wellness-adjacent skin scents…` |
| `PREDICTION_WHAT_CHANGED` | VARCHAR | What moved since the prior verdict on this prediction. `NULL` on a prediction's first mint — there was nothing to change from. | `Nothing moved since the previous evaluation: confidence held at 65.0…` |
| `PREDICTION_EVALUATED_AT` | TIMESTAMP | When this verdict was written. | `2026-08-24T19:10:43Z` |
| `PREDICTION_ANGLE` | VARCHAR | One sentence, reader-facing, on why this change matters culturally. **Nullable** — a run where the model declined to narrate still mints its predictions. | `Fragrance buyers are turning away from heavy florals and musks toward calming, tea-inspired gourmands that feel like subtle skin scents.` |
| `PREDICTION_AUDIENCE_QUESTION` | VARCHAR | The question this call invites us to put to readers. **Nullable**, same reason. | `Have you noticed perfume scents shifting toward calming beverages like matcha and milky tea blends?` |

```json
[
  {
    "url":    "https://x.com/SmallFeetHeat/status/2088639975361245438",
    "title":  "@SmallFeetHeat: The author posts about being on the hunt for a good matcha fragrance.",
    "source": "x.com"
  },
  {
    "url":    "https://dearaugustfragrance.com/en-us/blogs/news/2026-fragrance-trends-the-perfume-styles-to-know-this-year",
    "title":  "Refined Gourmand Fragrance Preference",
    "source": "dearaugustfragrance.com"
  }
]
```

**Render examples above the claim.** The card leads with what is already true and then states the call — the evidence is what makes a prediction readable. On live data 2 predictions in 20 cite nothing; those render **without** an examples block rather than with an empty one, and are never suppressed for it. `url` is absent (not empty, not a placeholder) on the rare citation that resolves to no public link, so render an unlinked citation rather than a dead one.

**Nothing here feeds the score.** `PREDICTION_ANGLE`, `PREDICTION_AUDIENCE_QUESTION`, `PREDICTION_CITED_EXAMPLES`, `PREDICTION_REASONING` and `PREDICTION_WHAT_CHANGED` are readable context. None is read by `PREDICTION_SCORE` / `_FLAG` / `_ELIGIBLE`, nor by the ordering that decides which verdict wins a trend. The only mechanical gate anywhere in the pillar is the mint-time data-quality floor, and it lives in the service, not here.

**The rest of `EVIDENCE` stays in the ledger.** `EVIDENCE:source_signals` is the one key that projects. `saturation`, `trend_context` and `coverage` are readable only from `FCT_PREDICTION_VERDICT_LEDGER` — deliberately, because `trend_context` holds the four measures the retired scorer gated on and projecting them is how they would find their way back into a filter.

### Source metrics

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `KEY_DATA_POINTS` | ARRAY | Latest Google Trends pull's interest scalars. One object per metric: `{ source, metric_name, metric_value }`. Empty array if no gtrends row. | see shape below |

```json
[
  { "source": "google_trends", "metric_name": "interest_peak_pct", "metric_value": 100 },
  { "source": "google_trends", "metric_name": "interest_avg_pct",  "metric_value": 1.6 }
]
```

### Cultural narrative

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `SOCIAL_NARRATIVE` | ARRAY | 3–5 bullets on why this is happening now. Shape: `{ point, evidence_url }`. | `[{"point":"Consumers are openly rejecting 'clinical minimalism' and 'cool greys' in favor of warmth.","evidence_url":"https://bsky.app/profile/livingfinds.com/post/…"}]` |
| `CULTURAL_DRIVERS` | ARRAY | Underlying forces: `{ driver, influence_level }`. Level is `high\|medium\|low`. | `[{"driver":"Desire for emotional grounding and warmth in living spaces after years of sterile minimal designs.","influence_level":"high"}]` |
| `SEASONAL_RELEVANCE` | OBJECT | `{ is_seasonal, peak_months? }`. | `{"is_seasonal":false}` |
| `GEOGRAPHIC_HOTSPOTS` | ARRAY | `{ region, intensity }`. Intensity is `high\|medium\|low`. Empty array when not geographically concentrated (as it is for this trend). | `[{"region":"United States","intensity":"high"},{"region":"United Kingdom","intensity":"medium"}]` _(other trend)_ |

### Evidence pools

The enrichment agent produces a typed pool of links. The dashboard pre-buckets it for direct rendering:

| Column | Type | Contents / best for |
| --- | --- | --- |
| `EVIDENCE` | ARRAY | Full pool, unsplit. When you need all evidence in one pass. |
| `GENERAL_EVIDENCE` | ARRAY | `type IN ('news','commerce')` — hard proof: articles, product pages. |
| `SOCIAL_EVIDENCE` | ARRAY | `type = 'social'` — voice-of-customer: posts with quotes + engagement. |
| `OTHER_EVIDENCE` | ARRAY | `type IN ('reference','search_volume','video','other')` — background. |

**Evidence object shape** (a real `social` entry — `quote` and `engagement` are present only on social):

```json
{
  "url":         "https://bsky.app/profile/livingfinds.com/post/bsky_3b2883ceea068666",
  "type":        "social",
  "source":      "@livingfinds.com",
  "claim":       "Social consensus that limewash is a trending, eco-friendly way to add earthy character to walls.",
  "captured_at": "2026-05-23T14:15:26Z",
  "quote":       "Limewash paint is trending because it's impossibly forgiving — the more uneven, the better. Made from crushed limestone, eco-friendly… Designers say earthy, rooted colors are the 2026 direction.",
  "engagement":  { "likes": 0, "reposts": 0 }
}
```

**Type enum:** `news` · `social` · `commerce` · `reference` · `search_volume` · `video` · `other`.

**Legacy key compatibility:** pre-2026-04-28 rows use `source_url` / `source_type` / `source_name` instead of `url` / `type` / `source`. `COALESCE` both shapes when reading.

### Relationships & embedding

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `RELATED_TRENDS` | ARRAY | Top-5 semantically similar trends, cosine desc. Shape: `{ trend_id, trend_name, category, similarity }`. Threshold ≥ 0.65; empty array if none. | `[{"trend_id":"971f85f1-…","trend_name":"Silk & Subtract","category":"home_living","similarity":0.6911}]` |
| `MACROTREND_TAGS` | ARRAY | Higher-level theme labels the trend rolls into. Often null (rebuild pending). | `["Frictionless On-The-Go"]` _(other trend)_ |
| `TREND_VECTOR_ARCTIC_EMBED_L_V2_0` | VECTOR(FLOAT, 1024) | Canonical trend embedding (`snowflake-arctic-embed-l-v2.0`), latest enrichment vector scoped to live `FCT_TRENDS`. `NULL` if no enrichment vector. Powers the Trend Hunter B2C feed recommender (distances / clusters / per-user aggregate vectors). The 768-dim GSC space is **not** exposed. | `[0.0123, -0.0456, …]` (1024 floats) |

**Embedding ownership (Trend Hunter B2C).** McClatchy owns this canonical vector space; Trend Hunter builds the per-user vector as an aggregate of these trend vectors so it lives in our space by construction. The model is encoded in the column name; the underlying ledger column stays `TREND_VECTOR`. A model swap / re-embed / retrain will be signalled by changing the wire-facing column name (its `_ARCTIC_EMBED_L_V2_0` suffix is the version marker).

### Content match

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `NEAREST_CONTENT` | ARRAY | Top-5 nearest published-content matches (McClatchy's own coverage), cosine desc. Shape: `{ content_id, headline, published_date, score }`. `NULL` if nothing cleared the match threshold (an under-covered trend) or the trend is newer than the latest recompute — never an empty-but-present array. | `[{"content_id":316756311,"headline":"Dollar Store's protein snacks are starting to win over budget-conscious shoppers…","published_date":"2026-07-08","score":0.677}]` |

**Separate vector space from `TREND_VECTOR_ARCTIC_EMBED_L_V2_0` above.** `NEAREST_CONTENT` is powered by a 768-dim `snowflake-arctic-embed-m-v1.5` companion vector (trend name + short summary), cosined against the data team's existing `MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS.KEY_WORDS_VECTOR` — the same space the data team already embeds published content into, reused as-is (no content re-embedding). This is deliberately isolated from the 1024-dim `arctic-embed-l-v2.0` internal trend-identity space; the two are never compared. Recomputed daily by the `MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES` Snowflake task (CRMA-452) into `FCT_TREND_CONTENT_MATCHES_LEDGER`, which this dashboard reads for the latest generation only (same "latest `CHAIN_ID`" pattern as `DT_TREND_CONNECTIONS`). Calibrated cosine threshold **0.60**, rolling content window **180 days**, top **5** matches per trend — see `sql/task_recompute_content_matches.sql` for the calibration readout.

This is the vector-match **substrate** only — it does not yet feed a Content Gap metric or an AI Match % score (those are separate, forward-looking fields).

### Timestamps & provenance

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `ENRICHED_AT` | TIMESTAMP | When the current enrichment payload was written. | `2026-05-27T04:06:37Z` |
| `LAST_LIFECYCLE_EVAL_AT` | TIMESTAMP | When lifecycle last evaluated this trend. | `2026-06-08T09:10:12Z` |
| `RETIREMENT_REASON` | VARCHAR | Why a RETIRED trend was retired. `NULL` otherwise. | `null` |
| `TREND_SOURCE` | VARCHAR | Provenance of the trend row. | `fct_trends` |

### Deprecated columns

Kept while the front end migrates. **New work should target the replacement columns.**

| Deprecated | Replacement | Notes |
| --- | --- | --- |
| `SOCIAL_PROOF` | `GENERAL_EVIDENCE` | NULL on new-shape rows |
| `VOICE_OF_CUSTOMER` | `SOCIAL_EVIDENCE` | NULL on new-shape rows |
| `VIBE_SHIFT` | `SUMMARY_SHORT` | NULL on new-shape rows |
| `TOP_SIGNALS` | `EVIDENCE` (first 5 news/commerce/social) | Legacy shape: `{ title, url, source }` |
| `NAME_CANDIDATES_CONSIDERED` / `NAME_REVIEWER` | — | Naming-audit metadata; not for display |

---

## DT_TREND_DAILY

One clean row per `(TREND_ID, DAY)` of trend history — the time-series companion to the dashboard. Backs the Trend Hunter B2C `score_timeseries` graph, `week_high` / `week_low`, and the week-over-week momentum badge. Dynamic table, `TARGET_LAG = '18 hours'`, `REFRESH_MODE = FULL` on `TREND_AGENT_WH`. \~7,400 rows (≈250 trends × ≈6 weeks). No backfill job — Snowflake builds full history on creation.

_Example values below are the_ `2026-06-08` _row for the same trend (_`Hyper-Tactile Interiors`_)._

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `TREND_ID` | VARCHAR | Grain part. Join key to `FCT_TRENDS` / `DT_TREND_DASHBOARD`. | `c51f1620-a832-4f13-a443-a7df03bf6a99` |
| `DAY` | DATE | Grain part. One row per calendar day from the trend's first activity through `CURRENT_DATE`. Dense — no day skipped, so the 7-day `LAG` is exactly one week. | `2026-06-08` |
| `HEAT_INDEX` | NUMBER(\_,1) | Daily **MAX** of the smoothed heat, carry-forward gap-filled. Never null on/after the first lifecycle eval. | `69.6` |
| `SIGNAL_COUNT` | NUMBER | Cumulative distinct signals linked as of this day (each attributed to its first-link day). Monotonic, backfill-immune. | `40` |
| `SOURCE_COUNT` | NUMBER | Same, for distinct **publisher domains** (not source-platform names). | `27` |
| `NEW_SIGNALS_TODAY` | NUMBER | Distinct signals whose first link landed on this day (`0` on quiet days). | `0` |
| `HEAT_WOW_PCT` | NUMBER(\_,1) | **Velocity-as-percent** — first difference over 7 days: `(HEAT − LAG(HEAT,7)) / LAG(HEAT,7) × 100`. `NULL` in first 7 days and when the 7-day-ago value was 0. | `13.0` |
| `SIGNAL_WOW_PCT` | NUMBER(\_,1) | Same formula on `SIGNAL_COUNT`. | `8.1` |

`HEAT_INDEX` **here ≠** `DT_TREND_DASHBOARD.HEAT_INDEX`**, on purpose.** This is the daily **MAX** of the hourly smoothed series (the graph line); the dashboard's is the single **latest evaluation** (the headline). They differ within a day by design — e.g. for `Hyper-Tactile Interiors` on 2026-06-08 the dashboard reads **68.3** while this table reads **69.6**. Trend Hunter sources the headline from the dashboard, the graph line from here.

`HEAT_WOW_PCT` **≠** `INPUT_ACCELERATION`**.** `HEAT_WOW_PCT` is a _first_ difference ("how fast"); the prediction ledger's `INPUT_ACCELERATION` is a _second_ difference ("speeding up or slowing down"). Keep them separate.

`week_high` / `week_low` and `score_timeseries` are **documented queries** over this table, not stored columns — pure trailing windows with no drift risk:

```sql
-- score_timeseries: the heat graph line for one trend
SELECT DAY, HEAT_INDEX
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DAILY
WHERE TREND_ID = :trend_id
ORDER BY DAY;

-- week_high / week_low: trailing-7-day heat band, per day
SELECT DAY, HEAT_INDEX,
       MAX(HEAT_INDEX) OVER (ORDER BY DAY ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS WEEK_HIGH,
       MIN(HEAT_INDEX) OVER (ORDER BY DAY ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS WEEK_LOW
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DAILY
WHERE TREND_ID = :trend_id
ORDER BY DAY;
```

---

## DT_TREND_CONNECTIONS

One row per **undirected** trend pair — the cross-trend similarity surface backing the Insights Agent **Connections** page (formerly "Collections"). Dynamic table, `TARGET_LAG = '15 minutes'`, `REFRESH_MODE = AUTO` on `TREND_AGENT_WH`. Exposes **only the latest recompute generation**; the append-only history lives in `FCT_TREND_CONNECTIONS_LEDGER` underneath.

This replaces Atlas's in-container `trend_correlations` table (which embedded trend text with MiniLM-384 and ran the cosine matrix in-process). Edges are now computed pipeline-side over the higher-quality 1024-dim `snowflake-arctic-embed-l-v2.0` trend vectors and recomputed daily by the `MARKETING_TASK_RECOMPUTE_CONNECTIONS` Snowflake task (each run reads the latest vector per trend, so new and re-enriched trends are picked up automatically).

**Many-to-many:** a trend id appears as `TREND_ID_A` or `TREND_ID_B` in up to **8** rows (`MAX_EDGES_PER_TREND`, keeping the highest-scoring edges) — a single trend can participate in many connections.

_Example values below are a real cross-category edge from the 2026-06-10 recompute: **Crock Awakening** (food_beverage) ↔ **Fibermaxxing** (wellness)._

| Column | Type | What it is | Example value |
| --- | --- | --- | --- |
| `TREND_ID_A` | VARCHAR | Lower trend id of the undirected pair (`TREND_ID_A < TREND_ID_B`, no self-pairs). Join key to `DT_TREND_DASHBOARD`. | `9ff11688-d2f6-4747-a321-4adb756b125e` |
| `TREND_ID_B` | VARCHAR | Higher trend id of the pair. Join key to `DT_TREND_DASHBOARD`. | `a2676910-edb2-41f5-8bfa-6b4fce5d1b7d` |
| `SCORE` | FLOAT | `VECTOR_COSINE_SIMILARITY` of the two trends' latest vectors, 4dp. Higher = more similar. | `0.5915` |
| `CATEGORY_A` | VARCHAR | Frozen `FCT_TRENDS.CATEGORY` of `TREND_ID_A` (the 14-value enum above). | `food_beverage` |
| `CATEGORY_B` | VARCHAR | Frozen `FCT_TRENDS.CATEGORY` of `TREND_ID_B`. | `wellness` |

**Category-aware thresholds.** An edge is kept when `SCORE ≥ 0.62` for same-category pairs, or `SCORE ≥ 0.45` for cross-category pairs (a lower bar so the prized cross-category connections — e.g. wellness ↔ food_beverage — surface while same-category noise is suppressed). These are calibrated for the arctic-1024 space and are **not** Atlas's old MiniLM-384 constants (0.55 / 0.38).

```sql
-- All connections for one trend (it can sit on either side of the pair)
SELECT TREND_ID_A, TREND_ID_B, SCORE, CATEGORY_A, CATEGORY_B
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_CONNECTIONS
WHERE :trend_id IN (TREND_ID_A, TREND_ID_B)
ORDER BY SCORE DESC;

-- Cross-category connections only (the cross-pollination view)
SELECT * FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_CONNECTIONS
WHERE CATEGORY_A <> CATEGORY_B
ORDER BY SCORE DESC;
```

> **Isolated from `RELATED_TRENDS`.** `DT_TREND_DASHBOARD.RELATED_TRENDS` (top-5, flat ≥ 0.65) and `DT_TREND_CONNECTIONS` (category-aware, capped, undirected) are computed separately for now and may differ; reconcile deliberately rather than assume they match.

---

## See also

* [ATLAS Dashboard — Field Reference](https://mcclatchy.atlassian.net/wiki/x/CgARdw) — plain-English, strategist-facing version of the dashboard fields.
* [Prediction (Score / Flag / Eligible)](https://mcclatchy.atlassian.net/wiki/x/GQAjdw) — what the three retained columns mean now, in plain English.
* [Prediction projection — shadow run](prediction-projection-shadow-run.md) — the before/after measurements behind the 2026-08-24 semantics change.
