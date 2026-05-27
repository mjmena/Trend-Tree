<!-- Title: Prediction (Score / Flag / Eligible) -->
<!-- Parent: ATLAS Dashboard -->

# PREDICTION_SCORE / PREDICTION_FLAG / PREDICTION_ELIGIBLE

**At a glance** — These three fields together describe how likely a trend is to **grow** in the near term. They are computed once a day by a deterministic SQL pass over every live trend.

**Crucial distinction:** `HEAT_INDEX` and `PREDICTION_SCORE` are both 0–100 scores, easy to conflate.

- [`HEAT_INDEX`](heat-index.md) says **how hot the trend is right now**.
- `PREDICTION_SCORE` says **how likely the trend is to grow from here**.

A trend can have low heat and a high prediction score (early-stage, accelerating). It can also have very high heat and a low prediction score (already peaked, unlikely to grow further).

## PREDICTION_SCORE

**Scale** — 0–100. Rounded to one decimal. `NULL` for trends younger than 14 days (not enough history for clean week-over-week math).

**What feeds it** — Four equal-weighted week-over-week deltas:

| Input | What it measures |
|---|---|
| Velocity acceleration | Is the trend's heat **accelerating** week over week, not just growing? |
| Inverse heat | Lower current heat = higher score (predictions favor trends that haven't peaked) |
| Source diversity expansion | Number of distinct publishers picked up the trend in the last 7d vs the prior 7d |
| Cluster formation | Number of signals linked to the trend in the last 7d vs the prior 7d |

**How it's computed** — Each input is clamped to its operating range, normalized to [0, 100], then averaged with 25% weight each. See [`prediction-flow.md`](../../prediction-flow.md) for the full formula.

## PREDICTION_FLAG

**Scale** — One of `Emerging` (40–65), `Watchlist` (65–80), `High Potential` (80–100), or `NULL` (score below 40 or trend too young).

## PREDICTION_ELIGIBLE

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

← Back to [field reference](../index.md#at-a-glance--field-reference)
