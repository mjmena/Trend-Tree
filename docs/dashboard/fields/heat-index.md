<!-- Title: Heat Index -->
<!-- Parent: ATLAS Dashboard -->

# HEAT_INDEX

**At a glance** — How well-validated the trend is right now. Reflects how broadly multiple [publishers](../glossary.md) are covering it, how recent the activity is, and how sustained the signal volume is. Smoothed hour-to-hour so the number doesn't jump around.

**Scale** — 0–100. Higher means more broadly validated. The value shown is the **smoothed** value (preferred); when a freshly-promoted trend hasn't been smoothed yet, the raw value is shown as a fallback. Rounded to one decimal place.

**What feeds it** — The lifecycle subagent (Gemini 3.1 Pro) reads the signals attached to the trend and emits a `heat_base` — a deterministic 0–100 baseline blending recency, publisher breadth, signal velocity, external (Google Trends) interest, and the original promotion confidence. The subagent can also emit an optional `heat_modifier_pct` (a ±20% adjustment) when its qualitative read of the cluster justifies bumping the base up or down — e.g., an obvious cultural inflection point not captured by raw counts.

**The formula** (must match `lifecycle-subagent-p_gYC562o/run_subagent/entry.js:computeHeatBase()`):

```
heat_base = 20*recency + 25*velocity + 25*breadth + 20*external + 10*confidence
new_heat          = clamp(0, 100, heat_base × (1 + modifier / 100))
new_heat_smoothed = round( 0.5 × prior_smoothed + 0.5 × new_heat, 1 )
```

| Factor | Pts (of 100) | What it measures |
|---|---:|---|
| recency | 20 | Time since most recent signal — half-life 120h |
| velocity | 25 | Signals in the last 7 days — sigmoid centered at 2/wk |
| **breadth** | **25** | Cross-publisher resonance — log of distinct publishers × Shannon entropy |
| external | 20 | Latest Google Trends `INTEREST_PEAK_PCT / 100`; 0 when no poller row |
| confidence | 10 | Promotion-agent confidence (0–1) |

**Breadth — where most of the meaning lives.** Heat above 70 is hard to earn without broad publisher coverage. The breadth term combines two things — *how many* distinct publishers and *how evenly* distributed the signals are across them:

| publishers (even dist.) | breadth pts (of 25) |
|---:|---:|
| 1 | 0 |
| 2 | 4 |
| 3 | 9 |
| 5 | 15 |
| 8 | 21 |
| 10+ | 25 |

A lopsided distribution (e.g., 8 of 10 signals from one publisher) earns proportionally less — the Shannon entropy multiplier shrinks the score. See the [glossary](../glossary.md) for what counts as a Publisher vs. a Source.

**Smoothing** — One-sided EWMA with α=0.5: each new observation contributes 50%, the prior smoothed value retains 50%. Heat converges to a changed baseline in about 3 cycles (~3 hours given the hourly sweeper). Without smoothing, a single quiet day would drop a hot trend by 20 points and a single news cycle would spike a cold trend by 30; with smoothing, heat reflects *sustained* validation rather than any single hour's noise.

**Worked example** — A trend with 3 publishers (even distribution), 4 signals in the last 7 days, a 2-day-old most-recent signal, no Google Trends row yet, and confidence 0.6:

```
recency    = 20 × exp(-48/120)        ≈ 13.4
velocity   = 25 × sigmoid((4 − 2)/3)  ≈ 16.6
breadth    = 25 × log_score(3) × 1.0  ≈  9.6
external   = 20 × 0                   =  0
confidence = 10 × 0.6                 =  6
─────────────────────────────────────────────
heat_base                             ≈ 45.6
```

With a neutral modifier (0%), this trend's `HEAT_INDEX` settles around **45** once smoothing converges.

**What "good" looks like** — These bands will firm up empirically over the first few weeks under the new formula:

- 0–30 — quiet / single-publisher / lapsed
- 30–55 — active, narrow validation (2–3 publishers)
- 55–75 — broadly validated, sustained activity
- 75+ — top decile: many publishers, accelerating, externally corroborated

**Edge cases**

- `NULL` is possible for trends that have never been evaluated by lifecycle (very rare — first lifecycle eval happens within an hour of promotion).
- Two-cycle retirement: a trend the agent proposes to retire stays at its prior status (and prior heat) for one more cycle before flipping to `RETIRED`. Heat continues to update during the proposal cycle.
- A trend with all-orphan signal links (legacy data lineage broken by the 2026-04-28 refactor) will score near 0 from breadth/velocity/recency and survive only on the confidence floor — typically lands around 5.

**Where it appears in ATLAS** — Card badge color and value; sort key for the trend list. Also feeds the prediction agent as the `inverse_heat = 100 − heat` input and as the `heat_now < 60` eligibility gate.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
