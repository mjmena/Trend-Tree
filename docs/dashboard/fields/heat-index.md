<!-- Title: Heat Index -->
<!-- Parent: ATLAS Dashboard -->

# HEAT_INDEX

**At a glance** — How hot the trend is right now. Goes up when signals are recent and coming from many publishers; goes down when the trend cools off. Smoothed hour-to-hour so the number doesn't jump around.

**Scale** — 0–100. Higher is hotter. The value shown is the **smoothed** value (preferred); when a freshly-promoted trend hasn't been smoothed yet, the raw value is shown as a fallback. Rounded to one decimal place.

**What feeds it** — The lifecycle subagent (Gemini 3.1 Pro) reads the signals attached to the trend and emits a `heat_base` value — a 0–100 assessment grounded in recency, publisher breadth, and signal volume in the recent window. The subagent can also emit an optional `heat_modifier_pct` (a ±20% trend-specific adjustment) when its qualitative read of the cluster justifies bumping the base up or down.

**How it's computed** — The two agent outputs combine, get clamped, and get smoothed:

```
new_heat          = clamp(0, 100, heat_base × (1 + modifier / 100))
new_heat_smoothed = round( 0.7 × prior_smoothed + 0.3 × new_heat, 1 )
```

The smoothing is a one-sided EWMA with α=0.3 — each new observation contributes 30%, the prior smoothed value retains 70%. The displayed `HEAT_INDEX` is `new_heat_smoothed`, falling back to `new_heat` when no prior smoothed value exists yet.

**Why smoothed?** Without smoothing, a single quiet day would drop a hot trend by 20 points, and a single news cycle would spike a cold trend by 30. Smoothing means heat reflects *sustained* signal activity rather than any single hour's noise. The trade-off: heat lags reality slightly — a trend that started cooling yesterday will still show elevated heat for a day or two before the smoothed value catches up.

**What "good" looks like** — _TODO: empirical bands once we have a few weeks of post-refactor data. Likely: 0–20 = quiet, 20–50 = active, 50–75 = trending, 75+ = top decile._

**Edge cases**

- `NULL` is possible for trends that have never been evaluated by lifecycle (very rare — first lifecycle eval happens within an hour of promotion).
- Two-cycle retirement: a trend the agent proposes to retire stays at its prior status (and prior heat) for one more cycle before flipping to `RETIRED`. Heat continues to update during the proposal cycle.

**Where it appears in ATLAS** — Card badge color and value; sort key for the trend list.

---

← Back to [field reference](../index.md#at-a-glance--field-reference)
