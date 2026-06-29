# Opportunity Score: an isolated measurement of internal white space

**Status:** accepted (2026-06-12)

## Context

The pipeline had two live scores — `HEAT_INDEX` (how broadly the world validates a
trend right now) and `PREDICTION_SCORE` (likelihood it grows from here) — and
stakeholders kept asking a question neither answers: **"what does the white space
look like for this trend — how little is being covered, and how valuable would
covering it be?"** Both existing scores are trend-intrinsic; the question is
relational (trend × McClatchy).

The Insights Agent mockup already renders an "Overall Score" (green/yellow/red,
Decision Page), spec'd as a weighted rollup of Trend Strength + Audience Match +
Content Gap + Revenue Potential — with "what even is Trend Strength?" left as an
open question, and the backend values throwaway mockups we own replacing
(`docs/dashboard/migrating.md`).

A 2026-06-12 grill session resolved the definition cluster. Canonical terms
landed in `CONTEXT.md` (**white space**, **opportunity score**, **content gap**,
plus boundary entries for **heat index** / **prediction score**); locked field
definitions landed in `docs/dashboard/migrating.md`.

## Decision

The composite is named the **Opportunity Score**: the 0–100 measurement of a
trend's white space for McClatchy. Four load-bearing choices:

1. **Coverage is internal.** White space's supply side is McClatchy's own
   published corpus, nothing else. Market saturation is already heat's
   publisher-breadth job — keeping it out of this score keeps the axes
   orthogonal. The tallow test: a trend saturated nationally with zero McClatchy
   coverage and live reader demand **is** white space (a local-first publisher
   can still capture that demand).

2. **Trend strength gates, never feeds.** Heat/lifecycle do not enter the
   formula. A separate `OPPORTUNITY_ELIGIBLE` boolean (lifecycle not in
   `DORMANT`/`RETIRED`; `DECLINING` stays eligible — media chatter declining ≠
   reader demand gone) carries the "is the moment live" judgment, mirroring the
   `PREDICTION_SCORE`/`PREDICTION_ELIGIBLE` split. The isolation guarantee runs
   both directions: opportunity fields never influence heat, lifecycle, or
   prediction.

3. **Multiplicative, NULL when unmeasurable.** `score = 100 × gap_factor ×
   demand_factor`. White space is conjunctive — either leg near zero kills it
   (huge gap nobody searches for ≠ opportunity; huge demand we already cover
   wall-to-wall ≠ opportunity). Missing demand *evidence* (Google Trends empty
   **and** no GSC match) produces `NULL`, never zero — GT's empty response is
   documented as ambiguous (insufficient data *or* silent bot-block), and a
   measurement failure must not read as "no opportunity".

4. **Value leg v1 = demand only.** GSC first-party demand (audience-qualified by
   construction — it counts searches on our own 34 properties — and
   positive-only by design) blended with Google Trends market interest. Audience
   Match and Revenue Potential fold into the value leg as those components get
   built; the formula is defined to absorb them.

Supporting decisions recorded for completeness: the gap leg is a **per-term
recent count** (each trend's `FCT_TREND_GSC_TERMS` phrases, 768-dim
`arctic-m-v1.5`, against `CUE_CONTENT_VECTORS` in a tunable ~90d window, cosine
threshold shared with the GSC demand matcher — same terms, same space as the
demand leg, so every score decomposes into a per-term "why"); grain is **global
v1** with a `SCOPE` column for later per-paper rows; the runner is an
**`opportunity-agent` Pipedream workflow** twin of `prediction-agent-p_QPCkLP1`
writing an append-only `FCT_TREND_OPPORTUNITY_LEDGER` with
`COMPUTATION_VERSION='v1'` from day one; **validation precedes exposure**
(ledger-only backfill over all live trends + editorial review panel, calibrating
squash/threshold/bands) before any `DT_TREND_DASHBOARD` columns appear.

## Considered alternatives

- **Mockup-faithful weighted rollup (rejected).** Folding trend strength into
  the number makes a hot, already-covered trend outrank a quiet trend with a
  huge gap and real demand — re-coupling the axes and reproducing the exact
  vagueness ("overall *what*?") the score exists to fix.
- **Market-level white space (rejected).** The classic strategy reading ("nobody
  anywhere covers this") inverts against heat, double-counts what breadth
  already measures, scores national saturation against local opportunity, and
  has no corpus in-warehouse anyway.
- **Components only, no composite (rejected).** Most honest, but the Decision
  Page expects one go/no-go signal; instead the component factors stay visible
  beside the composite.
- **Zero-fill for missing demand (rejected).** Silently converts "we couldn't
  measure" into "no opportunity".

## Consequences

- **A high score on a dormant trend is correct behavior** — the score measures
  white space; the gate carries timing. Any surface presenting the score must
  present eligibility with it, or stale go-signals will erode trust.
- The score inherits **GSC's first-party frame**: demand means demand *we can
  observe and capture*, not market size. Low/absent GSC demand is ambiguous by
  design (positive-only); Google Trends carries the market side.
- **Band thresholds are deferred** to the backfill review — the mockup's
  ≥75 / 50–74 / <50 must not be hardcoded by the build.
- The ATLAS label ("Overall Score" → "Opportunity Score") diverges from the
  canonical name until the rename is coordinated with the Insights Agent side.
