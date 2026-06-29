# Feasibility: Exploding Topics API as a validation oracle

> **SUPERSEDED (2026-06-29).** ET was purchased; the API key is live locally.
> The go/no-go this doc deliberates is moot. The binding question it raised —
> catalog match rate — was answered empirically: ~6% with our compound trend
> strings vs. **67% with atomic consumer-vernacular terms** (vocabulary
> mismatch, not domain skew). ET is now a tool to optimize against, via the
> **trend descriptor** (`descriptor.query`). See
> [`docs/adr/0003-trend-descriptor-machine-facing-canonical-artifact.md`](adr/0003-trend-descriptor-machine-facing-canonical-artifact.md).
> Kept for archaeology only.

**Status:** ~~Draft / pre-decision~~ Superseded · **Date:** 2026-06-16 · **Owner:** Marty

## The question

Should we buy Exploding Topics (ET) — at the quoted **$1,000/mo for 1,000 API
requests** plus dashboard access — to use as an **external validation oracle**
for our own trend pipeline? Specifically, to ground-truth our
`PREDICTION_SCORE` / distillation candidates against an independent
growth-data source.

This doc evaluates fit, the binding constraint, and the single number the
go/no-go actually hinges on (catalog match rate). It does **not** evaluate ET
as a discovery source or a replacement for our discovery tier — that's a
separate framing.

## What ET actually is (verified 2026-06-16)

| Property | Value | Source |
|---|---|---|
| Catalog size | 1.1M+ trends | TickerTrends review |
| History | up to 15 years | TickerTrends review |
| Update cadence | **daily** (not real-time) | TickerTrends review |
| Per-trend data | growth trajectory, search volume, category (31+), related/"meta" trends, associated products & startups | ET pricing / reviews |
| Growth method | analytics + ML + **human validation** to filter short-lived fads | TickerTrends review |
| Published API | included in **Business plan, $249/mo**, **60 req/min** | ET pricing / reviews |

**Pricing discrepancy — confirm first.** ET's published Business tier is
**$249/mo with API access and a 60 req/min limit**, with no stated monthly
request cap. The **$1,000/mo for 1,000 requests** we were quoted is therefore
an enterprise/custom offer, a different product, or stale. Before anything
else, get ET sales to put in writing: (a) what the $1,000 tier includes over
the $249 Business plan, (b) whether 1,000/mo is a hard cap or a soft rate, and
(c) whether the cheaper $249 tier's API would already serve this use case. If
$249 covers it, the rest of this doc is moot — just buy that.

## Why "validation oracle" is the right frame for us

We already generate trends (multi-LLM discovery → distillation → promotion)
and already score emergence deterministically (`PREDICTION_SCORE` 0–100,
`PREDICTION_FLAG` Emerging/Watchlist/High Potential). What we **don't** have is
an independent ground truth to answer: *are the trends we flag as emerging
actually emerging in the real world, or are they LLM-confident noise?*

ET gives an external, human-validated growth signal per topic. That lets us:

- **Measure precision** of our prediction agent: of trends we flag "Emerging,"
  what fraction does ET independently show as growing vs. flat/peaked?
- **Calibrate thresholds** — tune `PREDICTION_SCORE` cutoffs against an outside
  benchmark instead of self-referentially.
- **Catch false positives** — a promoted trend ET has *never heard of* is a
  signal the trend may be thin or hallucinated (caveat below).

This is a measurement/QA use, not a production data dependency — which is the
right risk posture for a paid external API.

## The binding constraint: catalog match rate

**This is the whole ballgame.** ET keys on its own 1.1M-topic catalog. Our
trends are LLM-distilled phrases. The oracle only validates the subset of our
trends that **exist as an ET topic**. Two ways this bites:

1. **Vocabulary mismatch** — our trend names won't be ET's canonical topic
   strings; lookups need fuzzy/semantic matching, and misses are ambiguous
   ("not trending" vs. "not in catalog").
2. **Domain skew** — ET skews consumer/ecommerce/tech/startup. McClatchy's
   value is often **local + news** trends. Those are systematically *absent*
   from ET, so the oracle would validate exactly the trends we differentiate
   *least* on and stay silent on the ones we care about most.

If match rate against our promoted trends is low (say <40%), ET validates a
non-representative slice and the oracle is close to useless for us — regardless
of how good ET's data is on the topics it does cover.

**→ Measure this before buying.** Pull ~50–100 recent promoted trends from
`FCT_TRENDS`, request a trial/eval key (or one month of the cheapest API tier),
look each up in ET, and report the match rate + whether matches skew away from
our local/news trends. That one number gates the decision and costs ~$249 or a
free trial to get — far cheaper than committing to $12k/yr on a guess.

## Quota math (1,000 req/mo)

1,000/mo ≈ **33 lookups/day**. Whether that's enough depends on our promotion
volume (TODO: pull promotions/mo from `FCT_TRENDS`):

- If we promote **< ~1,000 trends/mo**, we can validate every promoted trend
  once at promotion time — fine.
- If we want **time-series re-checks** (validate the same trend weekly to see
  if our lifecycle call tracks ET's curve), the budget shrinks fast: 33/day
  shared across new + recheck.

The 60 req/min rate is irrelevant for a batch QA job; the **monthly cap** is
the real ceiling. Sizing it requires the promotion-rate number.

## Dashboard access (secondary value)

The bundle includes the ET dashboard, not just the API. Soft value, separate
from the oracle use: a manual exploration surface for the team, plus ET's
meta-trends / trending-products / startup tracking — potentially useful input
to the audience / content-gap / monetization roadmap. Nice-to-have, not a
reason to buy on its own; weigh it only if the API case is already marginal.

## Build-vs-buy note

We can't cheaply rebuild ET's 15-year, human-validated, 1.1M-topic search-volume
corpus — that's genuinely buy-not-build. But as a *validation oracle* we don't
need their whole product; we need growth/volume on the specific topics we
promote. Confirm whether the $249 Business API already delivers that at our
volume before paying 4× for the enterprise tier.

## Open questions for ET sales

1. What does $1,000/mo include over the $249 Business plan? Is 1,000/mo a hard
   cap or a soft rate limit?
2. Is there a **trial/eval API key** so we can measure match rate first?
3. How are topics queried — exact ID, search string, semantic match? What's
   returned on a miss?
4. What growth/volume fields exactly, and at what time granularity (daily
   points? monthly?) for the time series?
5. Licensing: can ET-derived numbers be surfaced in our internal dashboards /
   shared in reports?

## Recommendation

**Don't commit to $1,000/mo yet.** The decision hinges on one measurable
number — catalog match rate against *our* promoted trends, weighted by our
local/news skew — and on resolving the $249-vs-$1,000 pricing gap. Next action:
get a trial key (or one month of the $249 API), run the match-rate probe on
~50–100 trends from `FCT_TRENDS`, and decide from data. If match rate is high
and skewed toward trends we care about, ET is a cheap, well-fit QA layer; if
it's low or news/local-blind, it's the wrong oracle at any price.

---

*ponytail: kept this to the decision and its one binding risk (match rate)
instead of a full vendor-evaluation template. Expand sections only if the
trial confirms ET is worth a real procurement writeup.*

Sources: [ET pricing](https://tipsonblogging.com/2025/05/exploding-topics-pricing/) ·
[TickerTrends comparison](https://blog.tickertrends.io/p/exploding-topics-platform-review-or-tickertrends-comparison)
