<!-- Title: 🟡 Migrating Fields -->
<!-- Parent: ATLAS Dashboard -->

# 🟡 Migrating from the Insights Agent backend

The fields below currently render on ATLAS cards but are computed by the Insights Agent backend (Marcelo's side). Those backend values are **mockups** — throwaway. We own building the *real* versions in the McClatchy pipeline.

Before implementation, each field needs a real **definition**. So every section below carries a **🔍 To define it** block: what the field means, what data it needs, what we already have, and the open decisions to lock. This is a scouting checklist, not an implementation plan.

> ⚠️ **Data update (2026-06-03):** a warehouse scan found that **most of the "Missing / external" data below already exists in Snowflake**, live and fresh — GSC (6.5B rows), the CSA/CUE content corpus + vectors, and audience/demographic + IAB tables — just in schemas this project doesn't read yet. The per-field "Have / Missing" notes below predate that scan. See **[Data Sourcing companion →](migrating-data-sources.md)** for the verified table-by-table mapping, join smoke-tests, and the (smaller) real gaps.

> When a field's definition is locked and it ships, its section graduates to a full deep dive under `docs/dashboard/fields/` (or stays here if the depth doesn't warrant a separate page).

**Repo facts we can lean on:** 1024-dim Cortex embeddings (`snowflake-arctic-embed-l-v2.0`) on `FCT_TRENDS` / `FCT_SIGNALS` / `FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR`; cosine machinery already live (`VECTOR_COSINE_SIMILARITY`); `HEAT_INDEX`, `PREDICTION_SCORE`, `DISTINCT_SOURCE_COUNT`, cluster size, `FCT_TRENDS.CONFIDENCE`, enrichment `category_confidence` / `LOW_CONFIDENCE_FLAG`, `FCT_TREND_GTRENDS_DAILY` interest %, `FCT_TREND_SOURCE_METRICS`.

<a id="audience-match"></a>

## 🟡 Audience Match

> **Status:** Currently computed by the Insights Agent backend (mockup). Building the real version in the McClatchy pipeline. **When built, folds into the [Opportunity Score](#overall-score) value leg** — v1 of that composite ships demand-only (locked 2026-06-12).

**At a glance** — How well the trend matches the publication's target demographics.
**Scale** — TBD (best-guess: 0–100).
**What feeds it** — TBD.
**Where it appears in ATLAS** — TBD.

**🔍 To define it**
- **Answers:** should we cover this for *our* audience (does it fit who reads us)?
- **Definition unknowns:** global McClatchy audience or per-publication (many papers, different demographics)? Which dimensions — age / geo / interest / subscriber-vs-anon? Match the trend's *category*, its *vector*, or its *geographic_hotspots*?
- **Inputs needed:** audience/demographic profiles (per publication ideally); a trend→audience representation to compare against.
- **Have in-repo:** enrichment `geographic_hotspots`, `category`, B2B/B2C audience naming, source metrics. No demographic data.
- **Missing / external:** the actual audience dataset ("Chad Burton's audience data"); per-publication audience profiles.
- **Decisions to lock:** global vs per-paper; vector-based vs rule/category-based; output scale; what "100% match" means.

<a id="confidence-score"></a>

## 🟡 Confidence Score

> **Status:** Currently computed by the Insights Agent backend (mockup). Building the real version in the McClatchy pipeline.

**At a glance** — Overall trustworthiness rollup for the trend.
**Scale** — TBD (best-guess: 0–100).
**What feeds it** — TBD.
**Where it appears in ATLAS** — TBD.

**🔍 To define it**
- **Answers:** how much should an editor trust this trend is real and accurately characterized?
- **Definition unknowns:** trust in *what* — that the trend is real (not noise)? that the enrichment is accurate? data completeness/recency? Which components roll up and how weighted?
- **Inputs needed:** source diversity, cross-source corroboration, signal volume, category confidence, recency/staleness.
- **Have in-repo:** strong coverage already — `FCT_TRENDS.CONFIDENCE` (distillation), `category_confidence`, `LOW_CONFIDENCE_FLAG`, `DISTINCT_SOURCE_COUNT`, cluster size, cross-source corroboration logic.
- **Missing / external:** little data-wise; this is mostly a **definition + weighting** problem.
- **Decisions to lock:** which dimensions count, their weights, 0–100 scale, and how we *validate* the number reflects real trustworthiness. **Most buildable field — likely the first real one.**

<a id="content-gap"></a>

## 🟡 Content Gap

> **Status:** Definition **locked 2026-06-12** (grill session → `CONTEXT.md` "Content gap"). Mockup still renders on ATLAS; the real version ships as the supply-side leg of the [Opportunity Score](#overall-score).

**At a glance** — How uncovered the trend is in **McClatchy's own** published corpus. The supply-side *component* of white space — a gap nobody is searching for is not an opportunity.
**Scale** — `gap_factor` 0–1 in the ledger; surfaced alongside the Opportunity Score so the "why" is visible.
**What feeds it** — Per-term semantic match: each trend's `FCT_TREND_GSC_TERMS` phrases (768-dim, `arctic-m-v1.5`) against the data team's `CUE_CONTENT_VECTORS` (876K), counting articles within a recent window (default 90d, stored as `WINDOW_DAYS`), cosine threshold shared with the GSC demand matcher. `gap_factor` = inverted log-squash of the matched-article mass.
**Where it appears in ATLAS** — Component beside the Opportunity Score (exact card placement = Marcelo coordination).

**🔒 Locked**
- **Corpus = ours only.** Market saturation is heat-breadth's job (tallow test: nationally saturated + zero McClatchy coverage + live demand ⇒ still a gap). Keeps the axes orthogonal.
- **Recent-count, not nearest-distance** — degree-of-gap (continuous), and one borderline article from 80 days ago must not erase a gap.
- **Per-term lens, symmetric with the demand leg** — same terms, same 768 space, same threshold ⇒ per-term `DETAIL` explains *which facet* is uncovered ("cherry red gel nails: 212 queries, 0 stories").
- **Upgrade path preserved:** re-embed article `PLAINTEXT` at 1024 later without changing the field's meaning.

**Still open** — threshold + squash calibration (validation panel); corpus-skew sanity check (local-news mix can fake a zero — see [Data Sourcing](migrating-data-sources.md)).

<a id="revenue-potential"></a>

## 🟡 Revenue Potential

> **Status:** Currently computed by the Insights Agent backend (mockup). Building the real version in the McClatchy pipeline. Marcelo is working with Chad on Google Search Console data; pending warehouse capacity. **When built, folds into the [Opportunity Score](#overall-score) value leg** (v1 demand-only; the RPM/yield table remains the genuinely missing dataset).

**At a glance** — Estimated revenue if we publish on this trend.
**Scale** — TBD.
**What feeds it** — Google Search Console data + content performance history (per the May 22 sync).
**Where it appears in ATLAS** — TBD.

**🔍 To define it**
- **Answers:** what's the ROI of covering this?
- **Definition unknowns:** revenue model — pageviews × RPM? subscription conversion? search-traffic capture? Time horizon of the estimate?
- **Inputs needed:** search demand (GSC), historical content performance (traffic → revenue), RPM/yield by category.
- **Have in-repo:** `FCT_TREND_GTRENDS_DAILY` interest peak/avg as a demand *proxy*; source metrics. **No revenue or content-performance data.**
- **Missing / external:** GSC ingestion (pending warehouse capacity); content-performance→revenue history; RPM-by-category table.
- **Decisions to lock:** the revenue model itself; which data sources are in scope; scale; how to handle trends with no historical analog.

<a id="ai-match"></a>

## 🟡 AI Match %

> **Status:** Currently computed by the Insights Agent backend (mockup). Building the real version in the McClatchy pipeline.

**At a glance** — Vectorization-based match between the trend and items in the CSA content library. Powers the Collections graph (out of scope for this doc).
**Scale** — Percent (0–100).
**What feeds it** — Vector comparison between the trend's enrichment payload and CSA content metadata.
**Where it appears in ATLAS** — TBD (likely Collections only — confirm whether it surfaces on the main card).

**🔍 To define it**
- **Answers:** which existing content collections does this trend align to (powers the Collections graph)?
- **Definition unknowns:** match against what exactly (CSA content metadata)? Threshold→percent mapping? Is it max-similarity to one item or coverage across a collection?
- **Inputs needed:** the CSA content library with vectorized metadata.
- **Have in-repo:** trend vectors + cosine (we already do this for related-trends). **No CSA content vectors.**
- **Missing / external:** CSA content-library metadata + embeddings feed.
- **Decisions to lock:** what CSA exposes; **embedding compatibility** (must share model/dimension — we use arctic-embed-l-v2, 1024-dim — or re-embed); threshold→percent curve.

<a id="overall-score"></a>

## 🟡 Opportunity Score (formerly "Overall Score", Green / Yellow / Red)

> **Status:** Definition **locked 2026-06-12** (grill session → `CONTEXT.md` "Opportunity score" / "White space"). Canonical name is **Opportunity Score**; "Overall Score" is the mockup label (ATLAS rename = Marcelo coordination). Mockup still renders; real build pending.

**At a glance** — The 0–100 measurement of a trend's **white space** for McClatchy: live reader/search demand that our own corpus doesn't serve. Relational (trend × McClatchy), unlike the trend-intrinsic `HEAT_INDEX` / `PREDICTION_SCORE`.
**Scale** — 0–100, `NULL` when demand is unmeasurable. G/Y/R bands calibrated empirically on the live distribution — the mockup's ≥75 / 50–74 / <50 is *not* assumed.
**What feeds it** — `100 × gap_factor × demand_factor` (multiplicative: either leg ≈ 0 kills it). Demand v1 = GSC first-party (`FCT_TREND_GSC_DEMAND`, positive-only by design) + Google Trends interest; gap = [Content Gap](#content-gap). [Audience Match](#audience-match) and [Revenue Potential](#revenue-potential) fold into the value leg as they're built.
**Where it appears in ATLAS** — Decision Page (the mockup's slot); component factors surfaced beside it so strategists can see the "why".

**🔒 Locked**
- **Trend Strength is NOT an input** (the open question above, resolved): heat/lifecycle act as a **gate, not a score input** — `OPPORTUNITY_ELIGIBLE` = lifecycle not in `DORMANT`/`RETIRED`, with `DECLINING` staying eligible (media chatter declining ≠ reader demand gone; the demand leg already requires live demand). Mirrors the `PREDICTION_SCORE`/`PREDICTION_ELIGIBLE` split, including the isolation guarantee: opportunity fields never feed heat, lifecycle, or prediction.
- **Missing demand *evidence*** (GT empty **and** no GSC match) ⇒ `NULL`, never zero — GT's empty-response ambiguity is a documented foot-gun.
- **Grain:** global v1, grain-ready (`SCOPE='ALL'` column; per-paper is a deliberate v2 once a UI surface exists).
- **Runner:** `opportunity-agent` Pipedream workflow, twin of `prediction-agent-p_QPCkLP1` — daily cron + HTTP manual fire, single `INSERT...SELECT` → append-only `FCT_TREND_OPPORTUNITY_LEDGER` (per-term `DETAIL`, `MATCH_THRESHOLD`, `WINDOW_DAYS`, `COMPUTATION_VERSION='v1'` from day one). Additive `DT_TREND_DASHBOARD` columns only.
- **Validation before exposure:** backfill + review panel — score all live trends ledger-only; review top/bottom/oddball cells plus the three anchors (gel nails → high, fiber → mid-low, zero-proof → high-ish) with editorial; calibrate squash/threshold/bands; only then add the DT columns.

---

## 🧭 Related: reasoning-based trend matching

Not a migrating field, but a related definition task. Today "related trends" are matched purely by semantic embedding (cosine ≥ 0.65 top-5 over `TREND_VECTOR` → the `RELATED_TRENDS` array). The goal is to add an LLM relatedness judgment so "related" reflects a real relationship, not just vector proximity.

**🔍 To define it**
- **Relatedness criteria:** what counts as "related" — same topic family? causal/driver relationship? co-occurring? substitutable? — and how that differs from "same trend" (dedup).
- **Verdict taxonomy + confidence:** e.g. `related | not_related | same_trend` + a confidence scale + short rationale.
- **Candidate set:** judge only the cosine top-5 pairs, or cast a wider net the LLM prunes?
- **Cadence / cost model:** batch over which trends, how often, and what triggers a re-judge as new trends get promoted (dashboard refreshes every 15 min; verdicts are batch → staleness question).
- **Output contract:** how the verdict enriches each `RELATED_TRENDS` object (and whether `not_related` pairs are filtered out).
- **Validation:** how we prove reasoning beats raw cosine — need a small labeled eval set of trend pairs.

---

## Cross-cutting decisions (apply to all fields)

- **Scale convention:** standardize on 0–100 + optional band, or per-field native scales? (Frontend simplicity vs fidelity.)
- **Validation / ground truth:** for *every* field, how do we know a score is "good"? Likely need labeled examples or editorial sign-off per field — without this, "real implementation" has no success criterion.
- **Definition ownership:** who is the authority for each field's meaning — editorial, Marcelo, or us? (Confidence / Content Gap / Overall are editorial-judgment calls.)
- **Embedding compatibility:** Content Gap and AI Match both compare trend vectors to an external corpus — that corpus must be embedded with a compatible model, or we re-embed. Pin this early.
- **Storage pattern (when we build):** the append-only ledger → dashboard-join pattern (e.g. `FCT_TREND_PREDICTION_LEDGER`) is the template; one combined insights ledger fits. Write it with a single server-side `INSERT...SELECT`, not a JSON-array bound param through the Pipedream SQL proxy (that path fails at ~80KB+ — see the prediction agent's 2026-06-05 rewrite). Noted for continuity, not needed for scouting.

## What we need from stakeholders

- **Marcelo:** what the current mockup actually computes (even if throwaway, it reveals intended semantics); access path to the CSA content library; real GSC timeline.
- **Chad Burton:** the audience/demographic dataset shape; GSC collaboration status.
- **Editorial:** what Content Gap, Overall Score, and Audience Match must mean to be *useful in a coverage decision* — these are judgment fields, not just math.

## Suggested next steps (post-scouting)

1. **Definition workshops** per field to resolve the "Decisions to lock" above — start with the editorial-judgment fields (Content Gap, Overall, Audience Match) since data follows definition.
2. **Fast real wins** where data already exists: **Confidence Score** and the **reasoning-match** feature — neither is blocked on external feeds.
3. **Data-acquisition spikes** for the external feeds: GSC ingestion, CSA/content-corpus export + embedding, audience dataset load — each is its own pipeline, scoped separately.

---

← Back to [hub](index.md)
