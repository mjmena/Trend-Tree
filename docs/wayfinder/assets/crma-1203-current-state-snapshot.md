# CRMA-1203 — Current-state snapshot: metrics and integration inventory

Feeds the current-state slides of the executive briefing deck (map CRMA-1199).

**Snapshot taken 2026-10-06 at 16:20 UTC.** Every metric below comes from a live Snowflake query. The integration inventory is checked three ways: against production commit `354662a`, against a live `gcloud` listing of Cloud Run and Cloud Scheduler, and against the per-source row counts in `FCT_SIGNALS`. Where the repo docs and the row counts disagree, the row counts win.

## Metrics

| # | Metric | Value |
| --- | --- | --- |
| 1a | Trends ever promoted (`FCT_TRENDS` rows) | **590** |
| 1b | Trends on the dashboard (`DT_TREND_DASHBOARD` rows) | **590** — no gap to 1a |
| 2 | Trends by `LIFECYCLE_STATUS` | STABLE **485** · RETIRED **50** · DORMANT **49** · DECLINING **5** · NEW **1** · GROWING 0 · RESURGENT 0 |
| 3a | Signals ever ingested (`FCT_SIGNALS` rows, since 2026-04-28) | **154,500** |
| 3b | Signals embedded in the last 30 days | **36,831** (5,729 in the last 7 days) |
| 3c | Source names with rows in the last 30 days | **12** of 17 names ever written |
| 4 | Median LLM cost per enrichment run, last 30 days | **$0.13** — 133 runs, average $0.15, maximum $0.30, total $19.60 |
| 4b | Share of those runs that carry a cost value | **133 of 133** |
| 5a | Trend-to-signal links (`FCT_TREND_SIGNALS`) | **6,550** links from **5,675** distinct signals to **572** trends; 808 links added in the last 30 days |
| 5b | Prediction-eligible trends | **13** — Emerging 10, Watchlist 3 |
| 6 | Trends by `SOURCING_STATUS` | matched **37** · no_match **509** · not_sourced **44** |
| 7 | Trend candidates (`STG_TREND_CANDIDATES`, since 2026-04-25) | **2,254** (324 in the last 30 days) |

**The funnel, for the tree visual:** 154,500 signals → 2,254 candidates → 590 trends. 5,675 signals (3.7%) are linked to a trend as evidence.

**Promotion rate:** 61 `promotion_seed` rows in the last 30 days, one per promoted trend. That is about two new trends per day.

**Detail behind row 5a:** 3,696 `supporting` links across 572 trends (set at promotion), and 2,854 `attributed` links across 343 trends (added later by the lifecycle-attribution agent). 18 trends have no link.

**Detail behind row 5b:** across all 590 trends, `PREDICTION_FLAG` reads Emerging on 55, Watchlist on 6, High Potential on 1, and is empty on 528. Only 13 pass `PREDICTION_ELIGIBLE`.

### Signals by source, last 30 days

| `SOURCE_NAME` | Entry mechanism | Rows, all time | Rows, 30 days | Rows, 7 days | Last row (ET) |
| --- | --- | --- | --- | --- | --- |
| `google_trends_rss` | direct platform source | 101,192 | 27,896 | 4,592 | 2026-10-06 |
| `bluesky` | direct platform source + `search-bluesky` tool | 15,515 | 2,794 | 170 | 2026-10-06 |
| `agent_chatgpt_discovery` | discovery agent | 7,670 | 1,987 | 329 | 2026-10-06 |
| `grok_live` | agent search tool | 8,665 | 1,026 | 43 | 2026-10-05 |
| `google_trends_explore` | direct platform source + `search-google-trends` tool | 4,094 | 703 | 91 | 2026-10-06 |
| `agent_gemini_discovery` | discovery agent | 3,292 | 653 | 112 | 2026-10-06 |
| `gemini_other` | discovery agent | 1,964 | 492 | 73 | 2026-10-06 |
| `agent_grok_discovery` | discovery agent | 2,263 | 386 | 55 | 2026-10-06 |
| `gemini_wellness` | discovery agent | 1,227 | 293 | 65 | 2026-10-06 |
| `gemini_food_drink` | discovery agent | 1,125 | 279 | 61 | 2026-10-06 |
| `gemini_travel` | discovery agent | 926 | 166 | 18 | 2026-10-05 |
| `tiktok` | direct platform source | 601 | 156 | 120 | 2026-10-04 |
| `gdelt` | `search-gdelt` tool | 3,211 | 0 | 0 | 2026-08-08 |
| `wikimedia` | retired | 2,384 | 0 | 0 | 2026-04-30 |
| `amazon_trends` | direct platform source | 328 | 0 | 0 | 2026-05-04 |
| `pinterest` | direct platform source | 37 | 0 | 0 | 2026-05-05 |
| `smoke` | test rows | 6 | 0 | 0 | 2026-04-30 |

**Shares of the 30-day volume:** `google_trends_rss` alone is 76%. The four direct platform sources together are 86%. The seven discovery agents are 12%. `grok_live` is 3%.

## Refresh queries

Run each query the day before presenting:

```sh
snow sql -c claude --enable-templating NONE --format json -q "<query>"
```

Run outside any sandbox. Run one `snow` process at a time. If a query prints nothing for 60 seconds, the SSO token is expired: run `snow sql -c claude -q "SELECT 1"` in a terminal, complete the browser login, then run the query again. Each query below ran on 2026-10-06, in this form or with extra columns.

**1 — Trends promoted, and trends on the dashboard**

```sql
SELECT
  (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS)         AS TRENDS_EVER_PROMOTED,
  (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD) AS TRENDS_ON_DASHBOARD;
```

**2 — Lifecycle breakdown**

```sql
SELECT LIFECYCLE_STATUS, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
GROUP BY 1 ORDER BY N DESC;
```

**3 — Signal volume and sources.** The window uses `EMBEDDED_AT`, not `SIGNAL_TIMESTAMP`: a backlog drain backfills `SIGNAL_TIMESTAMP` and hides an outage.

```sql
SELECT COUNT(*)                                                        AS TOTAL_SIGNALS,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()))   AS SIGNALS_LAST_30D,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-7,CURRENT_TIMESTAMP()))    AS SIGNALS_LAST_7D,
       COUNT(DISTINCT SOURCE_NAME)                                     AS DISTINCT_SOURCES,
       COUNT(DISTINCT IFF(EMBEDDED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()), SOURCE_NAME, NULL)) AS SOURCES_ACTIVE_30D
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS;
```

```sql
SELECT SOURCE_NAME,
       COUNT(*)                                                        AS TOTAL_ROWS,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()))   AS ROWS_LAST_30D,
       COUNT_IF(EMBEDDED_AT >= DATEADD(day,-7,CURRENT_TIMESTAMP()))    AS ROWS_LAST_7D,
       TO_CHAR(MAX(EMBEDDED_AT),'YYYY-MM-DD HH24:MI')                  AS LAST_EMBEDDED_ET
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
GROUP BY 1 ORDER BY ROWS_LAST_30D DESC, TOTAL_ROWS DESC;
```

**4 — Enrichment cost, last 30 days.** Read the `initial` row. `promotion_seed` rows are stubs that promotion writes; they carry no cost.

```sql
SELECT ENRICHMENT_KIND,
       COUNT(*)                            AS RUNS_30D,
       COUNT(LLM_COST_ESTIMATE)            AS RUNS_WITH_COST,
       ROUND(MEDIAN(LLM_COST_ESTIMATE),4)  AS MEDIAN_COST_USD,
       ROUND(AVG(LLM_COST_ESTIMATE),4)     AS AVG_COST_USD,
       ROUND(MAX(LLM_COST_ESTIMATE),4)     AS MAX_COST_USD,
       ROUND(SUM(LLM_COST_ESTIMATE),2)     AS SUM_COST_USD
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE WRITTEN_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP())
GROUP BY 1 ORDER BY 1;
```

**5 — Links and predictions**

```sql
SELECT LINK_KIND, COUNT(*) AS LINKS, COUNT(DISTINCT TREND_ID) AS TRENDS_WITH_LINKS,
       COUNT(DISTINCT SIGNAL_ID) AS DISTINCT_SIGNALS,
       COUNT_IF(LINKED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP())) AS LINKS_LAST_30D
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
GROUP BY ROLLUP(LINK_KIND) ORDER BY 1;
```

```sql
SELECT PREDICTION_FLAG, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE PREDICTION_ELIGIBLE
GROUP BY 1 ORDER BY N DESC;
```

**6 — Product sourcing coverage**

```sql
SELECT SOURCING_STATUS, COUNT(*) AS N
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
GROUP BY 1 ORDER BY N DESC;
```

**7 — Candidates, the middle of the funnel**

```sql
SELECT COUNT(*)                                                       AS CANDIDATES_TOTAL,
       COUNT_IF(CREATED_AT >= DATEADD(day,-30,CURRENT_TIMESTAMP()))   AS CANDIDATES_LAST_30D
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES;
```

## Inbound: sources

A **signal** is one ingested data point. Its **source** is the name in `FCT_SIGNALS.SOURCE_NAME`. `CONTEXT.md` defines three entry mechanisms. "Live" below means the source wrote rows in the last 30 days.

### Direct platform sources — scheduled ingesters

| Source | State | Note |
| --- | --- | --- |
| `google_trends_rss` | **live** | Trending-story RSS, one signal per article. 76% of the 30-day volume. |
| `bluesky` | **live** | Public-post stream. Legacy name: the `search-bluesky` tool also writes it. The 7-day count (170) is low against the 30-day count (2,794). |
| `google_trends_explore` | **live** | Search-interest data. Legacy name: the `search-google-trends` tool also writes it. |
| `tiktok` | **live since 2026-09-28, stalled since 2026-10-05** | Cloud Run job `trend-tree-tiktok-ingest` (CRMA-1337), daily at 09:00 UTC. SerpApi `google_short_videos` over a fixed seed-query list, then a `gemini-3.7-flash` title filter. See "TikTok run history" below. The first-week 30% specificity check (CRMA-1340) is still open and can drop the source. |
| `amazon_trends` | **silent since 2026-05-04** | `CONTEXT.md` and `CLAUDE.md` describe it as live. The staging table `STG_EXTERNAL_SIGNALS` received its last row on 2026-05-04. No open CRMA ticket covers it. |
| `pinterest` | **deactivated since 2026-05-04** | 37 rows ever. Known: CRMA-448 (reactivate after reshape) and CRMA-447 (reshape) are in Backlog. |
| `wikimedia` | retired | Passive ingester retired late April 2026. |
| `reddit` | **decided, not built** | ADR-0006 accepts a vendor scrape. No ingester exists in `services/`. |
| `kickstarter` | **decided, not built** | ADR-0008 accepts a traction-gated vendor scrape. No ingester exists in `services/`. The SerpApi route dropped Kickstarter (CRMA-1318). |
| TikTok creator lanes | **decided, not built** | ADR-0009: two pull lanes over a curated creator list, through Bright Data. Not what runs today. |

`reddit` and `kickstarter` belong on the Future Plans slide ("Building now — intake expansion"). What still gets built is itself open: CRMA-1423 (created 2026-10-06) reconciles the Bright Data routes with the later SerpApi rulings.

**TikTok run history** (live `gcloud` listing and Cloud Logging, 2026-10-06). The daily job ran nine times and succeeded five times.

| Date (09:00 UTC run) | Result | Detail |
| --- | --- | --- |
| 2026-09-28 | succeeded | first scheduled run |
| 2026-09-29, 2026-09-30 | failed | SerpApi `HTTP 503: We couldn't get valid results for this search`. One failed search fails the whole run. |
| 2026-10-01 to 2026-10-04 | succeeded | wrote 33, 24, 29 and 34 signals |
| 2026-10-05, 2026-10-06 | failed | SerpApi `HTTP 429: Your account has run out of searches`. The shared `dev@trendhunter.com` plan is out of quota. |

No CRMA ticket covers the quota failure as of 2026-10-06. Until the quota returns, `tiktok` writes no new signals.

### Discovery agents — LLMs on a 2-hour cron that propose emerging topics

All seven lanes are **live**: `agent_chatgpt_discovery`, `agent_gemini_discovery`, `agent_grok_discovery`, and the four vertical Gemini lanes `gemini_other`, `gemini_wellness`, `gemini_food_drink`, `gemini_travel`. Together they wrote 4,256 signals in the last 30 days.

### Agent search tools — called on demand by the reasoning agents

| Tool | Writes | State |
| --- | --- | --- |
| `grok-live-search` | `grok_live` | **live** — 1,026 rows in 30 days, 43 in the last 7 |
| `search-bluesky` | `bluesky` | live, inside the `bluesky` count |
| `search-google-trends` | `google_trends_explore` | live, inside the `google_trends_explore` count |
| `search-gdelt` | `gdelt` | **silent since 2026-08-08** — the docs name it the only `gdelt` writer; it wrote nothing in 30 days. No open CRMA ticket covers it. |

A `search-tiktok` tool is decided (CRMA-1005) and not built.

### Corroboration oracle

**Exploding Topics** (ADR-0004). The promotion gate queries it; a concept match earns a single-family candidate its second source family. It writes no `FCT_SIGNALS` row, so it is **not a source**. A second oracle on Reddit was decided on 2026-09-28 (CRMA-1326) and lapsed the same day, when CRMA-1344 rejected the typed promotion path it attached to. Its build story CRMA-1339 closed as `wontfix`.

### Removed since 2026-09-19

The `gtrends-poller` workflow was removed on 2026-09-25 (CRMA-1313). `DT_TREND_DASHBOARD.KEY_DATA_POINTS` is now always an empty array. Do not show a per-trend Google Trends interest curve as a current feature.

## Outbound: consumers

| Consumer | State | What it reads |
| --- | --- | --- |
| **ATLAS** (the trend dashboard UI in the Insights Agent) | live | `DT_TREND_DASHBOARD`, one row per trend, 15-minute refresh lag. 590 trends. |
| **Insights Agent Predictions Queue** | live | `PREDICTION_SCORE` / `PREDICTION_FLAG` / `PREDICTION_ELIGIBLE` from the deterministic `prediction-agent` workflow (daily). 13 eligible trends. |
| **Daily digest email** | live | Recently promoted trends from `DT_TREND_DASHBOARD`, with ATLAS deep links. |
| **Ecomm sourcing agent** | live | Cloud Run service `trend-tree-ecomm-agent` (revision `00007-xax`): `POST /source` plus the Scheduler job `trend-tree-ecomm-poll` every 15 minutes. It matches each promoted trend against the Trend Hunter Shopify catalog and writes `SOURCING_STATUS` back to the dashboard. 37 trends matched. The Decision Page in the Insights Agent is its only designed consumer surface. |
| **Catalog sync** (feeds the sourcing agent) | live since 2026-09-28 | Cloud Run job `trend-tree-catalog-sync`, daily 09:00 UTC, sweeps the public storefront feed into `DIM_CATALOG_PRODUCT` (201 products). The run on 2026-10-06 succeeded. |
| **ATLAS to CSA handoff** (PGS-836) | **in progress, not ours** | Owned by the Product Growth Squad. It moves research drafts from ATLAS into the Content Scaling Agent, not trend data from Trend Tree. On 2026-10-06 the epic PGS-836 is in Backlog and the "Send to CSA" action PGS-828 is in Product Review. On 2026-09-16 it worked on dev only. |

The prediction pillar service is the "prediction engine" of the Future Plans slide. It is deployed and it runs: Cloud Run service `trend-tree-prediction` (revision `00013-mib`, ready), with the Scheduler job `trend-tree-prediction-daily-sweep` at 14:00 UTC, enabled, last fired 2026-10-06. Deployed is not the same as visible: the Future Plans decision (CRMA-1200) puts a capability on a current-state slide only if a reader can see it on ATLAS today. This snapshot did not check ATLAS for it.

## Vendors and infrastructure

- **Google Gemini 3.1 Pro** — the reasoning agents: cluster agent, promotion, enrichment, lifecycle, lifecycle-attribution, audit.
- **Google Gemini Flash** — discovery lanes (2.5 Flash), and `gemini-3.7-flash` for the TikTok title filter and the sourcing selector.
- **Anthropic Claude Sonnet 4.6** — four remaining steps: `sources/generate_search_terms`, `discovery/rerank_claude`, `distillation-revisit-subagent/run_revisit_subagent`, `enrichment/run_name_reviewer`.
- **xAI Grok** — the `agent_grok_discovery` lane and the `grok-live-search` tool.
- **OpenAI ChatGPT** — the `agent_chatgpt_discovery` lane.
- **Snowflake Cortex** — arctic-embed 1024-dimension embeddings, trend-topic coining at promotion.
- **Exploding Topics** — corroboration oracle API.
- **SerpApi** — the TikTok ingester, on the shared `dev@trendhunter.com` plan. The plan ran out of searches on 2026-10-05.
- **Bright Data** — behind the Cloud Run service `trend-tree-scrape-gateway` (revision `00003-sul`, ready). The gateway is deployed; no ingester calls it yet.
- **Shopify storefront feed** — the product catalog for sourcing (`shop.trendhunter.com`).
- **Infrastructure** — Pipedream (workflow tier, redeploys on push to `production`), GCP Cloud Run + Cloud Scheduler in `mcc-crm-automations` / `us-east4` (services tier), Snowflake `MCC_PRESENTATION.TREND_AGENT`.

## Rules for deck copy

- A current-state slide names a source only if it wrote rows in the last 30 days. Today that is 12 names: 4 direct platform sources, 7 discovery agents, and `grok_live`.
- Do not name Amazon, Pinterest or GDELT as current sources. The repo docs still list them; the data does not support it.
- Name TikTok as a current source only if the per-source query shows fresh rows the day before presenting.
- Rows marked **decided, not built** or **in progress** go to Future Plans.
- Cite `DISTINCT_PUBLISHER_COUNT`, never `DISTINCT_SOURCE_COUNT`. The legacy column counts publishers.
- Never present Exploding Topics as a source.
- The lifecycle breakdown shows no GROWING or RESURGENT trend and one NEW trend. A lifecycle chart will read as flat; lifecycle detection is already a "Building now" item on the Future Plans slide.
- The handoff to CSA is another squad's work in progress. Do not call it a live Trend Tree integration.

## Open verification

**Confirm on ATLAS** whether any output of the `trend-tree-prediction` service is visible to a reader today. Everything else in this file is verified as of 2026-10-06.
