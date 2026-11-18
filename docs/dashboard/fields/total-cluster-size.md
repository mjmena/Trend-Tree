<!-- Title: Total Cluster Size -->
<!-- Parent: ATLAS Dashboard -->

# TOTAL_CLUSTER_SIZE

**At a glance** — Total number of signals linked to this trend, across all publishers and sources.

**Scale** — Integer. No upper bound.

**What feeds it** — Count of distinct signals in `FCT_TREND_SIGNALS` for this trend. A signal linked twice still counts once, and a trend with no linked signals shows 0. Includes both `LINK_KIND = 'supporting'` (signals identified at promotion time) and `LINK_KIND = 'attributed'` (signals attached after the fact by the Attribution Cloud Run job).

**Cluster ≠ adjacent trends.** "Cluster size" here means the trend's signal pool — the evidence supporting *this* trend — not the count of other trends adjacent to it. For adjacent trends, see [`RELATED_TRENDS`](related-trends.md).

**Where it appears in ATLAS** — Card stat.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
