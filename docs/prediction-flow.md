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

Four week-over-week deltas computed live from existing time-series tables. No snapshot table required (and `FCT_TREND_DAILY_SNAPSHOTS` was retired with the Louvain cleanup on 2026-04-28).

| Input | Source | Expression |
|---|---|---|
| Velocity acceleration | `FCT_TREND_LIFECYCLE_LEDGER.NEW_HEAT_SMOOTHED` | `(heat_now − heat_7d) − (heat_7d − heat_14d)` |
| Low base volume (inverse heat) | same | `100 − heat_now` |
| Source diversity expansion | `FCT_TREND_SIGNALS.LINKED_AT` + `FCT_SIGNALS.METADATA` | `COUNT(DISTINCT domain) last 7d − COUNT(DISTINCT domain) 14-7d ago` |
| Cluster formation | `FCT_TREND_SIGNALS.LINKED_AT` | `COUNT(DISTINCT signal_id) last 7d − COUNT(DISTINCT signal_id) 14-7d ago` |

The `heat_7d` and `heat_14d` values come from the lifecycle ledger row whose `EVALUATED_AT` is closest to the target anchor (±2 day tolerance). If no row exists in the window, the input is NULL and the score is nulled out.

The signal-domain extraction reuses the exact `signal_domains` CTE from `dt_trend_dashboard.sql` (lines 131–170) — so source diversity here means *distinct publishers*, not distinct source-platform names. (See [`feedback_breadth_by_domain`](../docs/../) — McClatchy values cross-publisher resonance.)

---

## Scoring formula

Each input is clamped to a sensible operating range, normalized to [0, 100], then averaged with equal 25% weights:

| Input | Clamp range | Normalize |
|---|---|---|
| Acceleration | [−30, +30] | `(raw + 30) / 60 × 100` |
| Inverse heat | [0, 100] | identity |
| Source delta | [−5, +10] | `(raw + 5) / 15 × 100` |
| Signal delta | [−10, +30] | `(raw + 10) / 40 × 100` |

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

1. `INPUT_HEAT_NOW < 60` — not already peaked (Marcelo's "not a peaked trend" constraint)
2. `INPUT_ACCELERATION > 0` — actually accelerating, not just high inverse heat
3. `INPUT_SOURCE_DELTA > 0` — source diversity expanding week-over-week
4. `INPUT_SIGNAL_DELTA > 0` — cluster forming, not flat
5. `DAYS_SINCE_PROMOTION >= 14` — enough history for clean WoW math
6. `INPUT_SCORE_PERCENTILE >= 0.70` — top 30% of scored trends today (dynamic)

The percentile gate aims at the "~30% of trends should be eligible" product target. The four strict positive-delta gates reflect the literal spec from the handoff. **The conjunction can legitimately produce 0 eligible trends** on days when the trend population is broadly decelerating — by design, the Predictions Queue stays empty rather than surfacing flat trends.

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
- **Daily snapshot table.** If future analytics work needs cheaper WoW rollups outside the prediction pipeline, stand up `FCT_TREND_DAILY_SNAPSHOTS` separately — it's referenced by orphaned DDL in the repo but does not currently exist in Snowflake.
