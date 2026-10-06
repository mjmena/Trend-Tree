# CRMA-1203 — Current-state snapshot: metrics and integration inventory

Feeds the current-state slides of the executive briefing deck (map CRMA-1199).

**Status, 2026-10-06.** The integration inventory is verified against production commit `354662a` (2026-10-06). The refresh queries are verified against the table DDL in `sql/` at the same commit. **The metric values are still pending**: Snowflake SSO was expired on 2026-10-06 and on 2026-09-19, so no query has run yet. `gcloud` auth was also expired, so the Cloud Run rows below rest on repo evidence, not on a live listing.

## Metrics

| # | Metric | Value | As of |
| --- | --- | --- | --- |
| 1a | Trends ever promoted (`FCT_TRENDS` rows) | pending | — |
| 1b | Trends on the dashboard (`DT_TREND_DASHBOARD` rows) | pending — interim **590** | 2026-10-06 00:29 ET (see note) |
| 2 | Trends by `LIFECYCLE_STATUS` | pending | — |
| 3a | Signals ever ingested (`FCT_SIGNALS` rows) | pending | — |
| 3b | Signals embedded in the last 30 days | pending | — |
| 3c | Distinct `SOURCE_NAME` values, with 30-day volume per source | pending | — |
| 4 | Median LLM cost per enrichment run, last 30 days | pending — last known **$0.15/run**, 167 runs | 30 days to 2026-08-20 (stale) |
| 5a | Trend-to-signal links by `LINK_KIND` | pending | — |
| 5b | Prediction-eligible trends by `PREDICTION_FLAG` | pending | — |
| 6 | Trends by `SOURCING_STATUS` | pending — interim **37 matched / 509 no_match / 44 not_sourced** | 2026-10-06 00:29 ET (see note) |

**Note on the interim values.** They come from the live check that closed CRMA-772 on 2026-10-06 at 00:29 ET. That check also counted 201 products in `DIM_CATALOG_PRODUCT`. Row 1b is the sum of row 6. Use them for sizing the outline only; run the queries before any number goes on a slide.

## Refresh queries

Run each query the day before presenting:

```sh
snow sql -c claude --enable-templating NONE --format json -q "<query>"
```

Run outside any sandbox. Run one `snow` process at a time. If a query prints nothing for 60 seconds, the SSO token is expired: complete the browser login, then run it again.

**1 — Trends promoted, and trends on the dashboard**

```sql
SELECT
  (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS)         AS TRENDS_EVER_PROMOTED,
  (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD) AS TRENDS_ON_DASHBOARD;
```

**2 — Lifecycle breakdown** (NEW / GROWING / STABLE / DECLINING / DORMANT / RESURGENT / RETIRED)

```sql
SELECT LIFECYCLE_STATUS, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
GROUP BY 1 ORDER BY N DESC;
```

**3 — Signal volume and sources.** The window uses `EMBEDDED_AT`, not `SIGNAL_TIMESTAMP`: a backlog drain backfills `SIGNAL_TIMESTAMP` and hides an outage.

```sql
SELECT COUNT(*)                                                        AS TOTAL_SIGNALS,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()))   AS SIGNALS_LAST_30D,
       COUNT(DISTINCT SOURCE_NAME)                                     AS DISTINCT_SOURCES
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS;
```

```sql
SELECT SOURCE_NAME,
       COUNT(*)                                                        AS TOTAL_ROWS,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()))   AS ROWS_LAST_30D,
       MAX(EMBEDDED_AT)                                                AS LAST_EMBEDDED_AT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
GROUP BY 1 ORDER BY ROWS_LAST_30D DESC, TOTAL_ROWS DESC;
```

The per-source query is also the proof of which sources are live. A source with zero rows in 30 days is not a live integration, whatever the docs say.

**4 — Median enrichment cost, last 30 days.** `promotion_seed` rows are excluded: promotion writes them as stubs, and they are not enrichment runs.

```sql
SELECT COUNT(*)                  AS ENRICHMENT_RUNS_30D,
       COUNT(LLM_COST_ESTIMATE)  AS RUNS_WITH_COST_VALUE,
       MEDIAN(LLM_COST_ESTIMATE) AS MEDIAN_COST_USD,
       AVG(LLM_COST_ESTIMATE)    AS AVG_COST_USD
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE WRITTEN_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP())
  AND ENRICHMENT_KIND <> 'promotion_seed';
```

Quote `RUNS_WITH_COST_VALUE / ENRICHMENT_RUNS_30D` next to the median. On 2026-08-20 only 83 of 167 rows carried a cost value (CRMA-442).

**5 — Links and predictions**

```sql
SELECT LINK_KIND, COUNT(*) AS LINKS, COUNT(DISTINCT TREND_ID) AS TRENDS_WITH_LINKS
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
GROUP BY 1;
```

```sql
SELECT PREDICTION_FLAG, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE PREDICTION_ELIGIBLE
GROUP BY 1 ORDER BY N DESC;
```

**6 — Product sourcing coverage** (new since 2026-09-19; the ecomm sourcing agent is now a live integration)

```sql
SELECT SOURCING_STATUS, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
GROUP BY 1 ORDER BY N DESC;
```

## Inbound: sources

A **signal** is one ingested data point. Its **source** is the name in `FCT_SIGNALS.SOURCE_NAME`. `CONTEXT.md` defines three entry mechanisms, and since ADR-0010 a source name carries the platform and exactly one entry mechanism. "Live" below means the repo at `354662a` runs it; the per-source query above is the final proof.

### Direct platform sources — scheduled ingesters

| Source | State | Note |
| --- | --- | --- |
| `bluesky` | live | Public-post stream. Legacy name: the `search-bluesky` tool also writes it. |
| `amazon_trends` | live | Amazon trending-product data. |
| `pinterest` | live | Trending pins and boards. |
| `google_trends_rss` | live | Trending-story RSS, one signal per article. |
| `google_trends_explore` | live | Search-interest data. Legacy name: the `search-google-trends` tool also writes it. |
| `tiktok` | **live again since 2026-09-28** | Cloud Run job `trend-tree-tiktok-ingest` (CRMA-1337), daily Scheduler job (CRMA-1338). SerpApi `google_short_videos` over a fixed seed-query list, then a `gemini-3.7-flash` title filter. Capped at 50 SerpApi calls per run. On a first-week 30% specificity spot-check that drops the source if it fails. |
| `wikimedia` | retired | Passive ingester retired late April 2026. Historical rows stay. |
| `gdelt` (passive batch) | retired 2026-04-26 | The name lives on: the `search-gdelt` tool is its only writer. |
| TikTok Creative Center scraper | retired 2026-06-09 | The Pipedream workflow `ingestion/tiktok-p_yKCm9Am` stays off. The SerpApi job replaced it. |
| `reddit` | **decided, not built** | ADR-0006 accepts a vendor scrape. No ingester exists in `services/`. |
| `kickstarter` | **decided, not built** | ADR-0008 accepts a traction-gated vendor scrape. No ingester exists in `services/`. The SerpApi route dropped Kickstarter (CRMA-1318). |
| TikTok creator lanes | **decided, not built** | ADR-0009: a `profile_url` precision lane and a `#`-keyword breadth lane over a curated creator list, through Bright Data. Not what runs today. |

`CONTEXT.md` lists `reddit` and `kickstarter` in the source taxonomy because their routes are decided. They belong on the Future Plans slide ("Building now — intake expansion"), not on a current-state slide.

### Discovery agents — LLMs on a 2-hour cron that propose emerging topics

`agent_gemini_discovery`, `agent_grok_discovery`, `agent_chatgpt_discovery` (the three general lanes), and `gemini_food_drink`, `gemini_other`, `gemini_travel`, `gemini_wellness` (the four vertical Gemini lanes). Unchanged since 2026-09-19.

### Agent search tools — called on demand by the reasoning agents

| Tool | Writes | Grounding lane |
| --- | --- | --- |
| `search-bluesky` | `bluesky` | social |
| `search-gdelt` | `gdelt` | news |
| `search-google-trends` | `google_trends_explore` | search demand |
| `grok-live-search` | `grok_live` | social / X only |

Unchanged since 2026-09-19. A `search-tiktok` tool is decided (CRMA-1005) and not built.

### Corroboration oracle

**Exploding Topics** (ADR-0004). The promotion gate queries it; a concept match earns a single-family candidate its second source family. It writes no `FCT_SIGNALS` row, so it is **not a source**. A second oracle on Reddit was decided on 2026-09-28 (CRMA-1326) and lapsed the same day, when CRMA-1344 rejected the typed promotion path it attached to.

### Removed since 2026-09-19

The `gtrends-poller` workflow was removed on 2026-09-25 (CRMA-1313). `DT_TREND_DASHBOARD.KEY_DATA_POINTS` is now always an empty array. Do not show a per-trend Google Trends interest curve as a current feature.

## Outbound: consumers

| Consumer | State | What it reads |
| --- | --- | --- |
| **ATLAS** (the trend dashboard UI in the Insights Agent) | live | `DT_TREND_DASHBOARD`, one row per trend, 15-minute refresh lag. |
| **Insights Agent Predictions Queue** | live | `PREDICTION_SCORE` / `PREDICTION_FLAG` / `PREDICTION_ELIGIBLE` from the deterministic `prediction-agent` workflow (daily). |
| **Daily digest email** | live | Recently promoted trends from `DT_TREND_DASHBOARD`, with ATLAS deep links. |
| **Ecomm sourcing agent** | live | Cloud Run service `trend-tree-ecomm-agent`: `POST /source` plus a 15-minute `POST /poll`. It matches each promoted trend against the Trend Hunter Shopify catalog and writes `SOURCING_STATUS` back to the dashboard. The Decision Page in the Insights Agent is its only designed consumer surface. |
| **Catalog sync** (feeds the sourcing agent) | live since 2026-09-28 | Cloud Run job `trend-tree-catalog-sync`, daily 09:00 UTC, sweeps the public storefront feed into `DIM_CATALOG_PRODUCT` (201 products on 2026-10-06). |
| **ATLAS to CSA handoff** (PGS-836) | **in progress, not ours** | Owned by the Product Growth Squad. It moves research drafts from ATLAS into the Content Scaling Agent, not trend data from Trend Tree. On 2026-10-06 the epic PGS-836 is in Backlog and the "Send to CSA" action PGS-828 is in Product Review. On 2026-09-16 it worked on dev only. |

The prediction pillar service (`services/prediction`, with a `trend-tree-prediction-daily-sweep` cron named in the repo) is the "prediction engine" of the Future Plans slide. Its live state is unverified here.

## Vendors and infrastructure

- **Google Gemini 3.1 Pro** — the reasoning agents: cluster agent, promotion, enrichment, lifecycle, lifecycle-attribution, audit.
- **Google Gemini Flash** — discovery lanes (2.5 Flash), and `gemini-3.7-flash` for the TikTok title filter and the sourcing selector.
- **Anthropic Claude Sonnet 4.6** — four remaining steps: `sources/generate_search_terms`, `discovery/rerank_claude`, `distillation-revisit-subagent/run_revisit_subagent`, `enrichment/run_name_reviewer`.
- **xAI Grok** — the `agent_grok_discovery` lane and the `grok-live-search` tool.
- **OpenAI ChatGPT** — the `agent_chatgpt_discovery` lane.
- **Snowflake Cortex** — arctic-embed 1024-dimension embeddings, trend-topic coining at promotion.
- **Exploding Topics** — corroboration oracle API.
- **SerpApi** — the TikTok ingester, on the shared `dev@trendhunter.com` plan (new since 2026-09-19).
- **Bright Data** — behind the Cloud Run service `trend-tree-scrape-gateway`. The gateway is deployed; no ingester calls it yet.
- **Shopify storefront feed** — the product catalog for sourcing (`shop.trendhunter.com`).
- **Infrastructure** — Pipedream (workflow tier, redeploys on push to `production`), GCP Cloud Run + Cloud Scheduler in `mcc-crm-automations` / `us-east4` (services tier), Snowflake `MCC_PRESENTATION.TREND_AGENT`.

## Rules for deck copy

- A current-state slide names only rows marked **live**. Rows marked **decided, not built** or **in progress** go to Future Plans.
- Cite `DISTINCT_PUBLISHER_COUNT`, never `DISTINCT_SOURCE_COUNT`. The legacy column counts publishers.
- Never present Exploding Topics as a source.
- Count sources from the per-source query, not from `COUNT(DISTINCT SOURCE_NAME)`: the distinct count includes retired names.
- Check the gap between metric 1a and 1b before a slide says "X trends live".
- The handoff to CSA is another squad's work in progress. Do not call it a live Trend Tree integration.

## Open verification

1. **Run queries 1 to 6** and fill the metrics table. Blocked on Snowflake SSO.
2. **List the live Cloud Run jobs, services and Scheduler jobs** to confirm `trend-tree-tiktok-ingest`, `trend-tree-catalog-sync`, `trend-tree-ecomm-agent`, `trend-tree-scrape-gateway`, and the state of the prediction service. Blocked on `gcloud auth login`.
