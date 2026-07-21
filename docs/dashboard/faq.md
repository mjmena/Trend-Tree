<!-- Title: FAQ -->
<!-- Parent: ATLAS Dashboard -->

# FAQ

#### How do I read the scores on a card? What's the scale?

Every score on the dashboard is **0–100** unless specifically noted. The exceptions:
- `CATEGORY_CONFIDENCE` is on a 0–1 scale.
- Cosine similarities in `RELATED_TRENDS` are 0–1.
- Counts (`DISTINCT_PUBLISHER_COUNT`, `TOTAL_CLUSTER_SIZE`) are integers, no upper bound.

[→ See the at-a-glance table for every field's scale](index.md#at-a-glance--field-reference).

#### What is the trend's name, and can it change?

Each trend has a single **canonical name** (`TREND_NAME`), frozen on its first enrichment to keep card identities stable over time. The older dual B2C/B2B naming scheme was **retired at the 2026-05-27 singular-name cutover** (ADR-0001); `TREND_NAME_B2B` survives only as a legacy fallback for trends that pre-date the cutover.

[→ Trend names deep dive](fields/trend-name.md).

#### Where does the data on this dashboard come from?

About 14 sources feed signals into our pipeline — news (GDELT), social (Bluesky, X via Grok), commerce (Amazon), search (Google Trends), and a set of AI discovery agents that proactively search the public web every 2 hours. Some sources ingest on a schedule; others (GDELT, X via Grok) are pulled on-demand when the agents reason about a specific trend.

[→ How a trend gets to your ATLAS card](index.md#how-a-trend-gets-to-your-atlas-card) · [→ Source catalog](sources.md).

#### Some of these articles look AI-generated or off-topic. Are they hallucinated?

Direct platform sources (Bluesky, GDELT, Google Trends, Amazon, Wikimedia, Pinterest) are canonical — every signal is verifiable end-to-end against the original platform. (TikTok was scrapped on 2026-06-09 and is no longer ingesting.)

Discovery agents (the Gemini/Grok/ChatGPT discovery sources and the per-vertical Gemini shards) are **LLM-mediated with post-verification**. The agents search the public web and return URLs; we post-verify those URLs for resolvability before ingesting. Some signals are filtered out before they reach a trend. You may occasionally see edge-case URLs that resolve but don't read as relevant — flag them and we'll tune the prompts.

[→ Source catalog](sources.md).

#### Why did this trend's heat index change since yesterday?

Heat is **EWMA-smoothed** (α=0.5), meaning each hour's new heat value contributes 50% and the prior smoothed value retains 50%. Single-cycle spikes or dips get dampened; sustained changes accumulate over a few cycles.

[→ HEAT_INDEX deep dive](fields/heat-index.md).

#### Why isn't this emerging trend in the Predictions Queue?

A trend qualifies for the Predictions Queue only when **all** of: `HEAT_INDEX < 70`, velocity actually accelerating, source diversity expanding, signal cluster forming, age ≥ 14 days, and score in the top 30% of all scored trends today. Missing any of these excludes the trend — and on days when the whole trend population is broadly decelerating, the queue can legitimately be empty.

[→ Prediction deep dive](fields/prediction.md).

#### What do NEW / GROWING / STABLE / DECLINING / DORMANT / RESURGENT / RETIRED mean?

A trend's lifecycle status describes its overall trajectory:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted; not enough history yet. |
| `GROWING` | Heat increasing; signal volume trending up. |
| `STABLE` | Consistent signal flow; established and active. |
| `DECLINING` | Signal flow is dropping vs prior windows. |
| `DORMANT` | Heat low and flat; signal volume thin. |
| `RESURGENT` | Previously dormant; heat spiking again. |
| `RETIRED` | Gone quiet; filtered out of ATLAS. |

[→ LIFECYCLE_STATUS deep dive](fields/lifecycle-status.md).

#### How recent is this data?

The dashboard refreshes every **15 minutes**, so changes upstream take at most 15 minutes to appear on a card. Per-source ingestion cadence varies: Bluesky streams continuously, discovery agents run every 2 hours, Google Trends polls run daily, lifecycle re-evaluations run hourly, and prediction scoring runs daily.

#### What's the difference between Heat Index and Prediction Score?

Both are 0–100 and both go up when things "look good," so they're easy to conflate.

- `HEAT_INDEX` says **how hot the trend is right now**.
- `PREDICTION_SCORE` says **how likely the trend is to grow from here**.

A trend can have low heat and a high prediction score (early-stage, accelerating). A trend can also have very high heat and a low prediction score (already peaked, unlikely to grow further). Use them together, not interchangeably.

#### Why did this trend disappear from ATLAS?

`RETIRED` trends are filtered out of the main trend list. The lifecycle agent retires a trend only after two consecutive eval cycles propose retirement (a single quiet hour won't retire a trend). The trend's data is preserved in `FCT_TRENDS` and the various ledgers — it just stops being surfaced.

[→ LIFECYCLE_STATUS deep dive](fields/lifecycle-status.md).

---

← Back to [hub](index.md)
