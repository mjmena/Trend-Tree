# MACROTREND_TAGS

**At a glance** — Higher-level theme labels the trend rolls up into (e.g., "Sustainability," "Hyper-Local," "Post-Pandemic Indoor"). Used for cross-trend grouping in dashboards and reports.

**Scale** — Array of text labels.

**What feeds it** — A separate map table, `MAP_TREND_MACROTRENDS`, which links trends to higher-level theme labels along with a `RELEVANCE_SCORE`. The dashboard returns the labels ordered by relevance, highest first. The map is populated by a separate process — _TODO: confirm whether this is currently populated, and by which workflow_.

**Where it appears in ATLAS** — Card tags row; filter / facet in the trend list.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
