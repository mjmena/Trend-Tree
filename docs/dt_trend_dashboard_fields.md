# DT_TREND_DASHBOARD Field Reference

> **Database:** `MCC_PRESENTATION.TREND_AGENT`
> **Type:** Dynamic table — refreshes automatically with `TARGET_LAG = '15 minutes'` on `WAREHOUSE = TREND_AGENT_WH`. One row per agent-promoted trend (sourced exclusively from `FCT_TRENDS`). To force a refresh: `ALTER DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD REFRESH;`. To rebuild from `sql/dt_trend_dashboard.sql`: drop first, then run the file.

This is the canonical surface for the trend dashboard. Each row powers one trend card.

## Source pipeline

```
FCT_TRENDS                       (one row per agent-promoted trend)
  ├─ FCT_TREND_LIFECYCLE_LEDGER  (latest lifecycle status + heat index)
  ├─ FCT_TREND_ENRICHMENT_LEDGER (latest enrichment-agent payload — typed evidence pool)
  ├─ FCT_TREND_SOURCE_METRICS    (per-source headline metrics)
  ├─ FCT_PROMOTION_LEDGER        (cluster + source counts at promotion / merge)
  └─ MAP_TREND_MACROTRENDS       (macrotrend tags + neighbors — deprecated)
```

---

## 1. Identity

| Column | Type | Description |
|--------|------|-------------|
| `TREND_ID` | `VARCHAR` (UUID) | Primary key. Stable across enrichment runs. |
| `TREND_NAME` | `VARCHAR` | Display name. Prefers `TREND_NAME_B2C` from `FCT_TRENDS` (frozen at first enrichment), falls back to B2B then `TREND_TOPIC`. |
| `TREND_NAME_B2B` | `VARCHAR` | Business-oriented name from the enrichment agent. Frozen at first run. |

## 2. Categorization

| Column | Type | Description |
|--------|------|-------------|
| `CATEGORY` | `VARCHAR` | One of 14 enums: `wellness, food_beverage, beauty, fitness, fashion, home_living, sustainability, consumer_tech, personal_care, social_lifestyle, entertainment, travel, parenting, other`. |
| `SUBCATEGORY` | `VARCHAR` | Snake_case finer classification within the category. |

## 3. Summaries

| Column | Type | Description |
|--------|------|-------------|
| `SUMMARY_SHORT` | `VARCHAR` | 1-2 sentences, action-oriented. Card-preview length. |
| `SUMMARY_LONG` | `VARCHAR` | One paragraph (≤500 chars), action-oriented. Card-detail length. |

## 4. Cluster + lifecycle

| Column | Type | Description |
|--------|------|-------------|
| `HEAT_INDEX` | `FLOAT` (rounded 1dp) | Smoothed heat from the lifecycle ledger. 0-100 scale. |
| `TOTAL_CLUSTER_SIZE` | `NUMBER` | Distinct supporting signal count from the candidate. |
| `DISTINCT_SOURCE_COUNT` | `NUMBER` | Distinct number of sources (gdelt, bluesky, amazon, etc.) that contributed to the cluster. |
| `LIFECYCLE_STATUS` | `VARCHAR` | One of `NEW, GROWING, STABLE, DORMANT, RESURGENT, RETIRED`. From the latest lifecycle-ledger row. |
| `VELOCITY_DIRECTION` | `VARCHAR` | Same value as `LIFECYCLE_STATUS` — alias kept for legacy compatibility. |

## 5. Source metrics

| Column | Type | Description |
|--------|------|-------------|
| `KEY_DATA_POINTS` | `ARRAY` | One object per source with a non-zero headline metric: `{ source, metric_name, metric_value }`. Use to display per-source numerics on the card (e.g. "Wikipedia: 3,945 pageviews/7d"). |

## 6. Cultural narrative

| Column | Type | Description |
|--------|------|-------------|
| `SOCIAL_NARRATIVE` | `ARRAY` of `{ point, evidence_url }` | 3-5 narrative bullets explaining why this trend is happening now. Each bullet may reference a URL from one of the evidence pools. |
| `CULTURAL_DRIVERS` | `ARRAY` of `{ driver, influence_level }` | Underlying cultural forces. `influence_level` is `high \| medium \| low`. |
| `SEASONAL_RELEVANCE` | `OBJECT` `{ is_seasonal, peak_months? }` | Boolean + optional list of peak months. |
| `GEOGRAPHIC_HOTSPOTS` | `ARRAY` of `{ region, intensity }` | Regions where the trend is strongest. `intensity` is `high \| medium \| low`. |

## 7. Evidence (pre-bucketed typed link pools)

The enrichment agent produces a typed pool of links — both pre-fetched cluster signals it engaged with and new finds via Grok/Bluesky/Google Trends. The pool is split into three pre-bucketed columns for direct rendering on the dashboard.

All three columns share the same object shape:

```json
{
  "url":         "https://...",                 // required — click-through URL
  "type":        "news",                        // required — see enum below
  "source":      "Forbes",                      // required — outlet, handle, retailer
  "claim":       "What this evidence shows",    // required — one-line description
  "captured_at": "2026-04-28T...",              // required — ISO timestamp
  "quote":       "verbatim post text",          // optional — type=social only
  "engagement":  { "likes": 45, "reposts": 12 } // optional — type=social only
}
```

Type enum:

| Type | Meaning | Examples |
|---|---|---|
| `news` | News articles | Forbes, NYT, Vogue, trade press |
| `social` | A specific named post or thread (with optional `quote` + `engagement`) | Bluesky, X, Threads |
| `commerce` | Product page / retailer listing / brand site | Amazon listing, Sephora PDP |
| `reference` | Background / encyclopedic — not direct proof | Wikipedia, expert blogs |
| `search_volume` | Interest signal — query/explore URLs | Google Trends, Wikimedia traffic |
| `video` | Short-form / long-form video | TikTok, YouTube, Reels |
| `other` | Catch-all — should be rare | — |

### `GENERAL_EVIDENCE` — `type IN ('news', 'commerce')`

Hard proof. Articles + product/retailer pages. The "this is real" section of the card.
Same object shape; `quote`/`engagement` typically null.

### `SOCIAL_EVIDENCE` — `type = 'social'`

Voice-of-customer + cultural-conversation. Posts with verbatim text + engagement counts.
Same object shape; `quote` and `engagement` typically populated.

### `OTHER_EVIDENCE` — `type IN ('reference', 'search_volume', 'video', 'other')`

Background / supporting context. Wikipedia for definitions, Google Trends for interest signal, video aggregators, etc.
Same object shape.

### Legacy compatibility note

Pre-2026-04-28 enrichment rows have legacy field names: `source_url` instead of `url`, `source_type` instead of `type`, `source_name` instead of `source`. The view's COALESCE buckets legacy rows into the right column based on `source_type`, but the **inner object keys are still legacy** until those trends re-enrich. To handle both shapes:

```sql
COALESCE(item:url::STRING,    item:source_url::STRING)  AS url,
COALESCE(item:type::STRING,   item:source_type::STRING) AS type,
COALESCE(item:source::STRING, item:source_name::STRING) AS source
```

---

## 8. Deprecated columns (kept while front end migrates)

These are the previous-generation columns the dashboard still reads. Each has a typed-pool replacement; once the front end ships against the new pools we'll drop these from the snapshot. **New work should target the replacements, not these columns.**

| Deprecated column | Replacement | Notes |
|---|---|---|
| `SOCIAL_PROOF` | `GENERAL_EVIDENCE` | Old `social_proof` array. NULL on new-shape rows. |
| `VOICE_OF_CUSTOMER` | `SOCIAL_EVIDENCE` (filter `quote IS NOT NULL`) | Old VoC quote array. NULL on new-shape rows. |
| `VIBE_SHIFT` | `SUMMARY_SHORT` | Single-sentence narrative shift. Overlapped with summary. NULL on new-shape rows. |
| `TOP_SIGNALS` | one of the typed evidence pools (TBD) | Top 5 raw signals from `STG_TREND_SIGNALS`. Currently NULL for all agent-promoted trends because that legacy table isn't populated by the agent pipeline. |
| `MACROTREND_TAGS` | TBD | Macrotrend tags from `MAP_TREND_MACROTRENDS`. To be replaced once the macrotrend story is rebuilt. |
| `RELATED_TRENDS` | TBD | Trend IDs sharing macrotrend tags. Same — pending replacement. |

---

## Refresh cadence

Dynamic table on `TARGET_LAG = '15 minutes'`, refreshed by Snowflake on `WAREHOUSE = TREND_AGENT_WH`. `REFRESH_MODE = AUTO` resolved to `FULL` because the SELECT contains subqueries (the `KEY_DATA_POINTS` lateral against `FCT_TREND_SOURCE_METRICS`); incremental tracking isn't supported there. Force a refresh with:

```sql
ALTER DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD REFRESH;
```

Inspect history:

```sql
SELECT NAME, STATE, REFRESH_ACTION, REFRESH_START_TIME, REFRESH_END_TIME
FROM TABLE(INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
  NAME => 'MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD'))
ORDER BY REFRESH_START_TIME DESC LIMIT 10;
```

The dynamic table is owned by `MCC_PRESENTATION_TREND_AGENT_SFULL` (the schema-managed role McClatchy uses for managed-access ownership). Refresh runs under that role only — every source object the dashboard reads must live in `MCC_PRESENTATION.TREND_AGENT`. The pre-2026-04-28 cross-database read into `MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES` was eliminated by sourcing cluster + source aggregates from `FCT_PROMOTION_LEDGER` instead.
