# Snowflake Schema Reference

Account: `WVB49304-MCCLATCHY_EVAL`

---

## MCC_RAW.MARKETING_DEV

### DT_LLM_TREND_EMBEDDINGS (9,501 rows)
Embeddings for LLM-detected trend signals. Auto-refreshing dynamic table.

| Column | Type | Notes |
|---|---|---|
| INGESTION_ID | NUMBER | FK to STG_LLM_PROMPT_LOGS |
| URL | TEXT | Signal URL |
| TITLE | TEXT | Article/signal title |
| DESCRIPTION | TEXT | Article/signal description |
| SIGNAL_TYPE | TEXT(3) | NOT NULL |
| SIGNAL_NAME | TEXT(100) | Publisher/source name |
| DETECTED_AT | TIMESTAMP_NTZ | |
| TITLE_VECTOR | VECTOR | 1024-dim embedding |
| DESCRIPTION_VECTOR | VECTOR | 1024-dim embedding |

### DT_EXTERNAL_TREND_EMBEDDINGS (196 rows)
Embeddings for Google Trends + external signals. Auto-refreshing dynamic table. Only includes trends classified as relevant by `STG_GOOGLE_TREND_RELEVANCE`. Deduped on URL (oldest wins), 3-day window.

| Column | Type | Notes |
|---|---|---|
| URL | TEXT | Article URL (or MD5 hash of title if no URL) |
| TITLE | TEXT | Article title |
| DESCRIPTION | TEXT | Concatenated context string |
| SIGNAL_TYPE | TEXT | `GT` (Google Trends) or `EXT` (external) |
| SIGNAL_NAME | TEXT | News source name (not 'GOOGLE_TRENDS') |
| SOURCE_TREND_ID | NUMBER | FK to STG_GOOGLE_TRENDS.TREND_ID (NULL for EXT) |
| DETECTED_AT | TIMESTAMP_NTZ | |
| TITLE_VECTOR | VECTOR | 1024-dim embedding (reused as DESCRIPTION_VECTOR) |
| DESCRIPTION_VECTOR | VECTOR | 1024-dim embedding (same as TITLE_VECTOR) |

### STG_LLM_PROMPT_LOGS (2,515 rows)
Audit log for all LLM calls made by the pipeline.

| Column | Type | Notes |
|---|---|---|
| INGESTION_ID | NUMBER | PK |
| CREATED_AT_UTC | TIMESTAMP_NTZ | |
| MODEL_NAME | TEXT(100) | |
| PROVIDER | TEXT(50) | |
| PROMPT_TOKENS | NUMBER | |
| COMPLETION_TOKENS | NUMBER | |
| TOTAL_TOKENS | NUMBER | |
| LATENCY_MS | NUMBER | |
| PROMPT | VARIANT | |
| RESPONSE | VARIANT | |
| USAGE_CONTEXT | TEXT(255) | |
| METADATA | VARIANT | |

### STG_GOOGLE_TRENDS (13,374 rows)
Raw Google Trends ingestion via Pipedream.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | NUMBER | Unique ID via SEQ_GOOGLE_TRENDS_ID sequence |
| TREND_TITLE | TEXT | Google Trend search term |
| APPROX_TRAFFIC | TEXT | Traffic volume string |
| PUB_DATE | TIMESTAMP_NTZ | |
| NEWS_ITEMS | VARIANT | Array of {article_title, url, source} objects |
| INSERTED_AT | TIMESTAMP_NTZ | DEFAULT CURRENT_TIMESTAMP() |

### STG_GOOGLE_TREND_RELEVANCE (1,393 rows)
LLM classification of Google Trend titles. Each TREND_ID classified exactly once by Cortex mistral-7b. Only ~5% pass as relevant niche consumer/lifestyle trends.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | NUMBER | PK, FK to STG_GOOGLE_TRENDS |
| TREND_TITLE | TEXT | |
| IS_RELEVANT | BOOLEAN | TRUE = niche/monetizable consumer trend |
| LLM_RESPONSE | TEXT | Raw model response |
| CLASSIFIED_AT | TIMESTAMP_NTZ | DEFAULT CURRENT_TIMESTAMP() |

### STG_EXTERNAL_SIGNALS
External signals staging for Amazon, Pinterest, TikTok, Bluesky, GDELT.

| Column | Type | Notes |
|---|---|---|
| SIGNAL_ID | TEXT | PK |
| SOURCE_NAME | TEXT | e.g. amazon_movers, pinterest, tiktok |
| SIGNAL_TITLE | TEXT | |
| SIGNAL_TEXT | TEXT | |
| SIGNAL_TIMESTAMP | TIMESTAMP_NTZ | |
| METADATA | VARIANT | Source-specific fields (asin, department, price, etc.) |

### STG_ENRICHMENT_QUEUE
Work queue coordinating Pipedream enrichment workflows. Populated by `TASK_QUEUE_ENRICHMENT`; consumed by the Pipedream SQL trigger (`source_trend_changes.sql`).

| Column | Type | Notes |
|---|---|---|
| TREND_ID | VARCHAR | PK |
| TREND_TOPIC | VARCHAR | |
| ENRICHMENT_TYPE | VARCHAR | `FULL` / `SOURCES_ONLY` / `REFRESH` — requested type |
| PRIORITY | NUMBER | 0-100, higher = process first |
| QUEUED_AT | TIMESTAMP_NTZ | |
| STARTED_AT | TIMESTAMP_NTZ | Set to IN_PROGRESS timestamp |
| COMPLETED_AT | TIMESTAMP_NTZ | |
| STATUS | VARCHAR | `PENDING` / `IN_PROGRESS` / `COMPLETED` / `FAILED` |
| ERROR_MESSAGE | VARCHAR | Failure details (max 500 chars) |
| RETRY_COUNT | NUMBER | Max 3 retries for FAILED items |
| ENRICHMENT_TIER | VARCHAR | What actually ran: `FULL` / `GATED` / `SOURCES_ONLY` |
| LLM_TOTAL_TOKENS | NUMBER | Actual tokens used in this run |
| LLM_COST_ESTIMATE | FLOAT | Actual estimated USD cost |
| DURATION_SECONDS | NUMBER | Wall-clock time from start to completion |

### STG_SURVEY_RESPONSES (22,003 rows)
Survey response data.

### Tasks

- **TASK_CLASSIFY_GOOGLE_TRENDS** — Hourly, classifies new TREND_IDs into STG_GOOGLE_TREND_RELEVANCE. Currently suspended (needs `EXECUTE TASK` privilege).
- **TASK_CLUSTER_TRENDS** — Hourly, calls PROC_CLUSTER_TRENDS. Runs after TASK_CLASSIFY_GOOGLE_TRENDS.
- **TASK_QUEUE_ENRICHMENT** — Chained, runs after TASK_CLUSTER_TRENDS. Detects trends needing enrichment (NEW/UPDATED/STALE_SOURCES). MERGEs into STG_ENRICHMENT_QUEUE with type and priority.
- **TASK_AGGREGATE_AMAZON** — Chained, runs after TASK_QUEUE_ENRICHMENT. Calls PROC_AGGREGATE_AMAZON.
### Procedures

- **PROC_CLUSTER_TRENDS** — Snowpark Python. Louvain community detection + PageRank + LLM-reasoned historical matching (Cortex llama3.1-70b). Merge prompt enforces specificity with scaled skepticism by trend size. Excludes superseded trends from merge candidates.
- **PROC_SPLIT_TREND(TREND_ID)** — Snowpark Python. Splits an over-broad trend into sub-trends. Re-runs Louvain at higher threshold (0.72) and resolution (2.0). Children require ≥ 3 signals and ≥ 2 distinct sources. Parent gets VELOCITY_DIRECTION = 'SUPERSEDED'. Children are queued for full enrichment.
- **PROC_AGGREGATE_AMAZON** — Aggregates Amazon Movers & Shakers data into source metrics.
- **PROC_DEDUP_TRENDS** — Finds and merges duplicate trends using vector similarity + LLM confirmation.

---

## MCC_PRESENTATION.TREND_AGENT

Production presentation layer — authoritative output served to consumers.

### STG_TREND_SIGNALS (766 rows)
Granular signal-to-trend mapping with graph centrality scores.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | TEXT | FK to FCT_TREND_METRICS |
| URL | TEXT | |
| TITLE | TEXT | |
| SIGNAL_NAME | TEXT | Source/publisher name |
| DOMAIN | TEXT | Parsed host from URL |
| DETECTED_AT | TIMESTAMP_NTZ | |
| INGESTION_ID | TEXT | |
| PAGERANK_SCORE | FLOAT | Graph centrality score |
| ADDED_AT | TIMESTAMP_NTZ | DEFAULT CURRENT_TIMESTAMP |

### FCT_TREND_METRICS
One row per trend with aggregated metrics.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | TEXT | PK |
| TREND_VECTOR | VECTOR | Weighted centroid of cluster signals |
| TREND_TOPIC | TEXT | Leader signal title |
| DETECTED_AT | TIMESTAMP_NTZ | |
| LAST_UPDATE_AT | TIMESTAMP_NTZ | |
| TREND_DURATION_HR | FLOAT | |
| TOTAL_CLUSTER_SIZE | NUMBER | |
| SIGNAL_CHANGE | FLOAT | % change vs prior snapshot |
| DISTINCT_SOURCE_COUNT | NUMBER | |
| AVG_SIMILARITY | FLOAT | |
| VELOCITY_DIRECTION | TEXT | NEW / GROWING / STABLE / DECLINING / STAGNANT / SUPERSEDED |
| SIGNALS_PER_SOURCE | FLOAT | |
| TREND_HEAT_INDEX | FLOAT | Composite 0-100 score |
| STATUS | TEXT | DEFAULT 'ACTIVE' (legacy, not actively used) |
| CATEGORY | TEXT | Legacy — superseded by DIM_TREND_ENRICHMENT.CATEGORY |
| CONFIDENCE | FLOAT | Legacy — superseded by DIM_TREND_ENRICHMENT.CONFIDENCE_SCORE |
| SUMMARY | TEXT | Legacy — superseded by DIM_TREND_ENRICHMENT.SUMMARY |
| PARENT_TREND_ID | TEXT | FK to self — set on child trends from PROC_SPLIT_TREND |

### FCT_TREND_DAILY_SNAPSHOTS (359 rows)
Daily signal and source counts per trend.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | TEXT | PK (with SNAPSHOT_DATE) |
| SNAPSHOT_DATE | DATE | PK |
| SIGNAL_COUNT | NUMBER | Cumulative signals as of date |
| SOURCE_COUNT | NUMBER | Cumulative sources as of date |
| NEW_SIGNALS_TODAY | NUMBER | |
| NEW_SOURCES_TODAY | NUMBER | |

### FCT_TREND_SOURCE_METRICS
Normalized source enrichment data — one row per trend per source. Populated by `enrich_trend.mjs` orchestrator. Adding a new source requires no DDL changes, just a new SOURCE_NAME value.

| Column | Type | Notes |
|---|---|---|
| TREND_ID | VARCHAR | PK (with SOURCE_NAME) |
| SOURCE_NAME | VARCHAR | PK — `gdelt`, `wikimedia`, `bluesky`, `google_trends`, `amazon`, `pinterest`, `tiktok` |
| HEADLINE_METRIC | FLOAT | One comparable number per source (article count, pageviews, post count, etc.) |
| HEADLINE_METRIC_NAME | VARCHAR | What HEADLINE_METRIC represents (`article_count_7d`, `pageviews_7d`, etc.) |
| METRICS | VARIANT | Full source-specific payload — schema varies by source |
| ENRICHED_AT | TIMESTAMP_NTZ | |
| ENRICHMENT_VERSION | NUMBER | |

**Example queries:**
- All sources for a trend: `SELECT * FROM FCT_TREND_SOURCE_METRICS WHERE TREND_ID = :id`
- Source coverage: `SELECT COUNT(*) FROM FCT_TREND_SOURCE_METRICS WHERE TREND_ID = :id`
- Cross-source comparison: `SELECT SOURCE_NAME, HEADLINE_METRIC FROM FCT_TREND_SOURCE_METRICS WHERE TREND_ID = :id ORDER BY HEADLINE_METRIC DESC`
- Specific source field: `SELECT METRICS:pageviews_7d FROM FCT_TREND_SOURCE_METRICS WHERE TREND_ID = :id AND SOURCE_NAME = 'wikimedia'`

### FCT_TREND_ENRICHMENT_HISTORY
Daily point-in-time snapshots of enrichment metrics. One row per trend per day. PK: (TREND_ID, SNAPSHOT_DATE).

| Column | Type | Notes |
|---|---|---|
| SOURCE_METRICS_SNAPSHOT | VARIANT | `{source_name: {headline_metric, headline_metric_name}}` at point in time |
| SOURCE_COVERAGE_BREADTH | NUMBER | How many sources had data |
| LLM metrics | LIFECYCLE_STAGE, CATEGORY, IS_VALID_TREND, CONFIDENCE_SCORE, SPONSORSHIP_FIT_SCORE, TREND_COMMERCIAL_SCORE, BRAND_ASSOCIATION_COUNT, MODEL_AGREEMENT_SCORE | LLM assessment snapshot |
| Cost | LLM_TOTAL_TOKENS, LLM_COST_ESTIMATE | Cost per enrichment run |

### DIM_TREND_ENRICHMENT
Multi-LLM enriched trend metadata. Populated by enrichment workflow (specialist + synthesizer pattern: Gemini, Grok, ChatGPT → Claude synthesizer). PK: TREND_ID.

| Column Group | Columns | Source |
|---|---|---|
| **Core identity** | TREND_NAME, SUMMARY, CATEGORY, SUBCATEGORY, LIFECYCLE_STAGE, IS_VALID_TREND, CONFIDENCE_SCORE | Claude (consensus) |
| **Composite scores** | TREND_COMMERCIAL_SCORE (0-100), SOURCE_COVERAGE_BREADTH (0-7) | Computed in write step |
| **Audience targeting** | TARGET_DEMOGRAPHICS (VARIANT), TARGET_PSYCHOGRAPHICS (VARIANT), AUDIENCE_PERSONAS (VARIANT), PURCHASE_INTENT_SIGNALS (VARIANT) | Claude |
| **Brand strategy** | BRAND_ASSOCIATIONS (VARIANT), PRODUCT_CATEGORIES (VARIANT), COMPETITOR_LANDSCAPE (VARIANT), SPONSORSHIP_FIT_SCORE, MONETIZATION_ANGLES (VARIANT) | Claude + Gemini (competitors) |
| **Content strategy** | CONTENT_ANGLES (VARIANT), SOCIAL_HOOKS (VARIANT), SPONSORED_CONTENT_IDEAS (VARIANT), STEPPS_ANALYSIS (VARIANT), HASHTAG_STRATEGY (VARIANT) | ChatGPT |
| **Cultural context** | VOICE_OF_CUSTOMER (VARIANT), VIBE_SHIFT, SOCIAL_NARRATIVE, CULTURAL_DRIVERS (VARIANT), SEASONAL_RELEVANCE (VARIANT), GEOGRAPHIC_HOTSPOTS (VARIANT) | Grok |
| **Provenance** | LLM_RESPONSES (VARIANT), MODELS_USED (VARIANT), MODEL_AGREEMENT_SCORE, MODEL_AGREEMENT_NOTES | Write step |
| **Cost tracking** | LLM_TOKEN_USAGE (VARIANT), LLM_TOTAL_TOKENS, LLM_COST_ESTIMATE | Write step |
| **Metadata** | ENRICHED_AT, ENRICHMENT_VERSION | |

### Views

- **V_TREND_DASHBOARD** — Unified analytical surface joining FCT_TREND_METRICS + DIM_TREND_ENRICHMENT + FCT_TREND_SOURCE_METRICS (aggregated via OBJECT_AGG into SOURCES object). Computed: ACTIONABILITY_SCORE, SOURCE_SIGNAL_STRENGTH, ENRICHMENT_FRESHNESS, ENRICHMENT_TIER. Access source data as `SOURCES:gdelt:article_count_7d`. SOURCE_NAMES array for discovery.
- **V_TREND_LEADERBOARD** — Top trends ranked by TREND_COMMERCIAL_SCORE with CATEGORY_RANK, CONTENT_PIECE_COUNT, TOP_BRAND match. Valid + enriched trends only.
- **V_TREND_BRAND_MATCHES** — LATERAL FLATTEN of BRAND_ASSOCIATIONS into one row per brand-trend pair. PARTNERSHIP_SCORE = (brand_fit + commercial_score) / 2. Valid trends only.
- **V_TREND_AUDIENCE_OVERLAP** — Pairwise audience comparison across trends using demographics + psychographics + category. AUDIENCE_OVERLAP_SCORE (0-100) for ad package bundling.
- **V_TREND_LIFECYCLE** — Ops monitoring: classifies each trend's ACTION_NEEDED (NEEDS_ENRICHMENT, NEEDS_RETRY, NEEDS_REFRESH, SOURCES_STALE, LOW_CONFIDENCE, GOING_DORMANT, LIFECYCLE_CHANGE, OK) with ACTION_PRIORITY scoring.
- **V_ENRICHMENT_COST** — Daily cost aggregation: total tokens, total cost, avg cost per trend, waste ratio (cost on invalid trends), cumulative running totals.

---

## Enrichment Pipeline Architecture

```
Pipedream SQL trigger: source_trend_changes.sql (daily 11:45 UTC, polls FCT_TREND_METRICS + STG_ENRICHMENT_QUEUE)
  ↓ emits trend events
  enrich_trend.mjs (orchestrator v0.0.7)
    ├── enrich_gdelt.mjs       ─┐
    ├── enrich_wikimedia.mjs    │
    ├── enrich_bluesky.mjs      │  7 source enrichments
    ├── enrich_google_trends.mjs│  (Promise.allSettled)
    ├── enrich_amazon.mjs       │
    ├── enrich_pinterest.mjs    │
    └── enrich_tiktok.mjs      ─┘
    │
    ├── [SOURCES_ONLY stops here, marks queue COMPLETED]
    │
    ↓ FULL enrichment continues:
    enrich_llm_gemini.mjs   ─┐
    enrich_llm_grok.mjs      ├─ Round 1 specialists (parallel)
    enrich_llm_chatgpt.mjs  ─┘
    ↓
    enrich_llm_claude.mjs      Round 2 synthesizer
    │   └── Gemini gate: skips Claude API if invalid + low coverage
    ↓
    enrich_write_snowflake.mjs
      ├── MERGE → DIM_TREND_ENRICHMENT
      ├── INSERT → FCT_TREND_ENRICHMENT_HISTORY (with SOURCE_METRICS_SNAPSHOT)
      └── UPDATE → STG_ENRICHMENT_QUEUE (cost, tier, duration)

Note: Source data is written to FCT_TREND_SOURCE_METRICS (one row per source)
by enrich_trend.mjs BEFORE the LLM enrichment steps run.
```

### Enrichment tiers
- **FULL** (version 1+) — 4-model specialist + synthesizer. ~$0.05-0.10/trend. Full audience + brand + content.
- **GATED** — Gemini flagged invalid with high confidence; Claude synthesis skipped. ~$0.01/trend.
- **SOURCES_ONLY** — Source APIs queried but LLM enrichment skipped (low heat/cluster).
