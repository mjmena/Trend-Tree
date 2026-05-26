# RELATED_TRENDS

**At a glance** — Up to 5 other trends most similar to this one.

**Scale** — Array of `{trend_id, trend_name, category, similarity}` objects.

**What feeds it** — Pairwise vector cosine similarity between this trend's enrichment vector and every other trend's vector. The top 5 above a `0.65` similarity threshold are returned. Vectors are produced by the enrichment agent and stored on `FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR` (or, as a fallback, on `FCT_TRENDS.TREND_VECTOR` for legacy trends).

**Where it appears in ATLAS** — "Related trends" section on the card. Powers the Collections view as well (out of scope for this doc).

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
