<!-- Title: Trend Name (B2C and B2B) -->
<!-- Parent: ATLAS Dashboard -->

# TREND_NAME (and TREND_NAME_B2B)

**At a glance** — Every trend has up to two names: a **B2C** "creative" name (e.g., "Plush Architecture") and a **B2B** "descriptive" name (e.g., "Tactile Maximalism"). ATLAS surfaces the B2C name by default. The B2B name is available as a separate field.

**Scale** — Text.

**What feeds it** — The enrichment agent. On a trend's **first enrichment**, the agent generates 5 candidate B2C names per audience and 5 B2B candidates, scores each against a corporate-media floor (sales-deck-safe, no nsfw, no crude or insult-coded names), and **freezes the winning name into `FCT_TRENDS`**. Re-enrichments emit new candidates to the enrichment ledger but **cannot** change the frozen display name — this prevents trend cards from quietly renaming themselves over time.

**How it's resolved** — The dashboard reads `TREND_NAME` via a 5-level COALESCE fallback. Levels 1–2 are the canonical path; levels 3–5 are progressively-degraded fallbacks for edge cases:

| Level | Source | When it fires |
|---|---|---|
| 1 | `FCT_TRENDS.TREND_NAME_B2C` | **Canonical.** Frozen at 1st enrichment. |
| 2 | `FCT_TRENDS.TREND_NAME_B2B` | Canonical fallback when no B2C was frozen. |
| 3 | Latest enrichment B2C | Legacy fallback for trends pre-dating the 2026-04-28 refactor. |
| 4 | Latest enrichment B2B | Same — legacy fallback. |
| 5 | Raw `TREND_TOPIC` | Last resort. Trend was promoted but never enriched. |

For any modern trend that has been enriched even once, levels 1–2 always win. Levels 3–5 are edge cases.

**Where it appears in ATLAS** — Card title. `TREND_NAME_B2B` is available wherever the descriptive name is preferred.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
