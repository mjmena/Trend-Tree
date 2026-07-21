# Prediction Fields — Consumer Contract

Field contract for downstream consumers of the emergence-prediction outputs
(`PREDICTION_SCORE` / `PREDICTION_FLAG` / `PREDICTION_ELIGIBLE`). For how these
are computed see [`prediction-flow.md`](prediction-flow.md); for the full data
model see [`dashboard/data-contract.md`](dashboard/data-contract.md). Produced by `prediction-agent-p_QPCkLP1`.

> **`COMPUTATION_VERSION = v2` (2026-06-08, issue #33).** The two link-based
> scoring *inputs* (source-diversity, cluster-formation) were redefined from
> week-over-week volume differences to **cumulative-set growth**, and the
> eligibility gates were loosened. **No columns were added, removed, or
> renamed, and no types changed** — this is a semantics + distribution change
> behind a stable column contract. Consumers do not need to migrate.

---

## What you read depends on the surface

| Surface | Object | Refresh | Sees |
|---|---|---|---|
| **Dashboard view** (e.g. Insights Agent) | `MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD` | 15 min (dynamic table) | The 3 public fields only |
| **Ledger** (audit / analytics) | `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER` | per scoring run (append-only) | Public fields **+** all inputs + `COMPUTATION_VERSION` |

The deltas and `COMPUTATION_VERSION` are **ledger-only** — they are *not*
projected onto `DT_TREND_DASHBOARD`. A dashboard-view consumer cannot key on
`COMPUTATION_VERSION`; for them the change is fully transparent.

---

## Public fields (on `DT_TREND_DASHBOARD` and in the ledger)

| Field | Type | Range / values | Nullable | Meaning |
|---|---|---|---|---|
| `PREDICTION_SCORE` | NUMBER | `0.0`–`100.0`, 1 decimal | **yes** | Likelihood the trend will *grow* from here. `NULL` when the trend is younger than 14 days or is missing a heat window (not scoreable yet). |
| `PREDICTION_FLAG` | TEXT | `Emerging` \| `Watchlist` \| `High Potential` \| `NULL` | **yes** | Banded view of `PREDICTION_SCORE` (see bands below). `NULL` when score `< 40` or `NULL`. |
| `PREDICTION_ELIGIBLE` | BOOLEAN | `TRUE` \| `FALSE` | yes | Whether the trend qualifies for the Predictions Queue. |

### `PREDICTION_FLAG` bands

Half-open intervals on `PREDICTION_SCORE`:

| Flag | Score |
|---|---|
| `Emerging` | `40 ≤ score < 65` |
| `Watchlist` | `65 ≤ score < 80` |
| `High Potential` | `80 ≤ score ≤ 100` |
| `NULL` | `score < 40` or `score IS NULL` |

### `PREDICTION_ELIGIBLE` — `TRUE` requires **all** of

1. `PREDICTION_SCORE IS NOT NULL`
2. `INPUT_HEAT_NOW < 70` — not already peaked (see gate note below)
3. `INPUT_ACCELERATION > 0` — heat is accelerating
4. `INPUT_SOURCE_DELTA > 0 OR INPUT_SIGNAL_DELTA > 0` — gained ≥1 new publisher or signal in the last 7d
5. `DAYS_SINCE_PROMOTION >= 14`
6. `INPUT_SCORE_PERCENTILE >= 0.70` — top 30% of scored trends that run

On a typical run ~15–20% of scored trends are eligible. The queue can be small
on broadly-decelerating days but is rarely empty.

> **Gate note (heat formula v2, 2026-07-10 — ADR-0005).** The `heat_now < 70`
> threshold was calibrated against the old compressed 0–77 heat scale. Heat v2
> (linked evidence only) drops levels ~30 pts board-wide, so for ~1–2 weeks
> after cutover `INPUT_ACCELERATION` reads as global deceleration and the
> Predictions Queue will go quiet before it recovers. Re-derive the gate (and
> the acceleration expectations above) against the v2 distribution once
> post-cutover history exists — tracked as the #33 recalibration follow-up.

**Isolation guarantee:** prediction fields never influence `HEAT_INDEX`,
`LIFECYCLE_STATUS`, or any other scoring path (product requirement). They are
additive, read-only outputs.

---

## Ledger-only fields (`FCT_TREND_PREDICTION_LEDGER`)

Audit/lineage columns, one row per (trend, run). Only relevant if you read the
ledger directly rather than the dashboard view.

| Field | Type | Notes |
|---|---|---|
| `COMPUTATION_VERSION` | TEXT | `v1` = old weekly-volume delta logic, `v2` = current cumulative-growth logic. Key on this to distinguish rows across the formula change. |
| `INPUT_SOURCE_DELTA` | FLOAT | New distinct publisher domains first-linked in the last 7d. **Non-negative** under `v2`; backfill-insensitive. |
| `INPUT_SIGNAL_DELTA` | FLOAT | New distinct signals first-linked in the last 7d. **Non-negative** under `v2`. |
| `INPUT_SOURCES_LAST_7D` / `INPUT_SOURCES_PRIOR_7D` | NUMBER | Cumulative distinct publisher count as of now / as of 7d ago (`v2`). In `v1` rows these were single-week volumes. |
| `INPUT_SIGNALS_LAST_7D` / `INPUT_SIGNALS_PRIOR_7D` | NUMBER | Cumulative distinct signal count as of now / as of 7d ago (`v2`). |
| `INPUT_HEAT_NOW` / `INPUT_HEAT_7D` / `INPUT_HEAT_14D` | FLOAT | Smoothed heat at three anchors (lifecycle ledger). |
| `INPUT_ACCELERATION` | FLOAT | `(heat_now − heat_7d) − (heat_7d − heat_14d)`. |
| `INPUT_INVERSE_HEAT` | FLOAT | `100 − heat_now`. |
| `INPUT_SCORE_PERCENTILE` | FLOAT | `PERCENT_RANK()` of this trend's score in the run. |
| `DAYS_SINCE_PROMOTION` | NUMBER | `DATEDIFF(day, PROMOTED_AT, now)`. |
| `EVALUATED_AT` / `CHAIN_ID` / `PREDICTION_EVAL_ID` / `TREND_ID` | — | Run metadata; current state = latest `EVALUATED_AT` per trend. |

---

## Example rows (live `v2` data, 2026-06-08)

Five real trends covering every field state. Deltas shown as `prior → now (Δ)`.

| Scenario | `SCORE` | `FLAG` | `ELIGIBLE` | heat_now | accel | source Δ | signal Δ | pct | age |
|---|---|---|---|---|---|---|---|---|---|
| High Potential, eligible | `82.9` | `High Potential` | `TRUE` | 48.7 | +18.1 | 1 → 3 (+2) | 5 → 9 (+4) | 1.00 | 41 |
| Watchlist, eligible (cold + accelerating) | `77.6` | `Watchlist` | `TRUE` | 22.6 | +19.8 | 2 → 4 (+2) | 5 → 7 (+2) | 0.98 | 31 |
| Emerging, **not** eligible (already too hot) | `56.0` | `Emerging` | `FALSE` | 76.1 | +44.2 | 10 → 11 (+1) | 12 → 14 (+2) | 0.90 | 41 |
| Scored but below flag (decelerating, flat) | `18.2` | `NULL` | `FALSE` | 48.0 | −17.6 | 1 → 1 (0) | 74 → 74 (0) | 0.00 | 41 |
| Not scored (trend < 14 days old) | `NULL` | `NULL` | `FALSE` | 71.2 | +10.8 | 11 → 11 (0) | 15 → 15 (0) | `NULL` | 13 |

Reading the "why":

- **Row 1** passes every gate — accelerating, real growth (+2 publishers, +4 signals), not peaked, top percentile.
- **Row 2** is the classic early-stage win: very low heat (22.6) and accelerating, so it scores high on inverse-heat + acceleration even with modest deltas.
- **Row 3** scores `Emerging` and is growing, but `heat_now = 76.1 ≥ 70` → fails the "not peaked" gate, so `ELIGIBLE = FALSE`. This is the anti-correlation in action: hot trends gain attribution but are excluded as already-peaked.
- **Row 4** is decelerating (`accel < 0`) with zero cumulative growth → low score, no flag, not eligible. (Note the *cumulative* `signal Δ = 0` even though 74 signals are linked — none are *new* this week.)
- **Row 5** is 13 days old → `SCORE`/`FLAG`/`PERCENTILE` are all `NULL` by the young-trend rule, regardless of healthy inputs.

> The dashboard view (`DT_TREND_DASHBOARD`) shows only the first three columns
> (`SCORE` / `FLAG` / `ELIGIBLE`); the input columns above come from the ledger.

---

## Migration checklist for consumers

- **Reading `DT_TREND_DASHBOARD`:** no action. Same 3 columns, same types. Expect a *larger, steadier* eligible population and non-empty `Watchlist` / `High Potential` tiers.
- **Reading the ledger:** the `INPUT_*_DELTA` and `INPUT_*_7D` columns changed meaning (now cumulative). Filter on `COMPUTATION_VERSION = 'v2'` if you mix runs from before/after 2026-06-08.
