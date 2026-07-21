<!-- Title: ATLAS Dashboard -->

# ATLAS Dashboard — Field Reference

**Audience:** Insights Agent users (strategy, content, leadership).
**Purpose:** Explain every field shown on an ATLAS trend card — what it measures, what scale it's on, where the number comes from, and how to read it.
**Source of truth:** This page (hub). Mirrored from the canonical Markdown in the [Trend-Tree repo](../../docs/dashboard/).
**Last updated:** 2026-05-26

ATLAS is the main trend dashboard in the Insights Agent. Each row on ATLAS is one **trend** — a cultural pattern our pipeline identified from public signals, named, categorized, and tracked over time. The fields on each card describe how the trend is performing, what it's about, where it comes from, and how likely it is to grow.

This document covers every field a strategist sees on an ATLAS card. Field surfaces unique to other views (the Predictions Queue route, the Collections graph, the Decision Page) are out of scope and live in their own docs.

---

## How a trend is found

![How a trend gets to your ATLAS card — 6-stage pipeline flow](../images/atlas-flow.svg)

<!-- Diagram source: docs/images/atlas-flow.mmd. To regenerate after a pipeline change,
     edit the .mmd file, render via mermaid.live (paste, export SVG), then edit the SVG's
     width/height to explicit pixels (e.g. width="1200" height="79", remove width="100%"
     and max-width style) so Confluence renders it at full readable size instead of a thumbnail. -->

The short answer: **we don't ask AI what's trending. We collect raw data from the real world, and AI evaluates what's already happening.** The steps below explain where each datapoint on a card comes from and what decision produced it.

### 1. Listen — raw signals from real platforms

The pipeline continuously ingests from ~14 sources: Bluesky posts, GDELT news articles, Google Trends curves, Amazon trending products, and more. Some sources run continuously; others run on a schedule. Every article, post, or data point that clears basic quality checks becomes one signal — a single, verifiable row tied to a real URL.

We also run three discovery agents (Gemini, Grok, ChatGPT) that proactively search the public web every 2 hours for emerging patterns and return URLs. Every URL a discovery agent finds is post-verified for resolvability before it enters the pipeline — we don't ingest an agent's interpretation of a topic, we ingest the underlying content it pointed to.

→ See the [source catalog](sources.md) for the full list.

### 2. Cluster + gate — where noise gets filtered

This is the most important step for data reliability.

A **distillation agent** (Gemini 3.1 Pro) groups semantically related signals into **candidates** — potential trends. Before any candidate is considered for promotion, it must pass a hard structural gate:

- **At least 2 signals** in the cluster
- **At least 2 independent source families** — signals from a single platform don't constitute a trend

Candidates that don't pass are automatically rejected without any LLM involvement. A signal cluster from one source — even a large one — is treated as platform velocity, not a cultural trend.

Candidates that pass the gate are handed to a **promotion agent** (Gemini 3.1 Pro), which evaluates the full cluster — source breakdown, distillation confidence, specificity, and whether anything semantically similar already exists as a live trend. The agent decides: promote as a new trend, defer for more evidence, merge into an existing trend, or reject.

**A trend that appears on ATLAS cleared both the structural gate and the LLM judgment layer.** That's what `ORIGINALLY_SURFACED_AT` marks — the moment both passed.

> See the [glossary](glossary.md) for the **candidate** vs **trend** distinction.

### 3. Profile — AI interpretation on a verified foundation

Once a trend is promoted, an **enrichment agent** (Claude Sonnet 4.6) writes the card: the canonical trend name, category, summary, cultural drivers, seasonal relevance, geographic hotspots, and an evidence pool. The agent starts from the signal cluster that already cleared the gate — it's reasoning about something real, not speculating from scratch. It can also run live searches during profiling to pull in additional grounding, and any URLs it finds are added back to the trend's signal record.

The narrative fields (summary, cultural drivers, etc.) are AI-written interpretation. The **evidence pool is the paper trail** — the real signals and sources that grounded the agent's analysis. If a claim in the summary looks off, the evidence pool is where to check.

Names and category are **frozen at first enrichment** so cards don't quietly rename themselves over time.

→ See [`TREND_NAME`](fields/trend-name.md) and [narrative fields](fields/narrative-fields.md).

### 4. Track — how talked about is this right now?

Every hour, a **lifecycle agent** (Gemini 3.1 Pro) re-evaluates every live trend against recent signal flow, publisher breadth, and the trend's own history. Two numbers come out:

- **`HEAT_INDEX`** (0–100) — how much is this trend being talked about right now. Smoothed so a single quiet hour doesn't crater a hot trend.
- **`LIFECYCLE_STATUS`** — the trend's overall trajectory: `NEW` / `GROWING` / `STABLE` / `DECLINING` / `DORMANT` / `RESURGENT` / `RETIRED`.

Heat reflects current volume and momentum. Lifecycle reflects the shape of the trend over time.

→ See [`HEAT_INDEX`](fields/heat-index.md) and [`LIFECYCLE_STATUS`](fields/lifecycle-status.md).

### 5. Predict — how likely is this to grow?

Once a day, a **prediction agent** scores every live trend on week-over-week deltas: heat acceleration, base volume, source diversity expansion, and cluster growth. The result is a `PREDICTION_SCORE` (0–100) and a `PREDICTION_FLAG` (`Emerging` / `Watchlist` / `High Potential`).

Prediction is distinct from heat: heat says *how active is this now*, prediction says *is this trend still building or has it peaked*. Trends flagged `Emerging` or `High Potential` appear in the Predictions Queue.

→ See [prediction deep dive](fields/prediction.md).

### 6. Display — ATLAS assembles the card

ATLAS reads the Snowflake dynamic table `DT_TREND_DASHBOARD`, which joins the latest output from each agent into one row per trend, refreshing every 15 minutes. What you see on a card is always the most recent evaluation from each stage above.

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
| `LIFECYCLE_STATUS` | `NEW` / `GROWING` / `STABLE` / `DECLINING` / `DORMANT` / `RESURGENT` / `RETIRED` | enum | Lifecycle agent (hourly) | [→](fields/lifecycle-status.md) |
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
| `TREND_NAME` | Singular canonical display name on the card (COALESCE prefers `TREND_NAME`, then legacy B2C/B2B fallbacks) | text | Enrichment agent (frozen at 1st enrichment) | [→](fields/trend-name.md) |
| `TREND_NAME_B2B` | Retired legacy fallback name (dual B2C/B2B scheme retired) | text | Enrichment agent (frozen at 1st enrichment) | [→](fields/trend-name.md) |
| `CATEGORY` / `SUBCATEGORY` | Top-level vertical + specific sub-classification | enum / text | Enrichment agent (frozen at 1st enrichment) | [→](fields/category.md) |
| `CATEGORY_CONFIDENCE` | How sure the agent was about the category | **0–1** (⚠ not 0–100) | Enrichment agent | [→](fields/category.md) |
| `LOW_CONFIDENCE_FLAG` | `TRUE` when `CATEGORY_CONFIDENCE < 0.6` | boolean | Enrichment agent | [→](fields/category.md) |

### Narrative (one row, multiple fields)

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `SUMMARY_SHORT`, `SUMMARY_LONG`, `SOCIAL_NARRATIVE`, `CULTURAL_DRIVERS`, `SEASONAL_RELEVANCE`, `GEOGRAPHIC_HOTSPOTS` (⚠ `VIBE_SHIFT` deprecated → use `SUMMARY_SHORT`) | Free-text narrative fields describing the trend | text / array | Enrichment agent | [→](fields/narrative-fields.md) |

### Evidence

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `EVIDENCE` | Typed pool of supporting evidence (news / commerce / social / reference / search_volume / video / other) | array | Enrichment agent | [→](fields/evidence.md) |
| `GENERAL_EVIDENCE`, `SOCIAL_EVIDENCE`, `OTHER_EVIDENCE` | Pre-bucketed slices of `EVIDENCE` for UI sections | array | Dashboard (live) | [→](fields/evidence.md) |
| `TOP_SIGNALS` _(⚠ deprecated → use `EVIDENCE`, first 5 news/commerce/social)_ | First 5 evidence entries (news/commerce/social only), in agent emit order | array | Dashboard (live) | [→](fields/evidence.md#top_signals) |
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

## Further reading

- **[Field deep dives](fields/)** — one page per field on the card.
- **[Where the signals come from](sources.md)** — direct platform sources, discovery agents, and on-demand agent search tools.
- **[🟡 Migrating fields](migrating.md)** — Insights Agent backend fields being moved into McClatchy's pipeline.
- **[FAQ](faq.md)** — 10 most-asked questions.
- **[Glossary](glossary.md)** — ATLAS-scoped terminology.
