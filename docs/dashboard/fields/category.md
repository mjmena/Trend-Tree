# CATEGORY / SUBCATEGORY / CATEGORY_CONFIDENCE / LOW_CONFIDENCE_FLAG

**At a glance** — The trend's vertical (e.g., "Food & Drink") and a more specific sub-classification within it, plus the agent's confidence in the categorization.

**Scale**
- `CATEGORY`: enum — _TODO: list of valid categories (Food & Drink, Wellness, Travel, etc.)_
- `SUBCATEGORY`: free text
- `CATEGORY_CONFIDENCE`: **0–1** (not 0–100 — different scale from heat and prediction)
- `LOW_CONFIDENCE_FLAG`: boolean; `TRUE` when `CATEGORY_CONFIDENCE < 0.6`

**What feeds it** — The enrichment agent's self-reported confidence in its category assignment. Like the names, category is **frozen** at first enrichment — re-enrichment never re-categorizes a trend.

**Where it appears in ATLAS** — Card metadata; filter / facet in the trend list.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
