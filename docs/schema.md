# Trend Tree — Schema Reference

**Database:** `MCC_PRESENTATION.TREND_AGENT` · **Account:** `WVB49304-MCCLATCHY_EVAL`

Start with `DT_TREND_DASHBOARD` (the Trend Dashboard) — it's the right starting point for almost any consumer of this data. The supporting tables below explain what it draws from.

---

## DT_TREND_DASHBOARD

A dynamic table joining trend identity, enrichment payload, and lifecycle state into one row per trend. Refreshes every 15 minutes on `TREND_AGENT_WH`. **136 rows** as of 2026-04-30.

```sql
-- Top trends right now
SELECT TREND_NAME, CATEGORY, HEAT_INDEX, LIFECYCLE_STATUS,
       SUMMARY_SHORT, DISTINCT_SOURCE_COUNT
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE LIFECYCLE_STATUS != 'RETIRED'
ORDER BY HEAT_INDEX DESC
LIMIT 20;
```

### Identity

| Column | Type | Notes |
|---|---|---|
| `TREND_ID` | VARCHAR | UUID. Stable across all enrichment and lifecycle runs. Use as join key to all ledger tables. |
| `TREND_NAME` | VARCHAR | Display name. Prefers `TREND_NAME_B2C`, falls back to `TREND_NAME_B2B` then `TREND_TOPIC`. |
| `TREND_NAME_B2B` | VARCHAR | Business/sponsorship-pitch name. Frozen at first enrichment. |
| `TREND_TOPIC` | VARCHAR | Agent-originated noun-verb phrase from distillation (e.g. "Honey-note gourmand fragrances surging as the new feminine scent direction"). |

### Categorization

| Column | Type | Notes |
|---|---|---|
| `CATEGORY` | VARCHAR | One of 14 values: `wellness` `food_beverage` `beauty` `fitness` `fashion` `home_living` `sustainability` `consumer_tech` `personal_care` `social_lifestyle` `entertainment` `travel` `parenting` `other`. Frozen at first enrichment. |
| `SUBCATEGORY` | VARCHAR | Snake_case finer classification within the category (e.g. `mineral_sunscreen`, `gourmand_fragrance`). |
| `CATEGORY_CONFIDENCE` | FLOAT | Enrichment agent's confidence score (0–1). |
| `LOW_CONFIDENCE_FLAG` | BOOLEAN | TRUE when `CATEGORY_CONFIDENCE < 0.6`. |

### Summaries

| Column | Type | Notes |
|---|---|---|
| `SUMMARY_SHORT` | VARCHAR | 1–2 sentences, action-oriented. Card-preview length. |
| `SUMMARY_LONG` | VARCHAR | One paragraph (≤500 chars). Card-detail length. |

### Heat & lifecycle status

| Column | Type | Notes |
|---|---|---|
| `HEAT_INDEX` | FLOAT | Smoothed heat score, 0–100 scale (rounded to 1dp). Reflects signal velocity, recency, and source breadth. |
| `HEAT_INDEX_SMOOTHED` | FLOAT | EWMA-smoothed heat (α=0.3) from the lifecycle ledger. Prevents single-day spikes from flipping a trend's status. |
| `LIFECYCLE_STATUS` | VARCHAR | Current status. Updated hourly by the lifecycle agent. See enum below. |
| `VELOCITY_DIRECTION` | VARCHAR | Alias for `LIFECYCLE_STATUS` — kept for legacy compatibility. |

**Lifecycle stage enum** (expected progression is roughly linear; skipping multiple stages in one evaluation is unexpected):

| Stage | Meaning |
|---|---|
| `NEW` | Just promoted; first 24–48h, heat ≥ 60 |
| `GROWING` | Heat increasing; signal volume trending up |
| `STABLE` | Consistent heat; not accelerating or decelerating |
| `DECLINING` | Heat falling; signal volume tapering |
| `DORMANT` | Heat low and flat; signal volume thin |
| `RESURGENT` | Previously dormant; heat spiking again |
| `RETIRED` | Two consecutive lifecycle proposals to retire; signal volume flatlined |

### Cluster size

| Column | Type | Notes |
|---|---|---|
| `TOTAL_CLUSTER_SIZE` | NUMBER | Distinct supporting signals in the trend's founding cluster. |
| `DISTINCT_SOURCE_COUNT` | NUMBER | Distinct source families that contributed (e.g. 3 = news + social + commerce). Higher = more credible. |
| `ORIGINALLY_SURFACED_AT` | TIMESTAMP | When the trend first appeared in the distillation pipeline. |

### Source metrics

| Column | Type | Notes |
|---|---|---|
| `KEY_DATA_POINTS` | ARRAY | One object per source with a non-zero headline metric: `{ source, metric_name, metric_value }`. Use for per-source numerics on the card. |

Example: `[{"source":"gdelt","metric_name":"article_count_7d","metric_value":142}, {"source":"bluesky","metric_name":"post_count_3d","metric_value":27}]`

### Cultural narrative

| Column | Type | Notes |
|---|---|---|
| `SOCIAL_NARRATIVE` | ARRAY | 3–5 narrative bullets explaining why this trend is happening now. Shape: `{ point, evidence_url }`. |
| `CULTURAL_DRIVERS` | ARRAY | Underlying forces: `{ driver, influence_level }`. `influence_level` is `high \| medium \| low`. |
| `SEASONAL_RELEVANCE` | OBJECT | `{ is_seasonal: bool, peak_months?: string[] }` |
| `GEOGRAPHIC_HOTSPOTS` | ARRAY | `{ region, intensity }`. `intensity` is `high \| medium \| low`. |

### Evidence pools

The enrichment agent produces a typed pool of links. The dashboard pre-buckets it into three columns for direct rendering:

| Column | Contents | Best for |
|---|---|---|
| `GENERAL_EVIDENCE` | `type IN ('news', 'commerce')` | Hard proof — articles, product pages |
| `SOCIAL_EVIDENCE` | `type = 'social'` | Voice-of-customer — posts with quotes + engagement |
| `OTHER_EVIDENCE` | `type IN ('reference', 'search_volume', 'video', 'other')` | Background — Wikipedia, Google Trends, video |
| `EVIDENCE` | Full pool, unsplit | When you need all evidence in one pass |

**Evidence object shape:**

```json
{
  "url":         "https://...",
  "type":        "news",
  "source":      "Forbes",
  "claim":       "What this evidence shows",
  "captured_at": "2026-04-28T14:23:00Z",
  "quote":       "verbatim post text (type=social only)",
  "engagement":  { "likes": 45, "reposts": 12 }
}
```

**Type enum:**

| Type | Meaning | Examples |
|---|---|---|
| `news` | News articles | Forbes, NYT, Vogue, trade press |
| `social` | Named posts / threads with optional quote + engagement | Bluesky, X, Threads |
| `commerce` | Product pages, retailer listings, brand sites | Amazon listing, Sephora PDP |
| `reference` | Encyclopedic background | Wikipedia, expert blogs |
| `search_volume` | Interest signals | Google Trends, Wikimedia traffic |
| `video` | Short-form / long-form video | TikTok, YouTube, Reels |
| `other` | Catch-all; should be rare | — |

**Legacy key compatibility:** Pre-2026-04-28 enrichment rows use `source_url` / `source_type` / `source_name` instead of `url` / `type` / `source`. Handle both shapes:

```sql
COALESCE(item:url::STRING,    item:source_url::STRING)  AS url,
COALESCE(item:type::STRING,   item:source_type::STRING) AS type,
COALESCE(item:source::STRING, item:source_name::STRING) AS source
```

### Related trends

| Column | Type | Notes |
|---|---|---|
| `RELATED_TRENDS` | ARRAY | Top-5 semantically similar trends, ordered by cosine similarity descending. Shape: `{ trend_id, trend_name, category, similarity_score }`. Threshold ≥ 0.65; returns empty array if no match. Computed via `VECTOR_COSINE_SIMILARITY` on `FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR`. |

### Deprecated columns

Kept while the front end migrates to the new evidence pool shape. **New work should target the replacement columns.**

| Deprecated column | Replacement | Notes |
|---|---|---|
| `SOCIAL_PROOF` | `GENERAL_EVIDENCE` | NULL on new-shape rows |
| `VOICE_OF_CUSTOMER` | `SOCIAL_EVIDENCE` | NULL on new-shape rows |
| `VIBE_SHIFT` | `SUMMARY_SHORT` | NULL on new-shape rows |
| `TOP_SIGNALS` | `EVIDENCE` (first 5 of type news/commerce/social) | Legacy shape: `{ title, url, source }` |
| `MACROTREND_TAGS` | TBD | Pending macrotrend story rebuild |

### More quick-start queries

```sql
-- Trends in a specific category
SELECT TREND_NAME, HEAT_INDEX, LIFECYCLE_STATUS, SUMMARY_SHORT
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE CATEGORY = 'wellness'
  AND LIFECYCLE_STATUS != 'RETIRED'
ORDER BY HEAT_INDEX DESC;

-- Trends with social voice-of-customer content
SELECT TREND_NAME, CATEGORY,
       f.value:source::STRING AS social_source,
       f.value:claim::STRING  AS claim,
       f.value:quote::STRING  AS quote
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD,
     LATERAL FLATTEN(input => SOCIAL_EVIDENCE) f
WHERE LIFECYCLE_STATUS != 'RETIRED'
ORDER BY HEAT_INDEX DESC;

-- Recent lifecycle status changes
SELECT t.TREND_NAME, l.PRIOR_STATUS, l.NEW_STATUS,
       l.NEW_HEAT_SMOOTHED, l.EVALUATED_AT, l.REASONING
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
JOIN MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD t USING (TREND_ID)
WHERE l.PRIOR_STATUS != l.NEW_STATUS
ORDER BY l.EVALUATED_AT DESC
LIMIT 20;

-- Enrichment audit trail for one trend
SELECT WRITTEN_AT, ENRICHMENT_KIND,
       PAYLOAD:trend_name_b2c::STRING AS name_b2c,
       PAYLOAD:summary_short::STRING  AS summary
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID = '<uuid>'
ORDER BY WRITTEN_AT DESC;
```

### Refresh and maintenance

Dynamic table with `TARGET_LAG = '15 minutes'`, `REFRESH_MODE = AUTO` (resolves to FULL), on `TREND_AGENT_WH`. Force a refresh:

```sql
ALTER DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD REFRESH;
```

Inspect refresh history:

```sql
SELECT NAME, STATE, REFRESH_ACTION, REFRESH_START_TIME, REFRESH_END_TIME
FROM TABLE(INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
  NAME => 'MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD'))
ORDER BY REFRESH_START_TIME DESC LIMIT 10;
```

Source pipeline:
```
FCT_TRENDS                       (one row per agent-promoted trend)
  ├─ FCT_TREND_LIFECYCLE_LEDGER  (latest lifecycle status + heat)
  ├─ FCT_TREND_ENRICHMENT_LEDGER (latest enrichment payload — typed evidence pool)
  ├─ FCT_TREND_SOURCE_METRICS    (per-source headline metrics)
  └─ FCT_PROMOTION_LEDGER        (cluster + source counts at promotion)
```

---

## Supporting tables

### FCT_TRENDS — trend identity

One row per trend. Slim and immutable: set once at promotion, frozen after first enrichment. All mutable state (heat, status, enrichment payload, signals) lives in sibling ledgers.

| Column | Notes |
|---|---|
| `TREND_ID` | UUID. Universal join key. |
| `TREND_TOPIC` | Agent's noun-verb topic phrase from distillation. |
| `TREND_NAME_B2B` / `TREND_NAME_B2C` | Set once by first enrichment; frozen after. |
| `CATEGORY` / `SUBCATEGORY` | Set once by first enrichment; frozen after. |
| `GTRENDS_KEYWORD` | LLM-derived 2–3 word Google Trends search query. |
| `DETECTED_AT` | When distillation first surfaced it. |
| `PROMOTED_AT` | When promotion wrote the FCT_TRENDS row. |
| `TOTAL_CLUSTER_SIZE` | Signal count from the founding candidate. |
| `DISTINCT_SOURCE_COUNT` | Source family count from the founding candidate. |
| `CONFIDENCE` | Distillation subagent confidence score (0–1). |

### FCT_TREND_ENRICHMENT_LEDGER — enrichment runs

Every enrichment run, full payload + 1024-dim trend vector. Append-only. **Current state = latest row by `WRITTEN_AT` per trend.**

| Column | Notes |
|---|---|
| `ENRICHMENT_ID` | PK (UUID) |
| `TREND_ID` | Join key |
| `WRITTEN_AT` | Timestamp of this run |
| `ENRICHMENT_KIND` | `promotion_seed` (at creation) / `initial` (first full run) / `refinement` (lifecycle-requested update) |
| `PAYLOAD` | VARIANT — full enrichment output: names, category, summaries, cultural narrative, evidence array |
| `TREND_VECTOR` | VECTOR(FLOAT, 1024) — semantic embedding at this point in time |
| `MODEL_USED` | e.g. `claude-sonnet-4-6` |
| `LLM_COST_ESTIMATE` | Estimated USD cost for this run |

### FCT_TREND_LIFECYCLE_LEDGER — lifecycle evaluations

Every status evaluation with before/after diff. Append-only. **Current state = latest row by `EVALUATED_AT` per trend.** Two-cycle retirement confirm: a trend is only retired when two consecutive evaluations both propose RETIRE.

| Column | Notes |
|---|---|
| `LIFECYCLE_EVAL_ID` | PK (UUID) |
| `TREND_ID` | Join key |
| `EVALUATED_AT` | Timestamp of this evaluation |
| `PRIOR_STATUS` / `NEW_STATUS` | Status before and after this eval |
| `PRIOR_HEAT` / `NEW_HEAT` | Raw heat before and after |
| `NEW_HEAT_SMOOTHED` | EWMA-smoothed heat (α=0.3) used by dashboard |
| `HEAT_BASE` | Pure-SQL baseline from recency, velocity, breadth |
| `HEAT_MODIFIER_PCT` | Agent-emitted adjustment in [−20, 20] |
| `REASONING` | Agent rationale (≤500 chars) |
| `REQUESTED_RE_ENRICHMENT` | BOOLEAN — TRUE if this eval triggered a description rewrite |

### FCT_TREND_SOURCE_METRICS — per-source headline metrics

One row per (trend, source). Populated ahead of each enrichment run by `sources-p_7NCy36w`. Adding a new source requires no DDL — just a new `SOURCE_NAME` value.

| Column | Notes |
|---|---|
| `TREND_ID` | PK part |
| `SOURCE_NAME` | PK part — e.g. `gdelt` `bluesky` `google_trends` `amazon` `tiktok` `pinterest` |
| `HEADLINE_METRIC` | One comparable number per source (article count, post count, etc.) |
| `HEADLINE_METRIC_NAME` | What the metric represents (e.g. `article_count_7d`, `pageviews_7d`) |
| `METRICS` | VARIANT — full source-specific payload |

### FCT_TREND_SIGNALS — trend ↔ signal link table

One row per (trend, signal, link_kind). Maintained by `TASK_PROMOTE_TREND_SIGNALS` (5-min cadence).

| Column | Notes |
|---|---|
| `TREND_ID` | PK part |
| `SIGNAL_ID` | PK part. For URL sources, this *is* the URL. |
| `LINK_KIND` | `supporting` (founding cluster) or `evidence` (enrichment citations) — *where it came from* |
| `LINK_TYPE` | `news` / `social` / `commerce` / `reference` / `search_volume` / `video` / `other` — *what role it plays* |
| `LINKED_AT` | Insertion timestamp |

### FCT_SIGNALS — canonical embedded signals

One row per signal. Maintained by `TASK_PROMOTE_SIGNALS_TO_FCT` (5-min cadence) from `STG_EXTERNAL_SIGNALS`.

| Column | Notes |
|---|---|
| `SIGNAL_ID` | PK. Same key in STG, FCT_SIGNALS, and FCT_TREND_SIGNALS. For URL sources, this *is* the URL. |
| `SOURCE_NAME` | Signal origin |
| `SIGNAL_TIMESTAMP` | When the signal was published |
| `SIGNAL_TITLE` / `SIGNAL_TEXT` | Title and body |
| `SIGNAL_VECTOR` | VECTOR(FLOAT, 1024) — Cortex `arctic-embed-l-v2.0` over title + first 512 chars of body |
| `EMBEDDED_AT` | When the TASK promoted this row |

Semantic search example:
```sql
SELECT SIGNAL_ID, SOURCE_NAME, SIGNAL_TITLE,
       VECTOR_COSINE_SIMILARITY(SIGNAL_VECTOR, :query_vector) AS similarity
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
ORDER BY similarity DESC
LIMIT 20;
```

---

## Raw / staging zone

`MCC_RAW.MARKETING_DEV` holds mutable working state. Most consumers don't need these tables directly.

- **`STG_EXTERNAL_SIGNALS`** — Landing zone for every inbound signal. Mutable claim state via `AGENT_SESSION_ID` (NULL = unclaimed). ~9% duplicate SIGNAL_IDs over 3 days (non-canonical URL variants). Promoted to `FCT_SIGNALS` every 5 minutes.
- **`STG_TREND_CANDIDATES`** — Distillation output, awaiting promotion. Each row is one candidate trend with `SUPPORTING_SIGNAL_IDS` (ARRAY), `VERDICT` (`REAL_TREND` / `NOISE` / `DUPLICATE_OF_<id>`), and `REASONING`.

For raw/staging column detail, see git history for the retired `docs/data_model.md`.

---

## Cross-cutting design notes

1. **Append-only ledgers.** Every FCT table is append-only. "Current state" means the latest row by timestamp per trend. Nothing is ever updated or deleted.

2. **Soft foreign keys.** No FK constraints enforced in Snowflake. `FCT_TREND_SIGNALS` may reference `SIGNAL_ID`s not yet in `FCT_SIGNALS` (5-min TASK lag is intentional).

3. **`SIGNAL_ID` is the universal signal key.** Same value across `STG_EXTERNAL_SIGNALS`, `FCT_SIGNALS`, and `FCT_TREND_SIGNALS`. For URL-shaped sources, `SIGNAL_ID` *is* the canonical URL.

4. **Each agent owns one ledger.** Promotion → `FCT_PROMOTION_LEDGER`. Enrichment → `FCT_TREND_ENRICHMENT_LEDGER`. Lifecycle → `FCT_TREND_LIFECYCLE_LEDGER`. No agent overwrites another's history.

5. **No cross-database reads at refresh time.** All objects `DT_TREND_DASHBOARD` references live in `MCC_PRESENTATION.TREND_AGENT`. The 5-min TASKs are the only bridge from `MCC_RAW`.

---

## See also

- [`README.md`](../README.md) — narrative overview and pipeline flow.
- [`architecture.md`](architecture.md) — Pipedream workflow inventory and debugging guide.
