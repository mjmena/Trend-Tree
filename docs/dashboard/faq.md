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

Because the system has not yet made an explicit call about it. The Predictions Queue is not a percentile cut of the trend list — it is the set of trends that a live, falsifiable claim currently matches. A trend can be visibly emerging and still carry no claim, in which case its prediction fields read `NULL`. That is the honest answer, not a low score.

The old six-clause qualification (heat under 70, accelerating, publisher breadth expanding, cluster forming, age ≥ 14 days, top-30% percentile) retired on 2026-08-24 along with the deterministic scorer.

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

The dashboard refreshes every **15 minutes**, so changes upstream take at most 15 minutes to appear on a card. Per-source ingestion cadence varies: Bluesky streams continuously, discovery agents run every 2 hours, Google Trends polls run daily, lifecycle re-evaluations run hourly, and the prediction pillar generates and re-evaluates claims daily.

#### What's the difference between Heat Index and Prediction Score?

Both are 0–100, so they're easy to conflate — but they are not two views of the same thing.

- `HEAT_INDEX` says **how broadly the world is validating this trend right now**. It is a measurement of the present.
- `PREDICTION_SCORE` says **how confident we are in a specific claim about what happens next**. It is a statement about the future that can turn out to be wrong.

Heat exists for every live trend. A prediction score exists only for the few trends an active claim currently matches; everything else reads `NULL`, which means "no call", not "scored low".

#### Why did this trend disappear from ATLAS?

`RETIRED` trends are filtered out of the main trend list. The lifecycle agent retires a trend only after two consecutive eval cycles propose retirement (a single quiet hour won't retire a trend). The trend's data is preserved in `FCT_TRENDS` and the various ledgers — it just stops being surfaced.

[→ LIFECYCLE_STATUS deep dive](fields/lifecycle-status.md).

---

← Back to [hub](index.md)
