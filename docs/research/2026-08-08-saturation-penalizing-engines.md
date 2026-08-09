# Saturation-penalizing trend engines and our saturation proxies

> **Status: COMPLETE** (2026-08-08). Ticket: CRMA-483 (child of wayfinder map CRMA-481).

## Research question

How do saturation-penalizing trend engines score for "white space", and which
saturation proxies could Trend Tree's own data support? Feeds a strategy
decision: should the prediction pillar's scoring penalize real-world
saturation (surface trends *before* they're saturated), and against what
measure?

Context: Aug 7 meeting — Jason Smith noted Trend Hunter's "trend intelligence
engine" explicitly penalizes saturation ("it's too late") to find white space
for businesses, and suggested similar logic could help the prediction system
surface upstream cultural signals.

## Sources to consult

External (primary sources preferred):
- Trend Hunter: methodology pages, patent filings, published material on their AI + insights-team scoring
- Exploding Topics: repo docs first (`docs/exploding-topics-api.md`, `docs/exploding-topics-feasibility.md`), then public methodology
- Glimpse (meetglimpse.com): public methodology
- Google Trends: rising-vs-top framing (official docs)
- Academic work on trend lifecycle / S-curve saturation detection, if directly relevant

Internal (repo + Snowflake, read-only):
- `docs/prediction-contract.md` — current PREDICTION_SCORE inputs
- `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY` — interest peak/decay shape
- `FCT_TREND_PREDICTION_LEDGER` input columns — cumulative source/signal-count curves
- `FCT_TREND_SOURCE_METRICS`, `FCT_TREND_SIGNALS` — source breadth, signal recency
- Eyeball 2–3 real trends' curves to judge whether saturation shape is visible

## TL;DR

- No commercial engine publishes real saturation math. Two disclosed patterns:
  **growth-ratio ranking** that structurally drops plateaued items (Google
  Rising; ET/Glimpse ingestion) and a **weighted "opportunity remaining"
  factor** (Trend Hunter's White Space, in a 5-factor composite; no formula,
  no patent found). ET's "Peaked" is a pure time-series-shape label + filter.
- The academically clean form of "white space" is **remaining headroom on a
  fitted S-curve / Bass model** — a continuous inverse factor.
- Our prediction score already penalizes *internal* heat (25% inverse-heat
  term + `heat < 70` eligibility gate) but nothing measures *real-world*
  saturation — the gap Jason named.
- Most viable proxies: (1) **ET `peaked` classification** via the owned API +
  `descriptor.query` (~67% match, consumer-skew caveat); (2) **GDELT article
  count** — mainstream-media breadth, absolute scale, but promotion-time-only
  today; (3) **GTrends shape — only after re-pointing the poller** (current
  `now 7-d` window-normalized pulls on compound keywords are under Google's
  noise floor for ~90% of trends; `rising` payloads nearly always empty).
- Cumulative signal curves plateau, but they measure our pipeline's
  attention (and are burst/migration-confounded), not the world.

## A. External survey

### Trend Hunter — Trend Intelligence Engine (the meeting's reference point)

Two visible scoring layers (their own pages; site 403s direct fetch, content
recovered via search index — primary but marketing-level):

- **Legacy per-trend "Trend Score"**: composite of **Popularity, Activity,
  Freshness** percentages, engagement-derived from their own audience (~309M
  people / 3.5B views). Freshness decays with age, so staleness enters as a
  *decaying component of a weighted composite*, not a hard filter.
- **Current "Trend Intelligence Engine" Opportunity Score**
  (trendhunter.com/trend-intelligence-engine): five factors — **Emergence,
  Stickiness, Institutional Commitment, Narrative, and White Space**. Their
  copy defines White Space as "how much opportunity remains" in a trend, aims
  to surface opportunities "before they become obvious or saturated", and
  says it's a **weighted model** ("weighting can shift by category or
  industry"). Separately, each trend gets a lifecycle **stage label:
  Momentum, Durability, or Saturation**.
- **What counts as saturated:** not quantitatively disclosed anywhere public.
  **No patent found** (Google Patents: nothing assigned to Trend Hunter /
  Gutsche; only unrelated third-party trend-detection patents, e.g. Twitter's
  US20160359993A1). Gutsche's published material (Better and Faster,
  18 Megatrends) is qualitative framework, not scoring math.
- **How the penalty enters:** White Space is a **positively-weighted term**
  in the composite (low remaining opportunity → lower score) — i.e. an
  inverse-ish weighted factor, not a hard filter. The Saturation *stage* is
  label-only; saturated trends are still shown with recommended actions.
- **Confidence: medium** — factor names and definitions are first-party, but
  no formula, thresholds, or weights are published.

### Exploding Topics (Semrush) — from repo docs, primary-source API spec

Verified against the live OpenAPI spec + calls (`docs/exploding-topics-api.md`,
2026-06-29). **We already own this API** (Business tier, key in `.envrc.local`).

- **Saturation signal:** search-volume trajectory shape per timeframe. Every
  `Topic` object carries `classifications` — a per-timeframe verdict map
  (`3`/`6`/`12`/`24`/`60`/`120`/`180` months + `forecast_12`) whose values are
  `regular` / `exploding` / **`peaked`**. `peaked` *is* their saturation state.
  Also `growth` (% increase per timeframe) and `regressions` (fits over the
  series), plus `next_12_months_forecast` in `search_history`.
- **How the penalty enters:** **label + filter, not a score component.** The
  `/topics` browse endpoint takes `type=regular|exploding|peaked|all` — users
  filter peaked topics out. The product's whole framing ("before they take
  off") makes `exploding` the surfaced set; `peaked` is the excluded class.
  Their sort keys (`growth`, `gradient`, `exponent`) are growth-shape based,
  so ranking implicitly favors pre-saturation curves.
- **Confidence:** high — first-party API surface we run in production.
- **Relevance:** this is a ready-made external saturation oracle for us — a
  `peaked` classification on the matched ET topic (~67% match rate via atomic
  `descriptor.query` terms, ADR-0003) is a direct "too late" flag.

Web-survey additions (first-party post-acquisition Semrush KB,
semrush.com/kb/1490-exploding-topics, + explodingtopics.com/methodology):

- **Peaked** is defined as "a downward trend, or one that has already peaked,
  over the period measured" — saturation is purely **search/interest
  time-series shape**, not media breadth or adoption. Companion **Speed**
  labels (Exponential / Constant / **Stationary** — flat over the period) and
  a 12-month Forecast (Growing / Stationary / Declining) encode the same
  lifecycle idea.
- A **human verification** layer reviews top-scoring trends and "filters out
  fads (movies, TV shows, celebrity gossip etc.)".
- The *implicit* penalty is at ingestion: the engine selects for early growth
  curves, so already-saturated topics mostly never enter as "trends" at all —
  a de facto hard filter at discovery time. Internal scoring math is
  undisclosed.

### Glimpse (meetglimpse.com)

- Positioning: "discover trends before they're trending." Their Chrome
  extension **de-normalizes** Google Trends' 0–100 index into absolute search
  volume; their Discover Trends feed surfaces *high relative growth on
  still-small absolute volume* and explicitly criticizes Google's native
  Breakout algorithm as "often unreliable" (meetglimpse.com/google-trends/faq/).
- **Saturation:** never defined publicly — only its inverse. Mainstream /
  plateaued terms simply don't qualify for the trend feed: effectively a
  **hard filter at surfacing time** (inferred). No public score.
- **Confidence: low-medium** — de-normalization and feed existence are
  primary; selection mechanics are marketing copy only, mechanism not
  disclosed.

### Google Trends — Top vs Rising vs Breakout (official docs)

From support.google.com/trends/answer/4355000 (high confidence, verbatim):

- **Top** = most frequently co-searched terms (absolute, within normalized
  sample). **Rising** = terms with "the most significant growth in volume",
  shown as % growth **vs the previous time period**. **Breakout** = grew by
  **more than 5000%** (near-zero base before).
- **Saturation handling is structural, not scored**: a saturated (high, flat)
  term dominates Top and *vanishes from Rising*, because a plateau has ~0%
  period-over-period growth. The ranking metric itself is a growth ratio —
  saturation → large denominator, small delta → drops out. This is the
  canonical relative-growth-over-absolute-volume framing (and our
  `FCT_TREND_GTRENDS_DAILY` interest series inherits the 0–100
  peak-normalized shape, so every curve self-reports its own peak).

### Academic / quantitative framing (brief)

1. **Logistic / S-curve fitting** (Verhulst-type; Gompertz/Richards
   variants): inflection at half carrying capacity (K/2); past inflection
   with estimated fraction-of-K above ~80–90% ⇒ "near plateau". Standard in
   technology forecasting (foresightguide.com/logistic-growth-s-curves).
2. **Bass diffusion** (Bass 1969): innovation p + imitation q + market size
   m; remaining headroom = m − cumulative adopters — a direct model-based
   "white space remaining" estimate (applied to tech-trend forecasting, e.g.
   arxiv.org/pdf/2309.00707).
3. **Gartner Hype Cycle** — shared vocabulary only (trigger → peak → trough
   → slope → plateau); no reproducible math.

(Kleinberg-style burst detection finds onsets, not plateaus — peak/plateau
calls in practice come from curve fitting or simple derivative/peak
heuristics like ET's shape labels.)

### Comparison summary

| Engine | Saturation signal | How penalty enters | Evidence quality |
|---|---|---|---|
| Trend Hunter | "Opportunity remaining" (White Space factor) + Saturation stage; underlying signal undisclosed | **Weighted term** in composite Opportunity Score; stage is label-only | Primary marketing page; no math, no patent |
| Exploding Topics | Time-series shape: downward/flat trajectory → "Peaked"/"Stationary" | **Label + user filter**; de facto hard filter at ingestion | First-party KB definitions; internal scoring opaque |
| Glimpse | Undefined; inverse = high growth on small de-normalized volume | **Hard filter at surfacing** (inferred); no public score | Marketing copy only |
| Google Trends | Plateau = ~0% period-over-period growth | **Structural**: Rising ranks by growth ratio, saturated terms drop out; Breakout = >5000% | Official docs, high confidence |
| Academic | Position on fitted S-curve vs inflection/K; Bass headroom | Continuous **inverse factor** (remaining headroom) — cleanest formalization of white space | Peer-reviewed, reproducible |

**Cross-engine takeaway:** no commercial engine publishes real saturation
math. The two disclosed patterns are (a) **growth-ratio ranking** that
structurally zeroes out plateaued items (Google Rising; ET/Glimpse
ingestion), and (b) a **weighted "opportunity remaining" factor** in a
composite (Trend Hunter's White Space) — whose academically defensible form
is logistic/Bass remaining-headroom as an inverse factor.

### External sources

- trendhunter.com/trend-intelligence-engine · trendhunter.com/ai · trendhunter.com/pro · trendhunter.com/megatrends
- patents.google.com/patent/US20160359993A1 (patent check — none owned by Trend Hunter)
- explodingtopics.com/about · explodingtopics.com/methodology · semrush.com/kb/1490-exploding-topics
- meetglimpse.com · meetglimpse.com/google-trends/faq/
- support.google.com/trends/answer/4355000
- foresightguide.com/logistic-growth-s-curves · arxiv.org/pdf/2309.00707
- In-repo: `docs/exploding-topics-api.md` (live OpenAPI spec, verified 2026-06-29), `docs/adr/0003-trend-descriptor-machine-facing-canonical-artifact.md`

## B. Internal proxy inventory

### What the prediction pillar already does about saturation (baseline)

From `docs/prediction-flow.md` + `docs/prediction-contract.md`
(`COMPUTATION_VERSION = v2`):

- `INPUT_INVERSE_HEAT = 100 − heat_now` is a **25%-weighted inverse factor**
  in `PREDICTION_SCORE` — i.e. the score already penalizes *internal* heat.
- `PREDICTION_ELIGIBLE` has a **hard gate** `INPUT_HEAT_NOW < 70` ("not
  already peaked" — Marcelo's constraint).
- **But both measure our own pipeline's attention** (heat = linked-evidence
  activity), not *real-world* saturation. A trend our discovery tier found
  late can be board-cold internally while already mainstream externally. The
  ticket's question is precisely about closing that gap.
- Known anti-correlation (issue #33): attribution growth co-occurs with heat,
  so gates stacked on "cold AND growing" starve eligibility — any added
  saturation penalty compounds this and needs the same calibration care.

### Table-by-table inventory (verified live, 2026-08-08, read-only)

Queried as `MARKETING_ENGINEER` via key-pair auth (the `claude` externalbrowser
connection's SSO cache was expired at research time; same role either way).

#### 1. `FCT_TREND_GTRENDS_DAILY` — weakest as currently pulled

Schema: `TREND_ID, PULLED_AT, KEYWORD, GEO, TIMEFRAME, INTEREST_OVER_TIME
(VARIANT), RELATED_QUERIES (VARIANT), INTEREST_PEAK_PCT, INTEREST_AVG_PCT`.
3,560 rows / 328 trends, pulls 2026-04-28 → 2026-08-08.

- **Every pull is `timeframe='now 7-d'`, GEO=US** — 169 hourly points,
  normalized to *that window's* peak (=100). A single pull cannot show
  lifecycle peak/decay; it shows one week's shape only. This is exactly the
  Google normalization trap Glimpse de-normalizes around.
- **90% of trends are under the noise floor**: latest-pull `INTEREST_AVG_PCT`
  median 0.6, p90 5.3; only **16/328 trends ≥ 20**. Compound keyword strings
  ("Non-toxic clothing", "Savory sweet snacks") barely register on Google —
  the series is ~all zeros with one spike. Same vocabulary-mismatch problem
  ADR-0003 found with ET (atomic terms match; compound names don't).
- **`RELATED_QUERIES` is almost always empty** — of 42 pulls in Aug, only 2
  had `rising` and 3 had `top` entries. Google's own rising/breakout signal
  is unavailable at our keywords' volume.
- **Cross-pull trajectory is spotty + noisy.** The poller covers *active*
  trends only, so series stop when trends retire; e.g. "wide leg jeans"
  weekly `INTEREST_AVG_PCT`: 42.5 → 5.3 → 20.4 → 23.6 → 33.0 → 27.6 (window
  shape, not volume — jumps around). Not a usable saturation curve today.
- **To make it usable**: pull `descriptor.query` (atomic term) instead of
  compound keyword, with a long window (`today 12-m`), and read the *shape*
  (position of peak, current-vs-peak ratio). That's a poller change, not a
  new source.

#### 2. `FCT_TREND_SOURCE_METRICS` — best absolute-scale levels, but one-shot

Schema: `TREND_ID, SOURCE_NAME, HEADLINE_METRIC, HEADLINE_METRIC_NAME,
METRICS (VARIANT), ENRICHED_AT, ENRICHMENT_VERSION`. Live inventory:

| SOURCE_NAME | HEADLINE_METRIC_NAME | (trend,source) pairs | avg |
|---|---|---|---|
| wikimedia | `wiki_pageviews_7d` | 610 | 30,392 |
| google_trends | `gt_interest_score` | 155 | 62.3 |
| gdelt | `gdelt_article_count_7d` | 85 | 118.4 |
| bluesky | `social_post_count_7d` | 78 | 81.2 |
| amazon | `amazon_product_count` | 55 | 13.0 |
| tiktok / pinterest | counts | 4 / 3 | — |

- These are **absolute-scale real-world levels** — exactly the measures the
  external engines imply: `gdelt_article_count_7d` ≈ mainstream-media breadth
  ("institutional commitment" / "it's already news"), `wiki_pageviews_7d` ≈
  mainstream awareness, `amazon_product_count` ≈ commercial saturation
  (products already shipping = white space closing).
- **Fatal caveat as a *curve*: every (trend, source) pair has exactly 1
  snapshot** (max snaps = 1 across all 610 wikimedia pairs, etc.). The
  sources workflow fires once per trend at promotion. So today this gives a
  *saturation level at promotion time*, never a decay/plateau shape. GDELT
  and Wikimedia are free APIs — re-polling to build trajectories is feasible
  but is new plumbing.

#### 3. `FCT_TREND_SIGNALS` cumulative curves — exists, but measures *us*

Weekly cumulative distinct-signal curves for real trends:

- **Biotech K-Beauty** (88 signals) and **Stolen Reps** (80): +85 / +77 in
  the week of 2026-04-27 (the agent-owned-ledgers **migration bulk-link**),
  then +1/week trickle — the curve is promotion-burst + trickle, not an
  organic S-curve.
- **Conservas Culture** (promoted June, 20 signals): 2 → +16 → +2 by week —
  the +16 burst is an attribution-agent sweep, not real-world dynamics.
- The prediction pillar (v2) already consumes this table's 7-day
  cumulative-set growth. A "cumulative curve has plateaued" detector is
  computable, but it measures **our pipeline's attention** (discovery volume
  × attribution-agent cadence), and bursts confound the shape. It's an
  *internal-interest* saturation proxy, not real-world saturation.

#### 4. `FCT_TREND_PREDICTION_LEDGER` — inputs are growth, not saturation

Holds cumulative source/signal counts at two anchors (`*_LAST_7D` /
`*_PRIOR_7D`) per run — a two-point growth measure per the v2 contract, not a
curve. The full curve would come from #3 (or `DT_TREND_DAILY`); the ledger
adds auditability, not new saturation information.

#### 5. Exploding Topics API (owned, external) — the sleeper candidate

Not a Snowflake table, but the strongest real-world saturation signal we can
reach today: `classifications` per timeframe (`peaked` verdict), `growth`,
`regressions`, and a 12-month forecast, per topic — against Semrush's
independently-collected search-volume corpus. Caveats: ~67% match rate with
atomic `descriptor.query` terms (6% with compound names), consumer/ecommerce
catalog skew (local/news trends systematically absent), 60 req/min.

### Verdict: most viable 2–3 proxies

1. **ET `classifications` "peaked" lookup at scoring time** (via
   `descriptor.query`) — a direct, independently-measured "too late" flag;
   miss = no-penalty (a miss is ambiguous: unmatched ≠ unsaturated).
2. **GDELT article count** (`gdelt_article_count_7d`, extendable to a re-poll
   or a direct GDELT query in the scorer) — mainstream-media breadth as the
   McClatchy-relevant meaning of "everyone's already covering it".
   Level-based hard gate or inverse factor; today promotion-time-only.
3. **GTrends shape — only after re-pointing the poller** at atomic descriptor
   terms with a 12-month window. As pulled today it cannot support a
   saturation read for ~90% of trends.

Weakest: cumulative signal-curve plateau (measures our own attention;
burst-confounded) — though it's free and already feeds the scorer.

## Options for the decision

Not a recommendation — inputs for the grilling session. The options are
orthogonal to *which* proxy is chosen; caveats note proxy fit.

**Option 0 — do nothing new.** The score already carries inverse-heat (25%)
and the `heat < 70` "not peaked" gate. Defensible if we decide internal heat
is an acceptable stand-in for saturation at our scale. Costs nothing;
concedes the late-discovery blind spot (a trend we found late looks cold to
us while mainstream outside).

**Option 1 — hard eligibility gate (the ET/Glimpse pattern).** e.g.
`PREDICTION_ELIGIBLE = FALSE` when the matched ET topic is `peaked` (or GDELT
7d article count exceeds a threshold). Cheapest to reason about and to
explain to strategists ("it's too late" as a boolean). Risks: issue #33
showed stacked gates starve eligibility (~30% target); ET misses ~33% of
trends and its catalog skews away from exactly our local/news
differentiators — a miss must mean "no penalty", which biases the gate
toward penalizing only mainstream-consumer trends.

**Option 2 — weighted inverse factor (the Trend Hunter pattern).** Add a 5th
normalized term (e.g. inverse of GDELT-article-count percentile, or an ET
status mapped to {exploding: 100, regular: 50, peaked: 0}) and re-split the
25% weights. Degrades gracefully on missing data (NULL → reweight), keeps
the queue populated, and fits the planned regression re-tune once strategist
Approve/Dismiss data accrues. Costs: changes score semantics for every
consumer (needs `COMPUTATION_VERSION = v3`), and the prediction agent is
deliberately no-LLM single-statement SQL — an ET lookup per trend means new
plumbing (a poller writing a ledger the scorer joins, mirroring the gtrends
pattern).

**Option 3 — label-only surfacing (the ET-badge pattern).** Compute a
`SATURATION_FLAG` (or surface ET status verbatim) as an additive dashboard
column with no effect on score or eligibility. Zero risk to the isolation
guarantee and to queue size; lets strategists build intuition and generates
the labeled data that would later justify Option 1/2 weights. Slowest to
change outcomes — relies on humans reading the flag.

**Cross-cutting facts for the discussion:**
- Any real-world proxy needs a *keyword bridge*; ADR-0003's
  `descriptor.query` is the only vocabulary that matches external corpora
  (67% vs 6%).
- The known heat↔growth anti-correlation means any new penalty term
  compounds the eligibility-starvation risk — recalibrate gates against live
  distribution (as #33 did) rather than picking thresholds a priori.
- The S-curve/Bass "remaining headroom" formalization needs a *volume time
  series per trend*, which no internal table has today (gtrends pulls are
  window-normalized; source metrics are one-shot). If the strategy wants
  model-based headroom, the first step is data collection, not scoring.
