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

These fields come from the **Grok specialist** LLM step, which analyzes Bluesky social signals and broader cultural indicators. All are NULL when enrichment has not run or when the enrichment type was `SOURCES_ONLY`.

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `VOICE_OF_CUSTOMER` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | How real people are talking about this trend — sentiment, tone, common phrases, and emotional drivers drawn from social conversation. |
| `VIBE_SHIFT` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Whether public perception of this trend is shifting and in what direction. Captures emerging sentiment changes before they show up in search data. |
| `SOCIAL_NARRATIVE` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | The dominant story or framing people are using when discussing this trend online. |
| `CULTURAL_DRIVERS` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Underlying cultural forces, events, or movements fueling the trend. |
| `SEASONAL_RELEVANCE` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Whether and how the trend ties to seasonal patterns, holidays, or recurring cultural moments. |
| `GEOGRAPHIC_HOTSPOTS` | `VARCHAR` | `DIM_TREND_ENRICHMENT` | Regions or markets where the trend is strongest or emerging fastest. |

### Signals

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `TOP_SIGNALS` | `ARRAY` | `STG_TREND_SIGNALS` | Top 5 signals by PageRank score. Each element is an object with `title`, `url`, `source` (signal source name), and `pagerank_score` (rounded to 3 decimals). Ordered highest PageRank first. |

### Related trends

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `RELATED_TRENDS` | `VARIANT` | `V_TREND_TAXONOMY` | Vector-similarity related trends from the taxonomy view. Structure depends on the taxonomy view definition. |

### Freshness

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `ENRICHED_AT` | `TIMESTAMP` | `DIM_TREND_ENRICHMENT` | When the LLM enrichment pipeline last ran for this trend. NULL if the trend has never been enriched. |
