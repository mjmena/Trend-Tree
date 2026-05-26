<!-- Title: ATLAS Dashboard -->

# ATLAS Dashboard — Field Reference

**Audience:** Insights Agent users (strategy, content, leadership).
**Purpose:** Explain every field shown on an ATLAS trend card — what it measures, what scale it's on, where the number comes from, and how to read it.
**Source of truth:** This page (hub). Mirrored from the canonical Markdown in the [Trend-Tree repo](../../docs/dashboard/).
**Last updated:** 2026-05-26

ATLAS is the main trend dashboard in the Insights Agent. Each row on ATLAS is one **trend** — a cultural pattern our pipeline identified from public signals, named, categorized, and tracked over time. The fields on each card describe how the trend is performing, what it's about, where it comes from, and how likely it is to grow.

This document covers every field a strategist sees on an ATLAS card. Field surfaces unique to other views (the Predictions Queue route, the Collections graph, the Decision Page) are out of scope and live in their own docs.

---

## At a glance — field reference

Every score in this table is on a **0–100 scale unless otherwise noted**. The columns:

- **Field** — the field's name in code / the API
- **What it means** — one-line plain English
- **Scale** — what the value range is
- **Computed by** — which part of the pipeline produces the number
- **More** — link to the field's deep-dive page

### Scoring

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `HEAT_INDEX` | How hot the trend is **right now** (EWMA-smoothed momentum) | 0–100 | Lifecycle agent (hourly) | [→](fields/heat-index.md) |
| `LIFECYCLE_STATUS` | `NEW` / `STABLE` / `STAGNANT` / `DECLINING` / `RETIRED` | enum | Lifecycle agent (hourly) | [→](fields/lifecycle-status.md) |
| `VELOCITY_DIRECTION` | _Back-compat alias for `LIFECYCLE_STATUS`._ Same value under an older name. | enum | Lifecycle agent (hourly) | [→](fields/lifecycle-status.md) |
| `PREDICTION_SCORE` | How likely the trend is to **grow** (deterministic emergence formula) | 0–100 | Prediction agent (daily) | [→](fields/prediction.md) |
| `PREDICTION_FLAG` | `Emerging` / `Watchlist` / `High Potential` | enum | Prediction agent (daily) | [→](fields/prediction.md) |
| `PREDICTION_ELIGIBLE` | Trend qualifies for the Predictions Queue | boolean | Prediction agent (daily) | [→](fields/prediction.md) |

### Counts

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `DISTINCT_PUBLISHER_COUNT` | Number of unique **publishers** contributing signals to this trend | integer | Dashboard (live) | [→](fields/distinct-publisher-count.md) |
| `DISTINCT_SOURCE_COUNT` | _Back-compat alias for `DISTINCT_PUBLISHER_COUNT`._ Same value under an older, misleading name. | integer | Dashboard (live) | [→](fields/distinct-publisher-count.md) |
| `TOTAL_CLUSTER_SIZE` | Number of signals linked to this trend (across all publishers and sources) | integer | Dashboard (live) | [→](fields/total-cluster-size.md) |

### Identity & categorization

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `TREND_NAME` | Display name on the card (B2C-first with B2B fallback) | text | Enrichment agent (frozen at 1st enrichment) | [→](fields/trend-name.md) |
| `TREND_NAME_B2B` | Descriptive corporate-floor alternative name | text | Enrichment agent (frozen at 1st enrichment) | [→](fields/trend-name.md) |
| `CATEGORY` / `SUBCATEGORY` | Top-level vertical + specific sub-classification | enum / text | Enrichment agent (frozen at 1st enrichment) | [→](fields/category.md) |
| `CATEGORY_CONFIDENCE` | How sure the agent was about the category | **0–1** (⚠ not 0–100) | Enrichment agent | [→](fields/category.md) |
| `LOW_CONFIDENCE_FLAG` | `TRUE` when `CATEGORY_CONFIDENCE < 0.6` | boolean | Enrichment agent | [→](fields/category.md) |

### Narrative (one row, multiple fields)

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `SUMMARY_SHORT`, `SUMMARY_LONG`, `SOCIAL_NARRATIVE`, `CULTURAL_DRIVERS`, `SEASONAL_RELEVANCE`, `GEOGRAPHIC_HOTSPOTS`, `VIBE_SHIFT` | Free-text narrative fields describing the trend | text / array | Enrichment agent | [→](fields/narrative-fields.md) |

### Evidence

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `EVIDENCE` | Typed pool of supporting evidence (news / commerce / social / reference / search_volume / video / other) | array | Enrichment agent | [→](fields/evidence.md) |
| `GENERAL_EVIDENCE`, `SOCIAL_EVIDENCE`, `OTHER_EVIDENCE` | Pre-bucketed slices of `EVIDENCE` for UI sections | array | Dashboard (live) | [→](fields/evidence.md) |
| `TOP_SIGNALS` | First 5 evidence entries (news/commerce/social only), in agent emit order | array | Dashboard (live) | [→](fields/evidence.md#top_signals) |
| `KEY_DATA_POINTS` | Google Trends interest scalars (peak %, avg %) for the trend | array | Google Trends poller (daily) | [→](fields/key-data-points.md) |

### Relationships

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `RELATED_TRENDS` | Top 5 related trends by vector cosine similarity (≥ 0.65) | array of `{trend_id, trend_name, category, similarity}` | Dashboard (live) | [→](fields/related-trends.md) |
| `MACROTREND_TAGS` | Higher-level theme labels the trend rolls up into | array | Enrichment agent | [→](fields/macrotrend-tags.md) |

### Timestamps & provenance

| Field | What it means | Scale | Computed by |
|---|---|---|---|
| `ORIGINALLY_SURFACED_AT` | When this trend first appeared in the pipeline | timestamp | Distillation agent |
| `ENRICHED_AT` | When the current enrichment payload was written | timestamp | Enrichment agent |
| `LAST_LIFECYCLE_EVAL_AT` | When lifecycle last evaluated this trend | timestamp | Lifecycle agent (hourly) |
| `RETIREMENT_REASON` | Why a `RETIRED` trend was retired | text | Lifecycle agent |
| `TREND_SOURCE` | Discovery vs distillation provenance for the trend | enum | Promotion agent |

### 🟡 Migrating from the Insights Agent backend

> These fields currently render on ATLAS cards but are computed by the Insights Agent backend (Marcelo's side). They're being migrated into the McClatchy pipeline. Until migration completes, the details below are placeholders — full deep dives will be filled in as each one moves over.

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| 🟡 Audience Match | Audience overlap with target demographics | TBD | Insights Agent → migrating | [→](migrating.md#audience-match) |
| 🟡 Confidence Score | Overall trustworthiness rollup | TBD | Insights Agent → migrating | [→](migrating.md#confidence-score) |
| 🟡 Content Gap | Whether we're under-covering this trend | TBD | Insights Agent → migrating | [→](migrating.md#content-gap) |
| 🟡 Revenue Potential | Estimated revenue if we publish on this trend | TBD | Insights Agent → migrating | [→](migrating.md#revenue-potential) |
| 🟡 AI Match % | Vectorization match to the CSA content library | TBD | Insights Agent → migrating | [→](migrating.md#ai-match) |
| 🟡 Overall Score (G/Y/R) | ≥ 75 green / 50–74 yellow / < 50 red rollup | enum + 0–100 | Insights Agent → migrating | [→](migrating.md#overall-score) |

---

## How a trend gets to your ATLAS card

![How a trend gets to your ATLAS card — 6-stage pipeline flow](../images/atlas-flow.svg)

<!-- Diagram source: docs/images/atlas-flow.mmd. To regenerate after a pipeline change,
     edit the .mmd file and render via mermaid.live (paste, export SVG) or `mmdc -i atlas-flow.mmd -o atlas-flow.svg` -->


### 1. Listen — we ingest signals from many sources

The pipeline knows about 15 sources today (around 10 actively ingesting at any given moment; a few are paused or run intermittently). Some are **direct platform sources** (Bluesky, Google Trends, Amazon, etc.) where we pull from a public API or feed. Others are **discovery agents** — LLMs that proactively search the public web every 2 hours and bring back URLs we post-verify before ingest. Each raw signal becomes one row in our internal `FCT_SIGNALS` table.

→ See the [source catalog](sources.md) for the full list with provenance and refresh cadence per source.

### 2. Identify — AI condenses signals into trends

Raw signals are noisy. A **distillation agent** (Gemini 3.1 Pro) clusters related signals — using a mix of semantic similarity and shared topical hints — into **candidates**. A second **promotion agent** evaluates each candidate against quality gates (sufficient cluster size, source breadth, novelty) and decides which ones become canonical trends. When a candidate is promoted, it gets a stable `TREND_ID` and lands in `FCT_TRENDS`.

> See the [glossary](glossary.md) for the **candidate** vs **trend** distinction.

### 3. Profile — each trend gets a rich description

An **enrichment agent** (Claude Sonnet 4.6) takes each new trend and produces a complete profile in one pass: B2C and B2B names, category and subcategory, a short and long summary, cultural drivers, seasonal relevance, geographic hotspots, vibe shift, and a typed evidence pool. The names and category are **frozen** at this first enrichment — re-enrichment can update the rest of the payload, but the identity stays stable so cards don't quietly rename themselves over time.

→ See [`TREND_NAME`](fields/trend-name.md) and [narrative fields](fields/narrative-fields.md).

### 4. Track — heat reflects momentum, lifecycle reflects shape

Every hour, a **lifecycle agent** (Gemini 3.1 Pro) re-evaluates every live trend. It looks at recent signal flow, publisher breadth, and the trend's history; the result is a fresh `HEAT_INDEX` (a 0–100 EWMA-smoothed momentum score) and a `LIFECYCLE_STATUS` (`NEW` / `STABLE` / `STAGNANT` / `DECLINING` / `RETIRED`). Heat is the "how hot right now" number. Lifecycle is the "what shape is this trend in" label.

→ See [`HEAT_INDEX`](fields/heat-index.md) and [`LIFECYCLE_STATUS`](fields/lifecycle-status.md).

### 5. Predict — daily emergence scoring

Once a day, a **prediction agent** scores every live trend on four week-over-week deltas (heat acceleration, low base volume, source diversity expansion, cluster formation). The result is a `PREDICTION_SCORE` (0–100), a `PREDICTION_FLAG` (`Emerging` / `Watchlist` / `High Potential`), and a boolean `PREDICTION_ELIGIBLE` that gates the Predictions Queue. Unlike heat (which says "how hot now"), prediction says "how likely to grow."

→ See [prediction deep dive](fields/prediction.md).

### 6. Display — ATLAS reads everything

ATLAS queries a Snowflake dynamic table (`DT_TREND_DASHBOARD`) that joins the latest row from each agent's ledger into one row per trend. The dynamic table refreshes every 15 minutes, so changes upstream take at most 15 minutes to appear on a card.

---

## Further reading

- **[Field deep dives](fields/)** — one page per field on the card.
- **[Where the signals come from](sources.md)** — direct platform sources + discovery agents.
- **[🟡 Migrating fields](migrating.md)** — Insights Agent backend fields being moved into McClatchy's pipeline.
- **[FAQ](faq.md)** — 10 most-asked questions.
- **[Glossary](glossary.md)** — ATLAS-scoped terminology.
