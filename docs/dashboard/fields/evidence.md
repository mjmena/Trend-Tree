<!-- Title: Evidence (and Top Signals) -->
<!-- Parent: ATLAS Dashboard -->

# EVIDENCE / GENERAL_EVIDENCE / SOCIAL_EVIDENCE / OTHER_EVIDENCE / TOP_SIGNALS

**At a glance** — The "where did this come from" pool. Each entry is a piece of supporting evidence the enrichment agent gathered or grounded against.

## EVIDENCE

**Scale** — Array of objects. Each entry has at minimum a `type` (`news` / `social` / `commerce` / `reference` / `search_volume` / `video` / `other`), a `claim` (the agent's one-sentence summary of why this evidence supports the trend), and a source link.

**The four columns** are the same data sliced differently for the UI:

- `EVIDENCE` — the full typed pool.
- `GENERAL_EVIDENCE` — pre-bucketed: `news` / `commerce` entries.
- `SOCIAL_EVIDENCE` — pre-bucketed: `social` entries.
- `OTHER_EVIDENCE` — pre-bucketed: everything else (`reference` / `search_volume` / `video`).

**Refresh** — Updated whenever the trend is re-enriched.

**Where it appears in ATLAS** — Evidence sections on the trend detail pane.

<a id="top_signals"></a>

## TOP_SIGNALS

> ⚠ **Deprecated.** Kept while the front end migrates; new work should read `EVIDENCE` directly (first 5 news/commerce/social entries).

**At a glance** — The 5 strongest evidence entries — what the agent thinks best represents the trend.

**Scale** — Array of up to 5 entries.

**What feeds it** — First 5 entries from `EVIDENCE` with `type` in (`news`, `commerce`, `social`), preserved in the order the enrichment agent emitted them. Reference / search-volume / video entries are excluded (those are background, not "what defined the cluster").

**Where it appears in ATLAS** — "Top signals" preview on the card.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
