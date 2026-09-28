<!-- Title: Key Data Points -->
<!-- Parent: ATLAS Dashboard -->

# KEY_DATA_POINTS

**At a glance** — Retired. The field is always an empty array (`[]`) since 2026-09-25.

**Why** — The field showed Google Trends interest scalars from the `gtrends-poller` workflow. That workflow was broken, and CRMA-1313 removed it. The column stays in `DT_TREND_DASHBOARD` so that consumers do not break.

**What it used to carry** — Up to 2 entries, `interest_peak_pct` (effectively binary: `100` or `0`) and `interest_avg_pct` (0–100), from the most recent daily Google Trends pull. That history stays in `FCT_TREND_GTRENDS_DAILY`.

**Where it appears in ATLAS** — Data-points section on the trend card.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
