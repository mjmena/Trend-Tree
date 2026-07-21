<!-- Title: Trend Name -->
<!-- Parent: ATLAS Dashboard -->

# TREND_NAME (and TREND_NAME_B2B)

**At a glance** — Every trend has a single **canonical name** stored in `TREND_NAME` (e.g., "Hyper-Tactile Interiors"). This is the name ATLAS surfaces. The older dual B2C/B2B naming scheme is **retired** (ADR-0001, singular-name cutover 2026-05-27); `TREND_NAME_B2C` / `TREND_NAME_B2B` survive only as legacy fallbacks for trends that pre-date the cutover.

**Scale** — Text.

**What feeds it** — The enrichment agent. On a trend's **first enrichment**, the agent generates candidate names per audience, scores each against a corporate-media floor (sales-deck-safe, no nsfw, no crude or insult-coded names), and **freezes the winning singular name into `FCT_TRENDS.TREND_NAME`**. Re-enrichments emit new candidates to the enrichment ledger but **cannot** change the frozen display name — this prevents trend cards from quietly renaming themselves over time.

**How it's resolved** — The dashboard resolves the display name via a **6-level COALESCE** (source: `sql/dt_trend_dashboard.sql:304`). Level 1 is the canonical path; levels 2–6 are progressively-degraded legacy fallbacks for older rows:

| Level | Source | When it fires |
|---|---|---|
| 1 | `FCT_TRENDS.TREND_NAME` | **Canonical.** Singular name frozen at 1st enrichment. |
| 2 | `FCT_TRENDS.TREND_NAME_B2C` | Legacy fallback (retired dual scheme). |
| 3 | `FCT_TRENDS.TREND_NAME_B2B` | Legacy fallback (retired dual scheme). |
| 4 | Latest enrichment B2C | Legacy fallback for trends pre-dating the singular cutover. |
| 5 | Latest enrichment B2B | Same — legacy fallback. |
| 6 | Raw `TREND_TOPIC` | Last resort. Trend was promoted but never enriched. |

For any modern trend that has been enriched since the 2026-05-27 cutover, level 1 always wins. Levels 2–6 are edge cases.

**Where it appears in ATLAS** — Card title. `TREND_NAME_B2B` remains readable as a retired legacy fallback but is no longer the current naming scheme.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
