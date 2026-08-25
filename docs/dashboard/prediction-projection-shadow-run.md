<!-- Title: Prediction Projection — Shadow Run -->
<!-- Parent: ATLAS Dashboard -->

# Prediction projection — shadow-run comparison (CRMA-769)

**What this records.** The prediction pillar's verdict ledger ran in shadow —
writing verdicts while `DT_TREND_DASHBOARD` stayed on the retired
deterministic scorer — before the projection re-point that this document
accompanies. This is the before/after readout taken at the end of that shadow
window, so the semantics change is a measured decision and not a surprise
discovered after traffic saw it.

**Measured** 2026-08-24, against live `MCC_PRESENTATION.TREND_AGENT`. The
"new" column is the re-pointed projection in `sql/dt_trend_dashboard.sql`, run
read-only as a `SELECT` — the dynamic table itself was **not** altered.

## The shadow window

| | |
| --- | --- |
| First verdict written | 2026-08-21 13:51 UTC |
| Last verdict written | 2026-08-24 19:10 UTC |
| Verdict rows accumulated | 71 |
| Distinct predictions | 20 |
| Distinct run chains | 9 |
| Live `DT_TREND_DASHBOARD` during the window | untouched — 279 scored / 16 eligible / 490 `FALSE`, exactly the retired scorer's latest values |

## Population, old scorer vs verdict projection

506 trends on the dashboard. The old scorer's latest row per trend, against
the projection's latest ACTIVE matched verdict per trend:

| Measure | Old scorer | Verdict projection |
| --- | --- | --- |
| Trends with a non-null `PREDICTION_SCORE` | 279 | **4** |
| Trends with a non-null `PREDICTION_FLAG` | 61 | **4** |
| Trends with `PREDICTION_ELIGIBLE = TRUE` | 16 | **4** |
| Trends with `PREDICTION_ELIGIBLE = FALSE` | 490 | **0** (the value no longer exists) |
| Trends with `PREDICTION_ELIGIBLE IS NULL` | 0 | **502** |
| Mean score across scored trends | 37.1 | 65.3 |

**Overlap: zero.** No trend is scored by both. That is the single most
important number here, and it is not a rounding artifact — see below.

By the old scorer's flag band:

| Old `PREDICTION_FLAG` | Trends | Old eligible | Now scored | Now eligible |
| --- | --- | --- | --- | --- |
| `NULL` | 445 | 0 | 4 | 4 |
| `Emerging` | 55 | 13 | 0 | 0 |
| `Watchlist` | 5 | 2 | 0 | 0 |
| `High Potential` | 1 | 1 | 0 | 0 |

## The four trends that project

| Trend | New score | New flag | Old score | Old flag | Old eligible | Age at measurement |
| --- | --- | --- | --- | --- | --- | --- |
| Cordless Entertaining Lamps | 72.0 | `Watchlist` | `NULL` | `NULL` | `FALSE` | 6 days |
| Matcha Skin Scents | 65.0 | `Watchlist` | `NULL` | `NULL` | `FALSE` | 5 days |
| Air-Dry Clay Accents | 64.0 | `Emerging` | `NULL` | `NULL` | `FALSE` | 7 days |
| C15:0 Longevity Supplements | 60.0 | `Emerging` | `NULL` | `NULL` | `FALSE` | 9 days |

**Why the overlap is zero.** All four are 5–9 days old, and the old scorer
returned `NULL` for anything under 14 days — it needed two clean weeks of
week-over-week history before it would say anything at all. The pillar has no
such floor: it reasons from the signal corpus, so it can make an explicit,
falsifiable call about an emergence days after the trend appears. The two
systems were looking at disjoint populations, which is a stronger argument for
the cutover than a correlation would have been.

## What a consumer will actually see change

1. **The queue shrinks, hard** — 16 eligible trends become 4. This is the
   strategy's deliberate coverage → integrity trade: the old eligible set was
   right about 1 call in 4 and its `Emerging` band carried no lift over
   picking trends at random. Four explicit, falsifiable, gradable calls
   replace 16 percentile cuts. The queue grows back as the pillar's daily
   generation pass mints more predictions and matching improves — it is not
   capped at 4.
2. **`PREDICTION_SCORE` goes `NULL` for 279 trends.** Those trends had a
   number; they never had a call. `NULL` now means "the system is making no
   call about this trend", which is the honest reading.
3. **`PREDICTION_ELIGIBLE = FALSE` disappears entirely.** 490 trends read
   `FALSE` today and will read `NULL` after the re-point. A consumer testing
   `WHERE PREDICTION_ELIGIBLE = FALSE` finds nothing; `WHERE
   PREDICTION_ELIGIBLE` and `WHERE PREDICTION_ELIGIBLE IS NOT TRUE` both keep
   working. See the data contract's migration note.
4. **Mean score rises 37.1 → 65.3**, because the population changed from
   "every trend old enough to divide" to "every trend we have an active call
   about". The two means are not comparable and should not be trended across
   the cutover.

## White-space predictions

16 of the 20 live predictions match no trend. All 16 are white-space
predictions, ledger-only in v1, and **none** reaches any dashboard column —
the projection filters on `MATCHED_TREND_ID IS NOT NULL`. This closes the
obligation CRMA-764 AC3 could not close at the time, because nothing read
verdicts yet.

## Cited examples

Measured over the 20 live predictions, using the projection's own
cited-examples shape:

| Measure | Value |
| --- | --- |
| Mean cited examples per prediction | 2.05 |
| Predictions citing nothing | 2 of 20 |
| Empty-but-present arrays produced | 0 |

A prediction that cited nothing yields `NULL`, not `[]`, so a card renders no
examples block rather than a bare one — and is not dropped for it. 7 of the 41
cited signal ids are legacy opaque bluesky ids rather than URLs; those resolve
to real `bsky.app` permalinks through `METADATA:uri`, and anything that
resolves to no link carries no `url` key at all.

## Column types, before and after

Measured on the projection's own output with `SYSTEM$TYPEOF`, against
`INFORMATION_SCHEMA` for the live table. AC1 says names, types and ranges do
not move, and they do not:

| Column | Live table | Re-pointed projection |
| --- | --- | --- |
| `PREDICTION_SCORE` | `NUMBER(5,1)` | `NUMBER(5,1)` |
| `PREDICTION_FLAG` | `TEXT(32)` | `VARCHAR(32)` |
| `PREDICTION_ELIGIBLE` | `BOOLEAN` | `BOOLEAN` |

`PREDICTION_FLAG` needs an explicit `::VARCHAR(32)` to hold its width — a bare
`CASE` over string literals types as `VARCHAR(16MB)`. Harmless to read, but
not "unchanged", so the cast is there.

## What still has to happen by hand

1. **Apply the re-pointed dynamic table.** Nothing in this change touched live
   Snowflake. Run `sql/dt_trend_dashboard.sql`'s single
   `CREATE OR REPLACE DYNAMIC TABLE` statement after the epic PR merges to
   `production` — extract that one statement, do not run the file.
2. **Publish the Confluence mirror.** `data-contract.md` and the field
   reference are ATLAS-space mirrored, and the mirror must not describe a
   projection that is not live yet — so it publishes after step 1, not before.
3. **Retire the deterministic scorer** (`prediction-agent-p_QPCkLP1`): its
   Pipedream workflow, its 14:00 UTC cron `dc_wDuPeGB`, and its audit-registry
   entry. Until then it keeps writing to a ledger nothing reads. That is a
   separate story; this change only stops the dashboard reading its output.

---

← Back to [data contract](data-contract.md)
