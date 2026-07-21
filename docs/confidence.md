# Trend Tree — Confidence & Explainability

**Who this is for:** Anyone using the Trend Dashboard who needs to defend a decision based on it — content strategy, editorial, analyst, leadership. If a number on the screen surprises you, this doc tells you where it came from.

**Last updated:** 2026-07-21

For the technical deep-dive, see [`architecture.md`](architecture.md) and [`dashboard/data-contract.md`](dashboard/data-contract.md). For Pipedream/Snowflake context, see [`../CLAUDE.md`](../CLAUDE.md).

---

## TL;DR

A trend on the Trend Dashboard is the output of a 5-stage pipeline:

1. **Signals** are collected from 9 independent producers (3 LLM discovery agents + 6 structured ingesters).
2. **Distillation** clusters those raw signals into candidate trends.
3. **Promotion** evaluates candidates and writes the ones that clear the bar to `FCT_TRENDS`.
4. **Enrichment** runs a Claude Sonnet 4.6 agent loop that names the trend, scores it, and gathers cultural context.
5. **Lifecycle** re-evaluates every hour — heat, Lifecycle Stage (NEW / GROWING / STABLE / DECLINING / DORMANT / RESURGENT / RETIRED), and supporting evidence.

Every value you see in the Trend Dashboard is traceable to a row in a ledger table. Nothing is generated at view time.

---

## 1. Where signals come from

The system has **nine independent producers** writing to `STG_EXTERNAL_SIGNALS`. Google Trends is one of them, not the dominant share.

### LLM discovery agents (every 2 hours)

Three frontier models run independent prompts and propose signals with required citation URLs:

| Agent | Model | Search surface |
|---|---|---|
| Gemini discovery | Gemini 2.5 Flash | Google Search grounding |
| Grok discovery | Grok 4 | `web_search` + `x_search` (X/Twitter heavy) |
| ChatGPT discovery | GPT-5-mini | `web_search` (mainstream media + product launches) |

Each model gets a different prompt and a different angle. Every proposed signal **must include a citation URL**; uncited proposals are dropped at the canonicalize step.

### Structured ingestion (per-source cadence)

| Source | What it captures |
|---|---|
| Google Trends — RSS | Trending searches feed |
| Google Trends — Explore | Related-queries from the Explore API |
| Bluesky | Posts matching seed terms via ATProto `searchPosts` |
| TikTok | Hashtag rankings, Creative Center (Playwright scrape) |
| Amazon Movers & Shakers | Product trends across 6 departments |
| Pinterest | Trending content |

Each ingester runs on its own cron schedule, configured in the Pipedream UI (not in git). Check the workflow's trigger panel in Pipedream for current cadence. A separate workflow `gtrends-poller-p_13CN9KG` populates `FCT_TREND_GTRENDS_DAILY` directly (Google Trends interest for narrative/opportunity context — **no longer a heat input** since the v2 formula dropped the external factor) — it's not in the producer count above because it doesn't write to `STG_EXTERNAL_SIGNALS`.

All nine producers write to the same staging table. A 5-minute Snowflake task (`TASK_PROMOTE_SIGNALS_TO_FCT`) promotes rows to `FCT_SIGNALS` and embeds a 1024-dim vector for clustering.

### URL validation

Discovery URLs are validated before insert. Observed hallucination rate ~2% (≈1 in 50 links). Invalid URLs cause the whole signal to be dropped, not silently rewritten. We're adding a per-agent validation success rate to the audit ledger so this stops being anecdotal.

---

## 2. Heat Index — what the number means

`HEAT_INDEX` is on a **0–100 scale, hard-clamped**. It can never exceed 100. If you see a value above 100, that's a bug — please flag it.

### Formula

Fully deterministic (**formula v2, ADR-0005**). Computed by the lifecycle subagent's `computeHeatBase()` in [lifecycle-subagent-p_gYC562o/run_subagent/entry.js](../lifecycle-subagent-p_gYC562o/run_subagent/entry.js); the clamp + status factor are applied downstream in `sql/proc_lifecycle_apply.sql`:

```
heat_base         = 25·recency + 25·velocity + 40·breadth + 10·confidence
new_heat          = clamp( heat_base × (1 + status_factor/100), 0, 100 )
new_heat_smoothed = 0.5·prior_smoothed + 0.5·new_heat

status_factor: GROWING +10 | RESURGENT +10 | STABLE 0 | NEW 0 | DECLINING −10 | DORMANT −15
```

Heat is measured **only from evidence actually linked to the trend** in `FCT_TREND_SIGNALS` (link kinds `supporting` / `attributed`). Vector-similar-but-unlinked "candidate" signals score zero until the attribution agent links them. **Google Trends is no longer a heat input** (dropped 2026-07-10, #34) — demand-side interest now lives on the opportunity-score axis, so heat is pure earned-publisher-behavior.

### What each factor measures

| Factor | Weight | What it captures |
|---|---|---|
| **Recency** | 25 | Exponential decay on the newest **linked** signal's age. Half-life 120 hours (~5 days). 0 when nothing linked in 14d. |
| **Velocity** | 25 | Linked signals in the last 7 days — linear, saturating at 3/week. 0 linked = 0 pts. |
| **Breadth** | 40 | **Dominant term.** Cross-publisher resonance in the last 21 days — log of distinct active publishers × Shannon entropy. 6 evenly-distributed active domains earn the full 40. |
| **Confidence** | 10 | The `CONFIDENCE` field from `FCT_TRENDS`, set at promotion time. |

### Status factor (replaces the old LLM modifier)

There is no free-form agent modifier anymore. The lifecycle agent's judgment enters exactly once: the **status** it chooses (GROWING / STABLE / DECLINING / …) applies the fixed factor above. That status decision — and the resulting heat — is logged in `FCT_TREND_LIFECYCLE_LEDGER`.

### Reading the number

| Range | Interpretation |
|---|---|
| 0–15 | No current linked evidence; running on confidence alone |
| 15–35 | A pulse — recent activity from one or two publishers |
| 35–60 | Actively covered by several publishers this week |
| 60+ | Broad, current, multi-publisher validation; rare and meaningful |

These bands are **absolute, descriptive vignettes** (anchored on live data at the v2 cutover: median ≈ 11, ~78% of trends land 0–30 — the honest shape of linked evidence), not percentile guarantees or gates. A trend's number never changes because *other* trends changed. The Lifecycle Stage (NEW / GROWING / STABLE / etc.) is the gate. See [`dashboard/fields/heat-index.md`](dashboard/fields/heat-index.md) for the full v2 breakdown.

---

## 3. Trend naming — the single name you see

**As of the 2026-05-27 singular-name cutover, the enrichment agent emits ONE name per trend** (`trend_name`), frozen at first enrichment. Trends enriched before the cutover carry a legacy `trend_name_b2c` / `trend_name_b2b` pair; those columns still exist but are **no longer written for new trends** — they survive only as fallbacks for pre-cutover rows.

The Trend Dashboard's `TREND_NAME` column is this COALESCE at [sql/dt_trend_dashboard.sql:304](../sql/dt_trend_dashboard.sql):

```
COALESCE(
  FCT_TRENDS.TREND_NAME,             -- singular, post-2026-05-27 (frozen at first enrichment)
  FCT_TRENDS.TREND_NAME_B2C,         -- legacy fallback for pre-cutover trends
  FCT_TRENDS.TREND_NAME_B2B,         -- legacy fallback
  ENRICHMENT_LEDGER.TREND_NAME_B2C,  -- legacy ledger fallback
  ENRICHMENT_LEDGER.TREND_NAME_B2B,
  TREND_TOPIC                        -- distillation topic phrase, last resort
)
```

So for any trend enriched after the cutover you'll see the singular `TREND_NAME`; for older trends you'll see whichever legacy name was frozen first.

**Important nuance — the name is frozen at first enrichment.** `FCT_TRENDS.TREND_NAME` is written once, guarded by `WHERE TREND_NAME IS NULL` at [sql/proc_enrichment_apply.sql:175](../sql/proc_enrichment_apply.sql), and never updated after. When a trend is enriched again, the ledger gets a new row with a potentially different name, **but the Trend Dashboard keeps showing the original**. This is intentional (name stability for downstream content), so *running enrichment again to fix a bad name won't change what readers see*. Changing it after first enrichment is an explicit overwrite of `FCT_TRENDS`, not another enrichment.

If your editorial workflow needs the most-recent enrichment name, query `FCT_TREND_ENRICHMENT_LEDGER` directly — every candidate run is preserved.

### How the name is chosen

Inside the enrichment loop ([enrichment-p_xMC995w/run_enrichment_agent/entry.js:244](../enrichment-p_xMC995w/run_enrichment_agent/entry.js)):

1. The agent emits **10 candidate names**, each scored per-axis (0–10), against an anti-cliché first-beat blocklist (ADR-0001) and a corporate-media floor.
2. All 10 candidates and their scores are preserved in `name_candidates_considered` for naming-quality audit.
3. A separate **reviewer pass** (`run_name_reviewer`, ~$0.01) blind-tests the chosen name in three stages: a mechanical first-beat check, a *decoder* call that sees **only the name** and guesses what the trend is about, and a *verifier* call that compares that blind guess against the real topic + category and returns `decode_pass`, a `score`, and a single `alternate`. The write workflow swaps in the alternate based on **`decode_pass`** (did the name survive the blind-decode test) — recorded in `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:name_reviewer`.

If a name looks wrong, check the reviewer's `decode_pass` and rationale in the ledger before assuming the agent was confused — the `alternate` often captures the right framing.

---

## 4. Decision scoring (audience match / content gap / revenue potential)

**Status: in development, not yet in production.**

You may see a UI surface showing a combined score (trend strength + audience match + content gap + revenue potential, with green ≥75 / yellow 50–74 / red <50). That scoring is being built by Marcelo in coordination with Chad Burton's team to integrate Google Search Console data from Snowflake. **None of those four sub-scores exist in `FCT_TRENDS`, `DT_TREND_DASHBOARD`, or any ledger today.**

What does exist:

- **Prediction score** — separate from the Trend Dashboard heat metric. Lives in `FCT_TREND_PREDICTION_LEDGER`, computed by [prediction-agent-p_QPCkLP1/workflow.yaml:158](../prediction-agent-p_QPCkLP1/workflow.yaml). Formula: `0.25·acceleration + 0.25·inverse_heat + 0.25·source_delta + 0.25·signal_delta`. Bands: ≥80 high-potential, ≥65 watchlist, ≥40 emerging.
- **Heat** — described above. The Trend Dashboard's main "how hot is this" number, surfaced as the `HEAT_INDEX` column.

Until the decision score ships, the only production scoring is heat + prediction. Treat the UI mock accordingly.

---

## 5. Collections / clustering

The Trend Dashboard groups related trends into clusters using **two signals**:

1. **Semantic match** — vector cosine similarity on the 1024-dim signal embeddings. This produces the central groupings.
2. **LLM cluster analysis** — a Gemini pass over the semantic groups that identifies outliers and cross-cluster connections (the "faded" edges in the visualization that connect to a sibling node rather than the central node).

There is **no separate "collection" entity** in the schema — clusters are computed dynamically from trends. If a collection name doesn't match what's inside it, that's a presentation-layer issue, not a data issue.

---

## 6. What to do when a number looks wrong

1. **Find the trend ID** from the Trend Dashboard.
2. **Pull the lifecycle ledger row** for that trend — it has the heat factors and the LLM modifier with rationale.
3. **Pull the enrichment ledger row** — it has all 10 name candidates, the reviewer score, and the cultural-context findings.
4. **Pull `FCT_TREND_SIGNALS`** for that trend — every supporting signal with its source, timestamp, and URL.

Nothing in the Trend Dashboard is derived at view time. Everything traces back to a ledger row.

If after checking the ledgers the number still looks wrong, it likely is. File it and we'll dig in.

---

## Open items (as of 2026-06-09)

- [ ] Decision scoring (audience match / content gap / revenue potential) — in development with Chad Burton's team.
- [ ] Per-agent URL validation success rate in the audit ledger.
- [ ] Investigate Pierce's reported sighting of HEAT_INDEX > 100 — either reproduce or confirm legacy artifact.
- [ ] Editorial view variant: surface the most-recent enrichment `trend_name` (or the reviewer `alternate`) for content-team workflows rather than the frozen first-enrichment name.
