# Prediction (Emergence) Scoring

The Predictions Queue in the Insights Agent surfaces emerging trends *before* their heat peaks. Strategists Approve/Dismiss eligible trends, and those decisions persist to a Postgres table on the Insights side as future training data.

This doc covers the McClatchy-side pipeline only: how `PREDICTION_SCORE`, `PREDICTION_FLAG`, and `PREDICTION_ELIGIBLE` are computed and surfaced on `DT_TREND_DASHBOARD`.

For Pipedream wiring see [`architecture.md`](architecture.md#prediction-agent-p_qpcklp1). For the column shapes see [`schema.md`](schema.md#prediction-emergence-columns).

---

## Hard constraint: isolation from Heat Index

Prediction values **must never** influence `HEAT_INDEX`, `LIFECYCLE_STATUS`, or any other trend-scoring path (product requirement from Jason Smith).

The architecture enforces this by construction:

- Predictions live in their own ledger (`FCT_TREND_PREDICTION_LEDGER`) owned by a dedicated workflow (`prediction-agent-p_QPCkLP1`).
- The lifecycle agent, promotion agent, and enrichment agent never read it.
- The dashboard adds the 3 prediction columns as `LEFT JOIN`'d additive fields, not inputs to any other CTE.

---

## Inputs

Four inputs computed live from existing time-series tables. No snapshot table required (and `FCT_TREND_DAILY_SNAPSHOTS` was retired with the Louvain cleanup on 2026-04-28). The two heat inputs are week-over-week heat differences; the two link inputs are **cumulative-set growth** (see note below).

| Input | Source | Expression |
|---|---|---|
| Velocity acceleration | `FCT_TREND_LIFECYCLE_LEDGER.NEW_HEAT_SMOOTHED` | `(heat_now − heat_7d) − (heat_7d − heat_14d)` |
| Low base volume (inverse heat) | same | `100 − heat_now` |
| Source diversity expansion | `FCT_TREND_SIGNALS.LINKED_AT` + `FCT_SIGNALS.METADATA` | (distinct publisher domains ever-linked **as of now**) − (distinct domains ever-linked **as of 7d ago**) — i.e. domains whose *first* link to this trend landed in the last 7d |
| Cluster formation | `FCT_TREND_SIGNALS.LINKED_AT` | (distinct signal_ids ever-linked **as of now**) − (distinct signal_ids ever-linked **as of 7d ago**) — i.e. signals first-linked in the last 7d |

The `heat_7d` and `heat_14d` values come from the lifecycle ledger row whose `EVALUATED_AT` is closest to the target anchor (±2 day tolerance). If no row exists in the window, the input is NULL and the score is nulled out.

### Why cumulative-set growth, not weekly-volume difference (issue #33)

The source/signal deltas were originally *(distinct links in the last 7d) − (distinct links in the prior 7d)*. Because attribution arrives in sparse bursts, last-week volume is usually *lower* than prior-week volume, so the deltas were structurally negative (median −3, only ~15% positive) — and a one-time attribution backfill sitting in the prior-7d window made every touched trend look like it was cratering. That pinned both terms near their flat-trend midpoints, capping the composite score at ~59 (so `Watchlist ≥ 65` and `High Potential ≥ 80` were mathematically unreachable) and starving eligibility to ~2.5%.

Both deltas are now the **7-day growth of the cumulative distinct set**: each publisher/signal is attributed to the window in which it *first* links to the trend. This is a level-difference of a monotonically increasing count, so it is **never negative** and is **immune to backfills** — re-linking historical signals leaves each `MIN(first_linked)` unchanged, so a bulk re-link raises the cumulative count once and it stays elevated (no phantom cliff). Validated on live data: ~24% of trends gain ≥1 publisher and ~30% gain ≥1 signal week-over-week; the rest are genuinely quiet (organic attribution touches only ~15–60 of ~240 trends/week).

> **Ledger column note:** `INPUT_SOURCES_LAST_7D` / `INPUT_SIGNALS_LAST_7D` now hold the **cumulative distinct count as of now**, and `INPUT_SOURCES_PRIOR_7D` / `INPUT_SIGNALS_PRIOR_7D` the **cumulative count as of 7 days ago**. The `*_DELTA` = `*_LAST_7D − *_PRIOR_7D` relationship still holds; only the meaning of the two operands changed (cumulative levels, not single-week volumes). Rows written before this change carry `COMPUTATION_VERSION = 'v1'` and use the old weekly-volume meaning.

The signal-domain extraction reuses the exact `signal_domains` CTE from `dt_trend_dashboard.sql` (lines 131–170) — so source diversity here means *distinct publishers*, not distinct source-platform names. (See [`feedback_breadth_by_domain`](../docs/../) — McClatchy values cross-publisher resonance.)

---

## Scoring formula

Each input is clamped to a sensible operating range, normalized to [0, 100], then averaged with equal 25% weights:

| Input | Clamp range | Normalize |
|---|---|---|
| Acceleration | [−30, +30] | `(raw + 30) / 60 × 100` |
| Inverse heat | [0, 100] | identity |
| Source delta | [0, 2] | `raw / 2 × 100` |
| Signal delta | [0, 4] | `raw / 4 × 100` |

The source/signal deltas are non-negative under the cumulative-set framing, so they need no offset — the term is `0` at zero growth and saturates at the clamp ceiling. The ceilings are tight (gaining **2** new publishers or **4** new signals in a week maxes the term) because attribution is genuinely sparse: the live 95th percentile is `source_delta = 2`, `signal_delta = 3` (max 4 / 19). These ranges are what let a real emerging trend (cumulative growth + acceleration + low heat) clear `Watchlist`/`High Potential`; on live data the score now reaches ~83 with both tiers populated, versus a hard ceiling of ~59 before.

```
PREDICTION_SCORE = ROUND(
    0.25 × normalize(acceleration)
  + 0.25 × normalize(inverse_heat)
  + 0.25 × normalize(source_delta)
  + 0.25 × normalize(signal_delta),
  1
)
```

Equal weights at launch. Once Marcelo's strategists generate Approve/Dismiss decision history, the weights should be re-tuned via regression over approval outcomes (tracked by `COMPUTATION_VERSION` in the ledger).

---

## Flag bands

Static thresholds per Marcelo's handoff (`prediction-scoring-handoff-martin.md`):

| Flag | Score range |
|---|---|
| `Emerging` | 40–65 |
| `Watchlist` | 65–80 |
| `High Potential` | 80–100 |
| `NULL` | < 40 (not surfaced in the UI) |

---

## Eligibility logic

`PREDICTION_ELIGIBLE = TRUE` requires **all** of:

1. `INPUT_HEAT_NOW < 70` — not already peaked (Marcelo's "not a peaked trend" constraint; heat compresses to 0–77 today, so `< 70` excludes only the hottest trends)
2. `INPUT_ACCELERATION > 0` — actually accelerating, not just high inverse heat
3. `INPUT_SOURCE_DELTA > 0 OR INPUT_SIGNAL_DELTA > 0` — gained ≥1 new publisher **or** signal in the last 7 days (real cumulative attribution growth)
4. `DAYS_SINCE_PROMOTION >= 14` — enough history for clean WoW math
5. `INPUT_SCORE_PERCENTILE >= 0.70` — top 30% of scored trends today (dynamic)

The percentile gate aims at the "~30% of trends should be eligible" product target.

**Why these thresholds (issue #33).** On live data the heat ceiling and the attribution-growth gate are *anti-correlated*: a trend gains new publishers/signals precisely when it is heating up, so trends with growth tend to have higher heat. Stacking the original strict gates (`heat < 60` **and** `source_delta > 0` **and** `signal_delta > 0`) drove eligibility to ~9% no matter how the deltas were defined — the two requirements rarely co-occur. Two deliberate relaxations bring eligibility into a defensible band (~18% on the latest population, clearly above the broken ~2.5% and within reach of the ~30% target):

- **Heat ceiling `< 70` instead of `< 60`** — still excludes the genuinely-peaked trends (heat tops out at ~77) while admitting accelerating growers.
- **Delta gate is `OR` instead of `AND`** — "gained a new publisher *or* a new signal" is the real-meaning bar; requiring both simultaneously is stricter than the product needs now that the deltas are non-negative and meaningful.

The hard `heat < 60` / equal-weight / strict-`AND` design is revisited once strategist Approve/Dismiss volume supports regression tuning (out of scope here). **The conjunction can still legitimately produce few eligible trends** on broadly-decelerating days — by design, the Predictions Queue stays small rather than surfacing flat trends.

---

## Young-trend NULL rule

A trend with `DAYS_SINCE_PROMOTION < 14` or any missing heat-window value gets `PREDICTION_SCORE = NULL`, `PREDICTION_FLAG = NULL`, `PREDICTION_ELIGIBLE = FALSE`. This:

- Avoids garbage scores from missing prior-7d / prior-14d data.
- Keeps the UI clean — no scoring badge on cards too young to evaluate fairly.
- Is the only path to the percentile gate being computed over a clean denominator.

---

## Cadence

Daily batch by default (cron TBD; HTTP-only at deploy time). Every run scores **every live trend** in one batch SQL query — there is no per-trend fanout because the dynamic-percentile eligibility requires the full population in one snapshot.

Running daily strikes the right tradeoff:
- Lifecycle agent updates `NEW_HEAT_SMOOTHED` hourly, but week-over-week deltas only meaningfully change once per day.
- A daily snapshot in the ledger gives clean audit trails without ledger churn.
- The 15-min dashboard refresh picks up changes on its next tick.

---

## Manual operations

```sh
# Fire one scoring run (no body needed)
curl -sS -X POST https://eoj1i9r5pdvyugj.m.pipedream.net | jq

# After ~5 min for dashboard refresh, check the queue
snowsql -q "
  SELECT TREND_NAME, ROUND(HEAT_INDEX,1) AS HEAT,
         PREDICTION_SCORE, PREDICTION_FLAG, PREDICTION_ELIGIBLE
  FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
  WHERE PREDICTION_ELIGIBLE = TRUE
  ORDER BY PREDICTION_SCORE DESC
  LIMIT 20;
"

# Inspect the most recent ledger run + all inputs for one trend
snowsql -q "
  SELECT EVALUATED_AT, CHAIN_ID,
         PREDICTION_SCORE, PREDICTION_FLAG, PREDICTION_ELIGIBLE,
         INPUT_HEAT_NOW, INPUT_ACCELERATION,
         INPUT_SOURCE_DELTA, INPUT_SIGNAL_DELTA,
         ROUND(INPUT_SCORE_PERCENTILE, 2) AS PCT,
         DAYS_SINCE_PROMOTION
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
  WHERE TREND_ID = '<uuid>'
  ORDER BY EVALUATED_AT DESC
  LIMIT 5;
"

# Population stats after a fresh run
snowsql -q "
  SELECT COUNT(*) AS total,
         COUNT(PREDICTION_SCORE) AS scored,
         COUNT_IF(PREDICTION_ELIGIBLE) AS eligible,
         COUNT_IF(PREDICTION_FLAG = 'High Potential') AS high_potential,
         COUNT_IF(PREDICTION_FLAG = 'Watchlist') AS watchlist,
         COUNT_IF(PREDICTION_FLAG = 'Emerging') AS emerging
  FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD;
"
```

---

## Insights Agent handoff

Once these fields are present on `DT_TREND_DASHBOARD` (they are, as of commit `f6813fe`), the Insights Agent side switchover is:

1. Set `PREDICTION_MOCK=false` in the backend `.env`
2. Add `PREDICTION_SCORE`, `PREDICTION_FLAG`, `PREDICTION_ELIGIBLE` to the `SELECT` in `snowflake_service.py`
3. Rebuild the backend container

The frontend already maps `prediction_score` / `prediction_flag` from the API response, so the UI lights up on its own. Strategist Approve/Dismiss decisions persist to the Insights Agent's own Postgres `prediction_decisions` table — *not* back to this repo's ledger.

---

## Known limitations / future work

- **Cluster delta is signal-count delta**, not historical pairwise vector-similarity expansion. Tracking the latter would require snapshotting pairwise similarity over time (expensive, deferred).
- **Equal 25% weights are a launch heuristic.** Re-tune from Approve/Dismiss data once volume justifies it. Bump `COMPUTATION_VERSION` when the formula changes so the ledger remains auditable across versions.
- **Cron not yet wired.** The workflow has only its HTTP trigger today. Adding a `dc_xxx` cron source at 06:00 UTC is a one-commit follow-up (see `pipedream_cron_via_repo.md` notes in memory).
- **Daily snapshot table.** ~~If future analytics work needs cheaper WoW rollups outside the prediction pipeline, stand up `FCT_TREND_DAILY_SNAPSHOTS` separately~~ — **done (#38)**, but as a dynamic table (`DT_TREND_DAILY`) deriving daily signal/source counts live from `FCT_TREND_SIGNALS.LINKED_AT`, *not* the orphaned `FCT_TREND_DAILY_SNAPSHOTS` DDL (which still has no writer and stays unused). See [`schema.md`](schema.md#dt_trend_daily).
