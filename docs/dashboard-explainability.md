# ATLAS Dashboard — Field Reference

**Audience:** Insights Agent users (strategy, content, leadership).
**Purpose:** Explain every field shown on an ATLAS trend card — what it measures, what scale it's on, where the number comes from, and how to read it.
**Source of truth:** This document. Mirrored from the canonical Markdown in the [Trend-Tree repo](../docs/dashboard-explainability.md).
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
- **More** — link to the field's deep-dive section

### Scoring

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `HEAT_INDEX` | How hot the trend is **right now** (EWMA-smoothed momentum) | 0–100 | Lifecycle agent (hourly) | [→](#heat_index) |
| `LIFECYCLE_STATUS` | `NEW` / `STABLE` / `STAGNANT` / `DECLINING` / `RETIRED` | enum | Lifecycle agent (hourly) | [→](#lifecycle_status) |
| `VELOCITY_DIRECTION` | _Back-compat alias for `LIFECYCLE_STATUS`._ Same value under an older name. | enum | Lifecycle agent (hourly) | [→](#lifecycle_status) |
| `PREDICTION_SCORE` | How likely the trend is to **grow** (deterministic emergence formula) | 0–100 | Prediction agent (daily) | [→](#prediction) |
| `PREDICTION_FLAG` | `Emerging` / `Watchlist` / `High Potential` | enum | Prediction agent (daily) | [→](#prediction) |
| `PREDICTION_ELIGIBLE` | Trend qualifies for the Predictions Queue | boolean | Prediction agent (daily) | [→](#prediction) |

### Counts

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `DISTINCT_PUBLISHER_COUNT` | Number of unique **publishers** contributing signals to this trend | integer | Dashboard (live) | [→](#distinct_publisher_count) |
| `DISTINCT_SOURCE_COUNT` | _Back-compat alias for `DISTINCT_PUBLISHER_COUNT`._ Same value under an older, misleading name. | integer | Dashboard (live) | [→](#distinct_publisher_count) |
| `TOTAL_CLUSTER_SIZE` | Number of signals linked to this trend (across all publishers and sources) | integer | Dashboard (live) | [→](#total_cluster_size) |

### Identity & categorization

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `TREND_NAME` | Display name on the card (B2C-first with B2B fallback) | text | Enrichment agent (frozen at 1st enrichment) | [→](#trend_name) |
| `TREND_NAME_B2B` | Descriptive corporate-floor alternative name | text | Enrichment agent (frozen at 1st enrichment) | [→](#trend_name) |
| `CATEGORY` / `SUBCATEGORY` | Top-level vertical + specific sub-classification | enum / text | Enrichment agent (frozen at 1st enrichment) | [→](#category) |
| `CATEGORY_CONFIDENCE` | How sure the agent was about the category | **0–1** (⚠ not 0–100) | Enrichment agent | [→](#category) |
| `LOW_CONFIDENCE_FLAG` | `TRUE` when `CATEGORY_CONFIDENCE < 0.6` | boolean | Enrichment agent | [→](#category) |

### Narrative (one row, multiple fields)

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `SUMMARY_SHORT`, `SUMMARY_LONG`, `SOCIAL_NARRATIVE`, `CULTURAL_DRIVERS`, `SEASONAL_RELEVANCE`, `GEOGRAPHIC_HOTSPOTS`, `VIBE_SHIFT` | Free-text narrative fields describing the trend | text / array | Enrichment agent | [→](#narrative_fields) |

### Evidence

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `EVIDENCE` | Typed pool of supporting evidence (news / commerce / social / reference / search_volume / video / other) | array | Enrichment agent | [→](#evidence) |
| `GENERAL_EVIDENCE`, `SOCIAL_EVIDENCE`, `OTHER_EVIDENCE` | Pre-bucketed slices of `EVIDENCE` for UI sections | array | Dashboard (live) | [→](#evidence) |
| `TOP_SIGNALS` | First 5 evidence entries (news/commerce/social only), in agent emit order | array | Dashboard (live) | [→](#top_signals) |
| `KEY_DATA_POINTS` | Google Trends interest scalars (peak %, avg %) for the trend | array | Google Trends poller (daily) | [→](#key_data_points) |

### Relationships

| Field | What it means | Scale | Computed by | More |
|---|---|---|---|---|
| `RELATED_TRENDS` | Top 5 related trends by vector cosine similarity (≥ 0.65) | array of `{trend_id, trend_name, category, similarity}` | Dashboard (live) | [→](#related_trends) |
| `MACROTREND_TAGS` | Higher-level theme labels the trend rolls up into | array | Enrichment agent | [→](#macrotrend_tags) |

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
| 🟡 Audience Match | Audience overlap with target demographics | TBD | Insights Agent → migrating | [→](#audience_match) |
| 🟡 Confidence Score | Overall trustworthiness rollup | TBD | Insights Agent → migrating | [→](#confidence_score) |
| 🟡 Content Gap | Whether we're under-covering this trend | TBD | Insights Agent → migrating | [→](#content_gap) |
| 🟡 Revenue Potential | Estimated revenue if we publish on this trend | TBD | Insights Agent → migrating | [→](#revenue_potential) |
| 🟡 AI Match % | Vectorization match to the CSA content library | TBD | Insights Agent → migrating | [→](#ai_match) |
| 🟡 Overall Score (G/Y/R) | ≥ 75 green / 50–74 yellow / < 50 red rollup | enum + 0–100 | Insights Agent → migrating | [→](#overall_score) |

---

## How a trend gets to your ATLAS card

![How a trend gets to your ATLAS card — 6-stage pipeline flow](images/atlas-flow.svg)

<!-- Diagram source: docs/images/atlas-flow.mmd. To regenerate after a pipeline change,
     edit the .mmd file and render via mermaid.live (paste, export SVG) or `mmdc -i atlas-flow.mmd -o atlas-flow.svg` -->


### 1. Listen — we ingest signals from many sources

The pipeline knows about 15 sources today (around 10 actively ingesting at any given moment; a few are paused or run intermittently). Some are **direct platform sources** (Bluesky, Google Trends, Amazon, etc.) where we pull from a public API or feed. Others are **discovery agents** — LLMs that proactively search the public web every 2 hours and bring back URLs we post-verify before ingest. Each raw signal becomes one row in our internal `FCT_SIGNALS` table.

→ See [source catalog](#sources) for the full list with provenance and refresh cadence per source.

### 2. Identify — AI condenses signals into trends

Raw signals are noisy. A **distillation agent** (Gemini 3.1 Pro) clusters related signals — using a mix of semantic similarity and shared topical hints — into **candidates**. A second **promotion agent** evaluates each candidate against quality gates (sufficient cluster size, source breadth, novelty) and decides which ones become canonical trends. When a candidate is promoted, it gets a stable `TREND_ID` and lands in `FCT_TRENDS`.

> See the [glossary](#glossary) for the **candidate** vs **trend** distinction.

### 3. Profile — each trend gets a rich description

An **enrichment agent** (Claude Sonnet 4.6) takes each new trend and produces a complete profile in one pass: B2C and B2B names, category and subcategory, a short and long summary, cultural drivers, seasonal relevance, geographic hotspots, vibe shift, and a typed evidence pool. The names and category are **frozen** at this first enrichment — re-enrichment can update the rest of the payload, but the identity stays stable so cards don't quietly rename themselves over time.

→ See [`TREND_NAME`](#trend_name) and [narrative fields](#narrative_fields).

### 4. Track — heat reflects momentum, lifecycle reflects shape

Every hour, a **lifecycle agent** (Gemini 3.1 Pro) re-evaluates every live trend. It looks at recent signal flow, publisher breadth, and the trend's history; the result is a fresh `HEAT_INDEX` (a 0–100 EWMA-smoothed momentum score) and a `LIFECYCLE_STATUS` (`NEW` / `STABLE` / `STAGNANT` / `DECLINING` / `RETIRED`). Heat is the "how hot right now" number. Lifecycle is the "what shape is this trend in" label.

→ See [`HEAT_INDEX`](#heat_index) and [`LIFECYCLE_STATUS`](#lifecycle_status).

### 5. Predict — daily emergence scoring

Once a day, a **prediction agent** scores every live trend on four week-over-week deltas (heat acceleration, low base volume, source diversity expansion, cluster formation). The result is a `PREDICTION_SCORE` (0–100), a `PREDICTION_FLAG` (`Emerging` / `Watchlist` / `High Potential`), and a boolean `PREDICTION_ELIGIBLE` that gates the Predictions Queue. Unlike heat (which says "how hot now"), prediction says "how likely to grow."

→ See [prediction deep dive](#prediction).

### 6. Display — ATLAS reads everything

ATLAS queries a Snowflake dynamic table (`DT_TREND_DASHBOARD`) that joins the latest row from each agent's ledger into one row per trend. The dynamic table refreshes every 15 minutes, so changes upstream take at most 15 minutes to appear on a card.

---

## Field deep dives

<a id="heat_index"></a>
### HEAT_INDEX

**At a glance** — How hot the trend is right now. Goes up when signals are recent and coming from many publishers; goes down when the trend cools off. Smoothed hour-to-hour so the number doesn't jump around.

**Scale** — 0–100. Higher is hotter. The value shown is the **smoothed** value (preferred); when a freshly-promoted trend hasn't been smoothed yet, the raw value is shown as a fallback. Rounded to one decimal place.

**What feeds it** — The lifecycle subagent (Gemini 3.1 Pro) reads the signals attached to the trend and emits a `heat_base` value — a 0–100 assessment grounded in recency, publisher breadth, and signal volume in the recent window. The subagent can also emit an optional `heat_modifier_pct` (a ±20% trend-specific adjustment) when its qualitative read of the cluster justifies bumping the base up or down.

**How it's computed** — The two agent outputs combine, get clamped, and get smoothed:

```
new_heat          = clamp(0, 100, heat_base × (1 + modifier / 100))
new_heat_smoothed = round( 0.7 × prior_smoothed + 0.3 × new_heat, 1 )
```

The smoothing is a one-sided EWMA with α=0.3 — each new observation contributes 30%, the prior smoothed value retains 70%. The displayed `HEAT_INDEX` is `new_heat_smoothed`, falling back to `new_heat` when no prior smoothed value exists yet.

**Why smoothed?** Without smoothing, a single quiet day would drop a hot trend by 20 points, and a single news cycle would spike a cold trend by 30. Smoothing means heat reflects *sustained* signal activity rather than any single hour's noise. The trade-off: heat lags reality slightly — a trend that started cooling yesterday will still show elevated heat for a day or two before the smoothed value catches up.

**What "good" looks like** — _TODO: empirical bands once we have a few weeks of post-refactor data. Likely: 0–20 = quiet, 20–50 = active, 50–75 = trending, 75+ = top decile._

**Edge cases**

- `NULL` is possible for trends that have never been evaluated by lifecycle (very rare — first lifecycle eval happens within an hour of promotion).
- Two-cycle retirement: a trend the agent proposes to retire stays at its prior status (and prior heat) for one more cycle before flipping to `RETIRED`. Heat continues to update during the proposal cycle.

**Where it appears in ATLAS** — Card badge color and value; sort key for the trend list.

---

<a id="lifecycle_status"></a>
### LIFECYCLE_STATUS

**At a glance** — A label for the trend's overall trajectory. Updated every hour by the lifecycle agent.

**Scale** — One of:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted. Not enough history yet to assess direction. |
| `STABLE` | Consistent signal flow; the trend is established and active. |
| `STAGNANT` | Signal flow has plateaued. Not declining, but not growing either. |
| `DECLINING` | Signal flow is dropping vs prior windows. |
| `RETIRED` | The trend has gone quiet long enough that we've stopped surfacing it. Filtered out of ATLAS. |

**What feeds it** — The lifecycle agent's per-trend evaluation each hour: recent signal flow vs prior windows, the trend's age, and (for retirement) two-cycle confirmation — both the current eval and the prior eval must propose RETIRE before the status flips.

**Two-cycle retirement** — Prevents single-cycle noise from prematurely retiring a trend. If the agent proposes `RETIRED` but the prior eval didn't, the status stays at its previous value for this cycle and the retirement proposal is logged. If the next eval also proposes `RETIRED`, the flip happens.

**Where it appears in ATLAS** — Card badge / label. Also exposed under the legacy alias `VELOCITY_DIRECTION` for backward compatibility.

---

<a id="prediction"></a>
### PREDICTION_SCORE / PREDICTION_FLAG / PREDICTION_ELIGIBLE

**At a glance** — These three fields together describe how likely a trend is to **grow** in the near term. They are computed once a day by a deterministic SQL pass over every live trend.

**Crucial distinction:** `HEAT_INDEX` and `PREDICTION_SCORE` are both 0–100 scores, easy to conflate.

- `HEAT_INDEX` says **how hot the trend is right now**.
- `PREDICTION_SCORE` says **how likely the trend is to grow from here**.

A trend can have low heat and a high prediction score (early-stage, accelerating). It can also have very high heat and a low prediction score (already peaked, unlikely to grow further).

### PREDICTION_SCORE

**Scale** — 0–100. Rounded to one decimal. `NULL` for trends younger than 14 days (not enough history for clean week-over-week math).

**What feeds it** — Four equal-weighted week-over-week deltas:

| Input | What it measures |
|---|---|
| Velocity acceleration | Is the trend's heat **accelerating** week over week, not just growing? |
| Inverse heat | Lower current heat = higher score (predictions favor trends that haven't peaked) |
| Source diversity expansion | Number of distinct publishers picked up the trend in the last 7d vs the prior 7d |
| Cluster formation | Number of signals linked to the trend in the last 7d vs the prior 7d |

**How it's computed** — Each input is clamped to its operating range, normalized to [0, 100], then averaged with 25% weight each. See [`prediction-flow.md`](prediction-flow.md) for the full formula.

### PREDICTION_FLAG

**Scale** — One of `Emerging` (40–65), `Watchlist` (65–80), `High Potential` (80–100), or `NULL` (score below 40 or trend too young).

### PREDICTION_ELIGIBLE

**Scale** — Boolean.

`TRUE` requires **all** of:

1. `HEAT_INDEX < 60` (not already peaked)
2. Positive velocity acceleration (actually accelerating)
3. Positive source-diversity delta (publisher breadth expanding)
4. Positive signal-count delta (cluster forming)
5. Trend age ≥ 14 days (enough history)
6. Score in the top 30% of all scored trends today (dynamic percentile)

The strict conjunction can legitimately produce **zero eligible trends** on days when the trend population is broadly decelerating — by design, the Predictions Queue stays empty rather than surfacing flat trends.

**Where it appears in ATLAS** — Prediction badge on each trend card (when `PREDICTION_FLAG` is non-null). `PREDICTION_ELIGIBLE` gates inclusion in the dedicated Predictions Queue route, which is a separate UI surface from ATLAS.

---

<a id="distinct_publisher_count"></a>
### DISTINCT_PUBLISHER_COUNT

**At a glance** — Number of unique publishers that have contributed at least one signal to this trend.

**Scale** — Integer (typically 0–50 for active trends).

**What feeds it** — Every signal linked to the trend in `FCT_TREND_SIGNALS` is mapped to a publisher domain (the actual website the signal originates from, e.g., `nytimes.com`, `vox.com`, `bsky.app`). The field counts the distinct domains.

**Why publishers and not "sources"?** A "source" in our pipeline means the *integration* that brought the signal in (GDELT, Bluesky, etc.). A "publisher" means the actual website the signal points to. **Four GDELT articles from four different news sites count as 4 publishers, not 1.** This metric is about cross-publisher resonance — a trend picked up by 12 different publishers is more credible than one mentioned 12 times by a single outlet.

**The misnomer.** The legacy alias `DISTINCT_SOURCE_COUNT` is the same value under an older, misleading name (it pre-dates the canonical Source vs Publisher distinction). It's kept for backward compatibility. Prefer `DISTINCT_PUBLISHER_COUNT` in any new query or display.

**What "good" looks like** — _TODO: empirical bands. Loose guidance: 1–2 = single-source noise, 3–5 = moderate breadth, 5+ = strong cross-publisher signal._

**Where it appears in ATLAS** — Card stat / sort criterion.

---

<a id="total_cluster_size"></a>
### TOTAL_CLUSTER_SIZE

**At a glance** — Total number of signals linked to this trend, across all publishers and sources.

**Scale** — Integer. No upper bound.

**What feeds it** — `COUNT(*)` of rows in `FCT_TREND_SIGNALS` where `TREND_ID` matches. Includes both `LINK_KIND = 'supporting'` (signals identified at promotion time) and `LINK_KIND = 'attributed'` (signals attached after the fact by the lifecycle-attribution agent).

**Cluster ≠ adjacent trends.** "Cluster size" here means the trend's signal pool — the evidence supporting *this* trend — not the count of other trends adjacent to it. For adjacent trends, see [`RELATED_TRENDS`](#related_trends).

**Where it appears in ATLAS** — Card stat.

---

<a id="related_trends"></a>
### RELATED_TRENDS

**At a glance** — Up to 5 other trends most similar to this one.

**Scale** — Array of `{trend_id, trend_name, category, similarity}` objects.

**What feeds it** — Pairwise vector cosine similarity between this trend's enrichment vector and every other trend's vector. The top 5 above a `0.65` similarity threshold are returned. Vectors are produced by the enrichment agent and stored on `FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR` (or, as a fallback, on `FCT_TRENDS.TREND_VECTOR` for legacy trends).

**Where it appears in ATLAS** — "Related trends" section on the card. Powers the Collections view as well (out of scope for this doc).

---

<a id="trend_name"></a>
### TREND_NAME (and TREND_NAME_B2B)

**At a glance** — Every trend has up to two names: a **B2C** "creative" name (e.g., "Plush Architecture") and a **B2B** "descriptive" name (e.g., "Tactile Maximalism"). ATLAS surfaces the B2C name by default. The B2B name is available as a separate field.

**Scale** — Text.

**What feeds it** — The enrichment agent. On a trend's **first enrichment**, the agent generates 5 candidate B2C names per audience and 5 B2B candidates, scores each against a corporate-media floor (sales-deck-safe, no nsfw, no crude or insult-coded names), and **freezes the winning name into `FCT_TRENDS`**. Re-enrichments emit new candidates to the enrichment ledger but **cannot** change the frozen display name — this prevents trend cards from quietly renaming themselves over time.

**How it's resolved** — The dashboard reads `TREND_NAME` via a 5-level COALESCE fallback. Levels 1–2 are the canonical path; levels 3–5 are progressively-degraded fallbacks for edge cases:

| Level | Source | When it fires |
|---|---|---|
| 1 | `FCT_TRENDS.TREND_NAME_B2C` | **Canonical.** Frozen at 1st enrichment. |
| 2 | `FCT_TRENDS.TREND_NAME_B2B` | Canonical fallback when no B2C was frozen. |
| 3 | Latest enrichment B2C | Legacy fallback for trends pre-dating the 2026-04-28 refactor. |
| 4 | Latest enrichment B2B | Same — legacy fallback. |
| 5 | Raw `TREND_TOPIC` | Last resort. Trend was promoted but never enriched. |

For any modern trend that has been enriched even once, levels 1–2 always win. Levels 3–5 are edge cases.

**Where it appears in ATLAS** — Card title. `TREND_NAME_B2B` is available wherever the descriptive name is preferred.

---

<a id="category"></a>
### CATEGORY / SUBCATEGORY / CATEGORY_CONFIDENCE / LOW_CONFIDENCE_FLAG

**At a glance** — The trend's vertical (e.g., "Food & Drink") and a more specific sub-classification within it, plus the agent's confidence in the categorization.

**Scale**
- `CATEGORY`: enum — _TODO: list of valid categories (Food & Drink, Wellness, Travel, etc.)_
- `SUBCATEGORY`: free text
- `CATEGORY_CONFIDENCE`: **0–1** (not 0–100 — different scale from heat and prediction)
- `LOW_CONFIDENCE_FLAG`: boolean; `TRUE` when `CATEGORY_CONFIDENCE < 0.6`

**What feeds it** — The enrichment agent's self-reported confidence in its category assignment. Like the names, category is **frozen** at first enrichment — re-enrichment never re-categorizes a trend.

**Where it appears in ATLAS** — Card metadata; filter / facet in the trend list.

---

<a id="narrative_fields"></a>
### Narrative fields (SUMMARY_SHORT, SUMMARY_LONG, SOCIAL_NARRATIVE, CULTURAL_DRIVERS, SEASONAL_RELEVANCE, GEOGRAPHIC_HOTSPOTS, VIBE_SHIFT)

**At a glance** — The free-text descriptions a strategist reads to understand what the trend is about. Written by the enrichment agent in a single pass.

| Field | What it is |
|---|---|
| `SUMMARY_SHORT` | One-sentence summary. |
| `SUMMARY_LONG` | Paragraph-length summary. |
| `SOCIAL_NARRATIVE` | Structured account of what people are saying on social platforms. |
| `CULTURAL_DRIVERS` | Why this trend is happening culturally. |
| `SEASONAL_RELEVANCE` | When (if at all) the trend has seasonal patterns. |
| `GEOGRAPHIC_HOTSPOTS` | Where the trend is concentrated. |
| `VIBE_SHIFT` | One-line shift narrative — what changed. |

**Scale** — Text and arrays, no numeric scoring.

**What feeds it** — Single Claude Sonnet 4.6 agent loop with live cultural grounding (Bluesky / GDELT / Grok live search). The agent reads the supporting signals, fetches additional cultural context, and writes all narrative fields in one pass.

**Refresh** — Unlike names and category, narrative fields are **not** frozen — re-enrichment can update them as a trend evolves.

**Where it appears in ATLAS** — Card description / detail pane.

---

<a id="evidence"></a>
### EVIDENCE / GENERAL_EVIDENCE / SOCIAL_EVIDENCE / OTHER_EVIDENCE

**At a glance** — The "where did this come from" pool. Each entry is a piece of supporting evidence the enrichment agent gathered or grounded against.

**Scale** — Array of objects. Each entry has at minimum a `type` (`news` / `social` / `commerce` / `reference` / `search_volume` / `video` / `other`), a `claim` (the agent's one-sentence summary of why this evidence supports the trend), and a source link.

**The four columns** are the same data sliced differently for the UI:

- `EVIDENCE` — the full typed pool.
- `GENERAL_EVIDENCE` — pre-bucketed: `news` / `commerce` entries.
- `SOCIAL_EVIDENCE` — pre-bucketed: `social` entries.
- `OTHER_EVIDENCE` — pre-bucketed: everything else (`reference` / `search_volume` / `video`).

**Refresh** — Updated whenever the trend is re-enriched.

**Where it appears in ATLAS** — Evidence sections on the trend detail pane.

---

<a id="top_signals"></a>
### TOP_SIGNALS

**At a glance** — The 5 strongest evidence entries — what the agent thinks best represents the trend.

**Scale** — Array of up to 5 entries.

**What feeds it** — First 5 entries from `EVIDENCE` with `type` in (`news`, `commerce`, `social`), preserved in the order the enrichment agent emitted them. Reference / search-volume / video entries are excluded (those are background, not "what defined the cluster").

**Where it appears in ATLAS** — "Top signals" preview on the card.

---

<a id="key_data_points"></a>
### KEY_DATA_POINTS

**At a glance** — Google Trends interest scalars for the trend, from the most recent daily poll.

**Scale** — Array of up to 2 entries:

| Entry | What it is |
|---|---|
| `interest_peak_pct` | Peak interest in the 30-day window, 0–100 (Google Trends scale) |
| `interest_avg_pct` | Average interest over the same window, 0–100 |

**What feeds it** — The `gtrends-poller` workflow runs daily and pulls Google Trends interest curves for each live trend. The two scalars from the most recent pull surface here. An empty array means the poller hasn't seen the trend yet (or Google Trends returned no data for the query).

**Where it appears in ATLAS** — Data-points section on the trend card.

---

<a id="macrotrend_tags"></a>
### MACROTREND_TAGS

**At a glance** — Higher-level theme labels the trend rolls up into (e.g., "Sustainability," "Hyper-Local," "Post-Pandemic Indoor"). Used for cross-trend grouping in dashboards and reports.

**Scale** — Array of text labels.

**What feeds it** — A separate map table, `MAP_TREND_MACROTRENDS`, which links trends to higher-level theme labels along with a `RELEVANCE_SCORE`. The dashboard returns the labels ordered by relevance, highest first. The map is populated by a separate process — _TODO: confirm whether this is currently populated, and by which workflow_.

**Where it appears in ATLAS** — Card tags row; filter / facet in the trend list.

---

### 🟡 Migrating from the Insights Agent backend

The fields below currently render on ATLAS cards but are computed by the Insights Agent backend (Marcelo's side). They will be migrated into the McClatchy pipeline. Until migration completes, these sections are placeholders with what we know from the May 22, 2026 sync.

<a id="audience_match"></a>
#### 🟡 Audience Match

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — A score derived from Chad Burton's audience data; reflects how well the trend matches the publication's target demographics.
**Scale** — TBD (confirm with Marcelo at migration time)
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="confidence_score"></a>
#### 🟡 Confidence Score

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Overall trustworthiness rollup for the trend.
**Scale** — TBD (likely 0–100; confirm)
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="content_gap"></a>
#### 🟡 Content Gap

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Whether the trend is under-covered in our existing content library (a "gap" we should fill).
**Scale** — TBD
**What feeds it** — TBD
**Where it appears in ATLAS** — TBD

<a id="revenue_potential"></a>
#### 🟡 Revenue Potential

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline. Marcelo is working with Chad on Google Search Console data; pending warehouse capacity.

**At a glance** — Estimated revenue if we publish on this trend.
**Scale** — TBD
**What feeds it** — Google Search Console data + content performance history (per the May 22 sync)
**Where it appears in ATLAS** — TBD

<a id="ai_match"></a>
#### 🟡 AI Match %

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — Vectorization-based match between the trend and items in the CSA content library. Powers the Collections graph (out of scope for this doc).
**Scale** — Percent (0–100)
**What feeds it** — LLM-driven vector comparison between the trend's enrichment payload and CSA content metadata
**Where it appears in ATLAS** — TBD (likely Collections only — confirm whether it surfaces on the main card)

<a id="overall_score"></a>
#### 🟡 Overall Score (Green / Yellow / Red)

> **Status:** Currently computed by the Insights Agent backend. Migrating to the McClatchy pipeline.

**At a glance** — A weighted rollup of Trend Strength + Audience Match + Content Gap + Revenue Potential into a single decision-friendly score with a color band.
**Scale** — 0–100 with thresholds: ≥ 75 green / 50–74 yellow / < 50 red.
**What feeds it** — The four inputs above.
**Where it appears in ATLAS** — Decision Page (out of scope for this doc). Confirm whether the color band also surfaces on the main card.

---

<a id="sources"></a>
## Where the signals come from

The pipeline knows about 15 sources today, of which roughly 10 are actively ingesting at any moment (a few are paused or intermittent — flagged per-source below). The sources fall into two functional buckets:

- **Direct platform sources** are integrations that pull from a single platform's public API or feed. These are canonical — every signal is verifiable end-to-end against the source.
- **Discovery agents** are LLMs that proactively search the public web for emerging themes every 2 hours. They return URLs we post-verify before ingesting; some signals are filtered out before they reach the trend. _LLM-mediated, with post-verification._

---

### Direct platform sources

#### `bluesky`

- **What it is** — Real-time public posts from the Bluesky social network.
- **Provides** — Original posts and engagement signals.
- **Cadence** — Streamed continuously.
- **Publisher** — Always `bsky.app` (single-platform).
- **Reliability** — Canonical.
- **Notes** — High signal volume; ideal for early cultural pattern detection.

#### `gdelt`

- **What it is** — GDELT (Global Database of Events, Language, and Tone) — a news-monitoring index covering thousands of publishers worldwide.
- **Provides** — News articles tagged by theme, location, sentiment.
- **Cadence** — _TODO: confirm current cadence (15-min default, may be throttled)_
- **Publisher** — Extracted from `METADATA:domain` per article; many publishers (NYT, WaPo, BBC, etc.).
- **Reliability** — Canonical.
- **Notes** — Requires a `User-Agent` header (default node-fetch UA gets dropped silently); some IP-based rate limiting in effect.

#### `google_trends_explore`

- **What it is** — Google Trends "Explore" data — search interest curves for specific terms.
- **Provides** — Interest scalars and trending-search-by-region.
- **Cadence** — Periodic — _TODO: confirm cadence_
- **Publisher** — Always `trends.google.com`.
- **Reliability** — Canonical.
- **Notes** — A separate `gtrends-poller` workflow pulls per-trend interest curves daily (this feeds `KEY_DATA_POINTS`).

#### `amazon_trends`

- **What it is** — Amazon trending product / search data.
- **Provides** — Trending product signals from Amazon.
- **Cadence** — Periodic — _TODO: confirm_
- **Publisher** — Always `amazon.com`.
- **Reliability** — Canonical (with aggregation — see "Notes").
- **Notes** — Signals are aggregated upstream (Amazon raw output isn't 1:1 with our `FCT_SIGNALS` rows). For aggregated signals, the `SIGNAL_ID` is a pseudo-URL — guard with an `http(s)://` check before rendering as a link.

#### `wikimedia`

- **What it is** — Wikipedia pageview signals.
- **Provides** — Pageview spikes for Wikipedia articles.
- **Cadence** — _TODO: confirm — the batch ingester was retired in late April 2026; historical data is preserved in `FCT_SIGNALS` but new ingestion may be paused. Mark active vs historical._
- **Publisher** — Always `wikipedia.org`.
- **Reliability** — Canonical.

#### `tiktok`

- **What it is** — TikTok trending signals.
- **Provides** — Trending video / sound signals.
- **Cadence** — _TODO: confirm_
- **Publisher** — Always `tiktok.com`.
- **Reliability** — Canonical, with shape caveats — _TODO: confirm whether the TikTok ingester is currently routing to the test table or to live (it was paused in April 2026 pending shape fixes)_.

#### `pinterest`

- **What it is** — Pinterest trending pins / boards.
- **Provides** — Trending content from Pinterest.
- **Cadence** — _TODO: confirm_
- **Publisher** — Always `pinterest.com`.
- **Reliability** — Canonical, with same caveats as TikTok — _TODO: confirm active vs paused_.

---

### Discovery agents

#### `agent_gemini_discovery`, `agent_grok_discovery`, `agent_chatgpt_discovery`

- **What it is** — Three discovery agents — Gemini 3.1 Pro, Grok, and ChatGPT — each proactively searching the public web for emerging themes every 2 hours. Each runs independently (separate cron triggers, separate prompts) so we can tune them in isolation.
- **Provides** — Discovered URLs with category tags and short justifications.
- **Cadence** — Every 2 hours per agent (sharded by vertical for Gemini — see below).
- **Publisher** — Extracted from the URL's `METADATA:canonical_url`. Many publishers; depends on what each agent surfaces. Vertex grounding-redirect URLs (`vertexaisearch.cloud.google.com/...`) resolve to `NULL` publisher and drop out of `DISTINCT_PUBLISHER_COUNT`.
- **Reliability** — **LLM-mediated, with post-verification.** Each returned URL is post-verified for resolvability before being ingested; some signals are filtered out before they reach a trend.

#### `gemini_food_drink`, `gemini_other`, `gemini_travel`, `gemini_wellness`

- **What it is** — Vertical-sharded Gemini discovery agents. Each instance targets a single category (Food & Drink, Wellness, Travel, "other") so prompts can be tuned per vertical.
- **Provides** — Same shape as the generic agent_*_discovery sources, but scoped to one vertical.
- **Cadence** — Every 2 hours.
- **Publisher** — From `METADATA:source_name`.
- **Reliability** — Same as discovery agents above.

#### `grok_live`

- **What it is** — Grok's live search API, used to pull real-time X (Twitter) content during enrichment.
- **Provides** — Social-platform signals grounded via Grok's search.
- **Cadence** — Called on demand by the enrichment agent.
- **Publisher** — Always `x.com`.
- **Reliability** — LLM-mediated.

---

## FAQ

#### How do I read the scores on a card? What's the scale?

Every score on the dashboard is **0–100** unless specifically noted. The exceptions:
- `CATEGORY_CONFIDENCE` is on a 0–1 scale.
- Cosine similarities in `RELATED_TRENDS` are 0–1.
- Counts (`DISTINCT_PUBLISHER_COUNT`, `TOTAL_CLUSTER_SIZE`) are integers, no upper bound.

[→ See the at-a-glance table for every field's scale](#at-a-glance--field-reference).

#### Why does this trend have two names? (e.g., "Tactile Maximalism" vs "Plush Architecture")

Each trend has up to two names — a B2C creative name (the "sexier" one) and a B2B descriptive name. The card shows the B2C name by default; the B2B name is available as a separate field (`TREND_NAME_B2B`). Both names are frozen on the trend's first enrichment to keep card identities stable over time.

[→ Trend names deep dive](#trend_name).

#### Where does the data on this dashboard come from?

About 14 sources stream signals into our pipeline 24/7 — news (GDELT), social (Bluesky, X via Grok), commerce (Amazon), search (Google Trends, Wikimedia), and a set of AI discovery agents that proactively search the public web every 2 hours.

[→ How a trend gets to your ATLAS card](#how-a-trend-gets-to-your-atlas-card) · [→ Source catalog](#sources).

#### Some of these articles look AI-generated or off-topic. Are they hallucinated?

Direct platform sources (Bluesky, GDELT, Google Trends, Amazon, Wikimedia, TikTok, Pinterest) are canonical — every signal is verifiable end-to-end against the original platform.

Discovery agents (the Gemini/Grok/ChatGPT discovery sources and the per-vertical Gemini shards) are **LLM-mediated with post-verification**. The agents search the public web and return URLs; we post-verify those URLs for resolvability before ingesting. Some signals are filtered out before they reach a trend. You may occasionally see edge-case URLs that resolve but don't read as relevant — flag them and we'll tune the prompts.

[→ Source catalog](#sources).

#### Why did this trend's heat index change since yesterday?

Heat is **EWMA-smoothed**, meaning each hour's new heat value contributes 30% and the prior smoothed value retains 70%. Single-cycle spikes or dips get dampened; sustained changes accumulate over a few cycles.

[→ HEAT_INDEX deep dive](#heat_index).

#### Why isn't this emerging trend in the Predictions Queue?

A trend qualifies for the Predictions Queue only when **all** of: `HEAT_INDEX < 60`, velocity actually accelerating, source diversity expanding, signal cluster forming, age ≥ 14 days, and score in the top 30% of all scored trends today. Missing any of these excludes the trend — and on days when the whole trend population is broadly decelerating, the queue can legitimately be empty.

[→ Prediction deep dive](#prediction).

#### What do NEW / STABLE / STAGNANT / DECLINING / RETIRED mean?

A trend's lifecycle status describes its overall trajectory:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted; not enough history yet. |
| `STABLE` | Consistent signal flow; established and active. |
| `STAGNANT` | Plateaued — not declining, but not growing. |
| `DECLINING` | Signal flow is dropping vs prior windows. |
| `RETIRED` | Gone quiet; filtered out of ATLAS. |

[→ LIFECYCLE_STATUS deep dive](#lifecycle_status).

#### How recent is this data?

The dashboard refreshes every **15 minutes**, so changes upstream take at most 15 minutes to appear on a card. Per-source ingestion cadence varies: Bluesky streams continuously, discovery agents run every 2 hours, Google Trends polls run daily, lifecycle re-evaluations run hourly, and prediction scoring runs daily.

#### What's the difference between Heat Index and Prediction Score?

Both are 0–100 and both go up when things "look good," so they're easy to conflate.

- `HEAT_INDEX` says **how hot the trend is right now**.
- `PREDICTION_SCORE` says **how likely the trend is to grow from here**.

A trend can have low heat and a high prediction score (early-stage, accelerating). A trend can also have very high heat and a low prediction score (already peaked, unlikely to grow further). Use them together, not interchangeably.

#### Why did this trend disappear from ATLAS?

`RETIRED` trends are filtered out of the main trend list. The lifecycle agent retires a trend only after two consecutive eval cycles propose retirement (a single quiet hour won't retire a trend). The trend's data is preserved in `FCT_TRENDS` and the various ledgers — it just stops being surfaced.

[→ LIFECYCLE_STATUS deep dive](#lifecycle_status).

---

<a id="glossary"></a>
## Glossary

The terms below are the ones a reader needs to make sense of this doc. The canonical glossary for the project lives in [`CONTEXT.md`](../CONTEXT.md).

| Term | Meaning |
|---|---|
| **ATLAS** | The main trend dashboard UI in the Insights Agent — the trend list / trend cards view. The audience for this document. |
| **Trend** | A cultural pattern our pipeline identified, named, and tracked. One row per trend in `FCT_TRENDS`. ATLAS only ever shows trends. |
| **Candidate** | A potential trend proposed by the distillation agent but not yet promoted. Lives in `STG_TREND_CANDIDATES`. ATLAS does **not** show candidates. |
| **Signal** | One individual data point ingested into the pipeline (a news article, a Bluesky post, a Google Trends curve). Stored in `FCT_SIGNALS`. |
| **Source** | The integration that brought a signal into the pipeline — `bluesky`, `gdelt`, `google_trends_explore`, `agent_gemini_discovery`, etc. ~14 distinct sources today. |
| **Publisher** | The actual website a signal originates from — `nytimes.com`, `vox.com`, `bsky.app`. **What `DISTINCT_PUBLISHER_COUNT` counts.** |
| **Direct platform source** | A source we ingest passively from a single platform's API — canonical, verifiable end-to-end. |
| **Discovery agent** | An LLM that proactively searches the public web and returns URLs we post-verify before ingest. Some signals are filtered out before reaching a trend. |
| **Enrichment payload** | The narrative + names + category + evidence the enrichment agent emits for one trend. Stored in `FCT_TREND_ENRICHMENT_LEDGER`. |
| **EWMA** | Exponentially-weighted moving average. The technique used to smooth `HEAT_INDEX` so single-cycle noise doesn't move the displayed number. |
| **Ledger** | An append-only table that records every decision a given agent has made. Each agent owns exactly one ledger; the current state of a trend is the latest row per `TREND_ID`. |
