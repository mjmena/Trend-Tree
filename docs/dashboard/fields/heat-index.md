<!-- Title: Heat Index -->
<!-- Parent: ATLAS Dashboard -->

# HEAT_INDEX

**At a glance** — How well-validated the trend is right now, measured **only from evidence actually linked to it**. Reflects how broadly multiple [publishers](../glossary.md) covered it in the last three weeks, how recent the linked activity is, and how sustained the linked signal volume is. Smoothed hour-to-hour so the number doesn't jump around.

**Scale** — 0–100. Higher means more broadly validated. The value shown is the **smoothed** value (preferred); when a freshly-promoted trend hasn't been smoothed yet, the raw value is shown as a fallback. Rounded to one decimal place.

**What feeds it** — Heat is fully deterministic (formula v2, ADR-0005). The lifecycle subagent's code computes a `heat_base` from the signals **linked** to the trend in `FCT_TREND_SIGNALS` (link kinds `supporting` / `attributed`). Vector-similar-but-unlinked "candidate" signals earn zero points — a candidate starts counting only once the attribution agent links it. The agent's judgment enters exactly once: the lifecycle **status** it chooses applies a fixed factor (below). There is no free-form agent modifier anymore, and Google Trends is not a heat input (demand-side evidence lives on the opportunity-score axis).

**The formula** (must match `lifecycle-subagent-p_gYC562o/run_subagent/entry.js:computeHeatBase()` and `PROC_LIFECYCLE_APPLY`):

```
heat_base = 25*recency + 25*velocity + 40*breadth + 10*confidence
new_heat          = clamp(0, 100, heat_base × (1 + status_factor / 100))
new_heat_smoothed = round( 0.5 × prior_smoothed + 0.5 × new_heat, 1 )

status_factor: GROWING +10 | RESURGENT +10 | STABLE 0 | NEW 0 | DECLINING −10 | DORMANT −15
```

| Factor | Pts (of 100) | What it measures |
|---|---:|---|
| recency | 25 | Time since the newest **linked** signal — half-life 120h; 0 when nothing linked in 14d (no bookkeeping-timestamp fallback) |
| velocity | 25 | Linked signals in the last 7 days — linear, saturating at 3/wk; 0 linked = 0 pts |
| **breadth** | **40** | Cross-publisher resonance in the **last 21 days** — log of distinct active publishers × Shannon entropy |
| confidence | 10 | Promotion-agent confidence (0–1) |

**Breadth — the dominant term.** Heat above ~65 is impossible without broad *current* publisher coverage. Breadth counts distinct publisher domains with a linked signal in the last 21 days (cumulative all-time breadth measured "how old," not "how validated right now"), anchored so 6 evenly-distributed active domains earn the full 40 pts:

| active publishers, last 21d (even dist.) | breadth pts (of 40) |
|---:|---:|
| 1 | 0 |
| 2 | 10 |
| 3 | 21 |
| 4 | 29 |
| 5 | 35 |
| 6+ | 40 |

A lopsided distribution (e.g., 8 of 10 signals from one publisher) earns proportionally less — the Shannon entropy multiplier shrinks the score. See the [glossary](../glossary.md) for what counts as a Publisher vs. a Source.

**Smoothing** — One-sided EWMA with α=0.5: each new observation contributes 50%, the prior smoothed value retains 50%. Heat converges to a changed baseline in about 3 cycles (~3 hours given the hourly sweeper).

**Worked example** — A GROWING trend with 3 active publishers (even distribution) in the last 21 days, 4 linked signals in the last 7 days, a 2-day-old newest linked signal, and confidence 0.6:

```
recency    = 25 × exp(-48/120)   ≈ 16.8
velocity   = 25 × min(1, 4/3)    = 25.0
breadth    = 40 × log_score(3)×1 ≈ 20.8
confidence = 10 × 0.6            =  6.0
─────────────────────────────────────────
heat_base                        ≈ 68.6
new_heat   = 68.6 × 1.10         ≈ 75.4   (GROWING +10%)
```

**What "good" looks like** — Bands are descriptive vignettes anchored on live data at the v2 cutover (2026-07-10: median ≈ 11, ~78% of trends land 0–30 — that is the honest shape of linked evidence). They are **absolute, not percentile guarantees** — a trend's number never changes because *other* trends changed:

- 0–15 — no current linked evidence; running on confidence alone
- 15–35 — a pulse: recent activity from one or two publishers
- 35–60 — actively covered by several publishers this week
- 60+ — broad, current, multi-publisher validation; rare and meaningful

**Edge cases**

- `NULL` is possible for trends that have never been evaluated by lifecycle (very rare — first lifecycle eval happens within an hour of promotion).
- Two-cycle retirement: a trend the agent proposes to retire stays at its prior status (and the fixed factor of *that* status) for one more cycle before flipping to `RETIRED`. Heat continues to update during the proposal cycle.
- Promotion seeds an initial heat from the same v2 formula using candidate-cluster proxies (source families for breadth, entropy assumed even); the first hourly lifecycle eval replaces it with the real per-publisher computation.
- A trend with zero linked signals in 21 days scores only the confidence term — typically ~5–7. That's by design: it's what makes cold trends visible to retirement sweeps.

**Where it appears in ATLAS** — Card badge color and value; sort key for the trend list.

**No longer feeds prediction.** The retired deterministic scorer read heat twice — as an `inverse_heat = 100 − heat` term and as a `heat_now < 70` eligibility gate. Both retired with it (2026-08-24, CRMA-769). Heat now reaches the prediction pillar only as one piece of context a model reasons over, never as a threshold — see [Prediction](prediction.md).

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
