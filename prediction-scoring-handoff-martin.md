# Prediction Scoring System - Handoff for Martin Mena

_From: Marcelo Freitas - May 12, 2026_

---

## What We Are Building

Adding a Prediction Scoring layer to the Insights Agent that surfaces emerging trends **before** they reach high Heat Index values. Strategists will see a Predictions Queue in the dashboard where they can Approve or Dismiss eligible trends. Their decisions persist to the database and will eventually feed training datasets to improve prediction accuracy over time.

This is a critical feature confirmed by Jason Smith. The frontend and backend are being built now. **The only blocker is the Snowflake pipeline fields described below.**

---

## What I Need From You

Three new fields added to `MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD`:

| Field                   | Type            | Description                                            |
| ----------------------- | --------------- | ------------------------------------------------------ |
| `PREDICTION_SCORE`    | INTEGER (0-100) | Emergence signal strength. Higher = stronger.          |
| `PREDICTION_FLAG`     | VARCHAR         | One of:`Emerging`, `Watchlist`, `High Potential` |
| `PREDICTION_ELIGIBLE` | BOOLEAN         | Whether the trend qualifies for the prediction queue   |

These must be available as columns in `DT_TREND_DASHBOARD` - same table we already query for Heat Index, Velocity, Cluster Size, etc.

---

## How `PREDICTION_SCORE` Should Be Calculated

Four input signals from the Agent Smith pipeline. These are the agreed scoring inputs:

**1. Velocity Acceleration**
Not just direction (`GROWING`) - the *rate* of acceleration. A trend growing faster this week than last week scores higher than one growing at a constant rate. Delta in velocity, not velocity itself.

**2. Low Base Volume**
Predictions are for trends that haven't peaked yet. A trend already at high Heat Index is excluded by design. The score should drop for trends with high absolute Heat Index values, regardless of acceleration.

**3. Source Diversity Expansion**
The number of distinct sources picking up the trend is increasing. Early-stage trends show source diversity growing *before* overall volume does. Expanding `DISTINCT_SOURCE_COUNT` week-over-week is a strong signal.

**4. Early Cluster Formation**
New related trends appearing around the candidate. The cluster is forming, not fully formed. Growth in `RELATED_TRENDS` connections or cluster size delta is the indicator.

---

## Flag Definitions

| Flag               | Score Range | Meaning                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------- |
| `Emerging`       | ~40-65      | Early signals present, volume still low. Worth watching.         |
| `Watchlist`      | ~65-80      | Acceleration confirmed, sources diversifying. Research priority. |
| `High Potential` | ~80-100     | Strong emergence signal across all four inputs. Act on it.       |

---

## `PREDICTION_ELIGIBLE` Logic

A trend qualifies (`PREDICTION_ELIGIBLE = TRUE`) when all of the following are true:

- Heat Index is **not** already high (not a peaked trend)
- Positive velocity acceleration (getting faster, not slowing)
- Emerging cluster formation (new connections appearing)
- Expanding source count week-over-week

**Target:** approximately 30% of trends should be eligible at any given time. This is a product design target - you control the threshold logic in the pipeline. It should be dynamic, not a fixed count.

---

## Hard Constraint - Isolation from Heat Index

**Prediction data must never influence Heat Index calculations.**

`PREDICTION_SCORE`, `PREDICTION_FLAG`, and `PREDICTION_ELIGIBLE` are additive fields only. They are read by the Insights Agent frontend as separate columns. They must not be factored into `HEAT_INDEX`, `VELOCITY_DIRECTION`, or any existing trend scoring logic.

This is a product requirement confirmed by Jason Smith.

---

## What I Am Building on My End

So you know what your fields are wiring into:

- **Predictions Queue** (`/predictions` route in the Insights Agent) - shows only `PREDICTION_ELIGIBLE = TRUE` trends, sorted by `PREDICTION_SCORE` descending
- **Prediction Badge** - renders on each trend card with the `PREDICTION_FLAG` label and score
- **Approve / Dismiss** - strategist actions persist to a `prediction_decisions` PostgreSQL table with `prediction_score` and `prediction_flag` stored at decision time (for future training data)
- **Heat Index display** - unchanged, completely separate from prediction fields

My code already maps `prediction_score` and `prediction_flag` from the API response. The moment your fields appear in `DT_TREND_DASHBOARD`, the UI lights up automatically. I am running mock data locally in the meantime.

---

## Current Status

| Item                                               | Owner            | Status         |
| -------------------------------------------------- | ---------------- | -------------- |
| `PREDICTION_SCORE` in `DT_TREND_DASHBOARD`     | **Martin** | ⬜ Not started |
| `PREDICTION_FLAG` in `DT_TREND_DASHBOARD`      | **Martin** | ⬜ Not started |
| `PREDICTION_ELIGIBLE` in `DT_TREND_DASHBOARD`  | **Martin** | ⬜ Not started |
| Agent Smith pipeline scoring logic                 | **Martin** | ⬜ Not started |
| Backend `prediction_decisions` table + endpoints | Marcelo          | 🟡 In progress |
| Frontend `PredictionsView` + `PredictionBadge` | Marcelo          | 🟡 In progress |
| Mock enrichment (`PREDICTION_MOCK=true`)         | Marcelo          | 🟡 In progress |
| Deploy to CSA from Predictions Queue               | Marcelo          | ⬜ Next phase  |

---

## Open Questions for Martin

1. **Timeline** - when can the three fields realistically be in `DT_TREND_DASHBOARD`? Even a rough estimate helps me plan the mock-to-real switchover.
2. **Velocity acceleration data** - do you currently track velocity delta week-over-week in the pipeline, or does this need to be computed fresh?
3. **Source diversity delta** - is `DISTINCT_SOURCE_COUNT` already tracked historically, or is this a new metric to instrument?
4. **Cluster formation delta** - is the growth rate of `RELATED_TRENDS` / cluster size accessible from the pipeline, or needs new instrumentation?
5. **Thresholds** - are you comfortable owning the score thresholds (what maps to Emerging vs Watchlist vs High Potential), or do you want Jason to sign off on the ranges first?

---

## How to Test Once Live

When your fields are in `DT_TREND_DASHBOARD`, the switchover on my end is:

1. Set `PREDICTION_MOCK=false` in the backend `.env`
2. Add `PREDICTION_SCORE`, `PREDICTION_FLAG`, `PREDICTION_ELIGIBLE` to the SELECT in `snowflake_service.py`
3. Rebuild backend container

That is it. Everything else is already wired. Happy to test together once the fields are available.
