# DISTINCT_PUBLISHER_COUNT

**At a glance** — Number of unique publishers that have contributed at least one signal to this trend.

**Scale** — Integer (typically 0–50 for active trends).

**What feeds it** — Every signal linked to the trend in `FCT_TREND_SIGNALS` is mapped to a publisher domain (the actual website the signal originates from, e.g., `nytimes.com`, `vox.com`, `bsky.app`). The field counts the distinct domains.

**Why publishers and not "sources"?** A "source" in our pipeline means the *integration* that brought the signal in (GDELT, Bluesky, etc.). A "publisher" means the actual website the signal points to. **Four GDELT articles from four different news sites count as 4 publishers, not 1.** This metric is about cross-publisher resonance — a trend picked up by 12 different publishers is more credible than one mentioned 12 times by a single outlet.

**The misnomer.** The legacy alias `DISTINCT_SOURCE_COUNT` is the same value under an older, misleading name (it pre-dates the canonical Source vs Publisher distinction). It's kept for backward compatibility. Prefer `DISTINCT_PUBLISHER_COUNT` in any new query or display.

**What "good" looks like** — _TODO: empirical bands. Loose guidance: 1–2 = single-source noise, 3–5 = moderate breadth, 5+ = strong cross-publisher signal._

**Where it appears in ATLAS** — Card stat / sort criterion.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
