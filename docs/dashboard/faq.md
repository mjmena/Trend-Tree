<!-- Title: FAQ -->
<!-- Parent: ATLAS Dashboard -->

# FAQ

#### How do I read the scores on a card? What's the scale?

Every score on the dashboard is **0–100** unless specifically noted. The exceptions:
- `CATEGORY_CONFIDENCE` is on a 0–1 scale.
- Cosine similarities in `RELATED_TRENDS` are 0–1.
- Counts (`DISTINCT_PUBLISHER_COUNT`, `TOTAL_CLUSTER_SIZE`) are integers, no upper bound.

[→ See the at-a-glance table for every field's scale](index.md#at-a-glance--field-reference).

#### Why does this trend have two names? (e.g., "Tactile Maximalism" vs "Plush Architecture")

Each trend has up to two names — a B2C creative name (the "sexier" one) and a B2B descriptive name. The card shows the B2C name by default; the B2B name is available as a separate field (`TREND_NAME_B2B`). Both names are frozen on the trend's first enrichment to keep card identities stable over time.

[→ Trend names deep dive](fields/trend-name.md).

#### Where does the data on this dashboard come from?

About 14 sources stream signals into our pipeline 24/7 — news (GDELT), social (Bluesky, X via Grok), commerce (Amazon), search (Google Trends, Wikimedia), and a set of AI discovery agents that proactively search the public web every 2 hours.

[→ How a trend gets to your ATLAS card](index.md#how-a-trend-gets-to-your-atlas-card) · [→ Source catalog](sources.md).

#### Some of these articles look AI-generated or off-topic. Are they hallucinated?

Direct platform sources (Bluesky, GDELT, Google Trends, Amazon, Wikimedia, TikTok, Pinterest) are canonical — every signal is verifiable end-to-end against the original platform.

Discovery agents (the Gemini/Grok/ChatGPT discovery sources and the per-vertical Gemini shards) are **LLM-mediated with post-verification**. The agents search the public web and return URLs; we post-verify those URLs for resolvability before ingesting. Some signals are filtered out before they reach a trend. You may occasionally see edge-case URLs that resolve but don't read as relevant — flag them and we'll tune the prompts.

[→ Source catalog](sources.md).

#### Why did this trend's heat index change since yesterday?

Heat is **EWMA-smoothed**, meaning each hour's new heat value contributes 30% and the prior smoothed value retains 70%. Single-cycle spikes or dips get dampened; sustained changes accumulate over a few cycles.

[→ HEAT_INDEX deep dive](fields/heat-index.md).

#### Why isn't this emerging trend in the Predictions Queue?

A trend qualifies for the Predictions Queue only when **all** of: `HEAT_INDEX < 60`, velocity actually accelerating, source diversity expanding, signal cluster forming, age ≥ 14 days, and score in the top 30% of all scored trends today. Missing any of these excludes the trend — and on days when the whole trend population is broadly decelerating, the queue can legitimately be empty.

[→ Prediction deep dive](fields/prediction.md).

#### What do NEW / STABLE / STAGNANT / DECLINING / RETIRED mean?

A trend's lifecycle status describes its overall trajectory:

| Status | Meaning |
|---|---|
| `NEW` | Recently promoted; not enough history yet. |
| `STABLE` | Consistent signal flow; established and active. |
| `STAGNANT` | Plateaued — not declining, but not growing. |
| `DECLINING` | Signal flow is dropping vs prior windows. |
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
