# V_TREND_DASHBOARD Field Reference

> **Database:** `MCC_PRESENTATION.TREND_AGENT`
>
> One row per trend. Each row powers one trend card in the dashboard UI.

## Source tables

| Alias | Table | Join |
|-------|-------|------|
| `m` | `FCT_TREND_METRICS` | Primary — every trend has a metrics row |
| `d` | `DIM_TREND_ENRICHMENT` | LEFT JOIN on `TREND_ID` — LLM-generated enrichment fields |
| `sm` | `FCT_TREND_SOURCE_METRICS` | Correlated subquery on `TREND_ID` — per-source headline metrics |
| `ts` | `STG_TREND_SIGNALS` | LEFT JOIN via CTE — top 5 signals by PageRank |
| `mt` | `MAP_TREND_MACROTRENDS` | LEFT JOIN via CTE — macrotrend tag array |
| `r` | `V_TREND_TAXONOMY` | LEFT JOIN — vector-similarity related trends |

---

## Fields

### Card header

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `TREND_ID` | `VARCHAR` (UUID) | `FCT_TREND_METRICS` | Primary key. Unique identifier for the trend cluster. |
| `TREND_NAME` | `VARCHAR` | Computed | Display name for the trend. Prefers `TREND_NAME_B2C` from enrichment, falls back to `TREND_NAME_B2B`, then raw `TREND_TOPIC` from metrics. |
| `TREND_NAME_B2B` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Business-oriented trend name produced by the Claude synthesizer. May be NULL if enrichment has not run. |
| `CATEGORY` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Top-level category assigned by the Gemini validation step (e.g. "Wellness", "Technology"). |
| `SUBCATEGORY` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Finer-grained classification within the category. |
| `MACROTREND_TAGS` | `ARRAY` | `MAP_TREND_MACROTRENDS` | Ordered array of macrotrend names this trend maps to, sorted by relevance score descending. |
| `SUMMARY_SHORT` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | One-liner summary suitable for card previews (~1 sentence). |
| `SUMMARY_LONG` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Multi-paragraph narrative summary from the Claude synthesizer. |
| `HEAT_INDEX` | `NUMBER(4,1)` | `FCT_TREND_METRICS` | Composite score (0-100) combining velocity, volume, and source breadth. Rounded to 1 decimal place. Higher = hotter trend. |
| `TOTAL_CLUSTER_SIZE` | `NUMBER` | `FCT_TREND_METRICS` | Total number of signals (articles, posts, data points) that make up this trend cluster. |
| `VELOCITY_DIRECTION` | `VARCHAR` | `FCT_TREND_METRICS` | Trajectory of the trend. Current values: `GROWING`, `STABLE`, `STAGNANT`, `DECLINING`. |

### Key data points

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `KEY_DATA_POINTS` | `ARRAY` | `FCT_TREND_SOURCE_METRICS` | Array of objects, one per source that has a non-zero headline metric. Each object contains `source` (source name, e.g. "google_trends"), `metric_name` (what the number represents, e.g. "search_interest"), and `metric_value` (the numeric value). Only sources with `HEADLINE_METRIC > 0` are included. |

### Cultural context

These fields come from the enrichment agent (Sonnet 4.6 single-agent loop). All are NULL when enrichment has not run.

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `SOCIAL_NARRATIVE` | `ARRAY` | `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:social_narrative` | 3-5 narrative bullets explaining why this is happening now. Each is `{point, evidence_url}`. |
| `CULTURAL_DRIVERS` | `ARRAY` | `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:cultural_drivers` | Underlying cultural forces, events, or movements fueling the trend. Each `{driver, influence_level: high/medium/low}`. |
| `SEASONAL_RELEVANCE` | `OBJECT` | `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:seasonal_relevance` | `{is_seasonal, peak_months?}` — whether and when the trend ties to seasonal patterns. |
| `GEOGRAPHIC_HOTSPOTS` | `ARRAY` | `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:geographic_hotspots` | Regions where the trend is strongest. Each `{region, intensity: high/medium/low}`. |
| `LOW_CONFIDENCE_FLAG` | `BOOLEAN` | Derived | `TRUE` when `category_confidence < 0.6`. Surfaces uncertain categorization in the UI. |

### Evidence (typed link pool)

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `EVIDENCE` | `ARRAY` | `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:evidence` | Typed pool of links — both pre-fetched signals the agent referenced and new tool-found links. Each entry: `{url, type, source, claim, captured_at, quote?, engagement?}`. `type` is one of `news \| social \| commerce \| reference \| search_volume \| video \| other`. Filter by type for dashboard sections (e.g. `WHERE type='social' AND quote IS NOT NULL` for voice-of-customer; `WHERE type IN ('news','commerce')` for hard proof). Legacy rows (pre-2026-04-28) project the older `social_proof` shape (`source_url`/`source_type`/`source_name`) under the same column via COALESCE — consumers should tolerate both shapes during cutover. |

### Signals

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `TOP_SIGNALS` | `ARRAY` | `STG_TREND_SIGNALS` | Top 5 signals by PageRank score. Each element is an object with `title`, `url`, `source` (signal source name), and `pagerank_score` (rounded to 3 decimals). Ordered highest PageRank first. |

### Related trends

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `RELATED_TRENDS` | `ARRAY` | `MAP_TREND_MACROTRENDS` | Trends sharing macrotrend tags (inlined from former V_TREND_TAXONOMY view). |

### Freshness

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `ENRICHED_AT` | `TIMESTAMP` | `DIM_TREND_ENRICHMENT` | When the LLM enrichment pipeline last ran for this trend. NULL if the trend has never been enriched. |
