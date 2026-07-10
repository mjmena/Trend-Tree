# Heat measures linked evidence only: formula v2

**Status:** accepted (2026-07-10)

## Context

Issue #34 documented heat compressing into 0–77 (median 52.5, top band ~4%);
issue #36 documented an inert, directionless ±20% lifecycle heat modifier and
an 80%-STABLE status blob. A 2026-07-10 grilling session traced all three
symptoms to mechanisms none of the issues had named:

- **Candidate-signal inflation (the dominant cause).** `computeHeatBase()`
  merged the lifecycle subagent's *candidate signals* — up to 20 unlinked
  signals per eval, cosine ≥ 0.45 to the trend vector, from the whole last-7d
  firehose — into the same array as the trend's linked signals. Since ~20 weak
  matches exist for almost any enriched trend in any week, recency (20 pts) and
  velocity (25 pts) were near-free for everyone: measured on the 50 freshest
  evals, 50/50 had candidates injected (avg 14.4), 37/50 had velocity saturated,
  43/50 had recency saturated. A trend with two linked signals from a month ago
  ("AI glasses & VR hardware") scored as "covered today" off toy-pop-up and
  shopping-cart noise. This inflated the *bottom* of the scale to ~50, masked
  dead trends from retirement (125 of 337 live trends had zero publishers
  active in 21 days), and saturated the "signal flow" context the status
  rubric reads — so nearly everything read as steady → STABLE.
- **Cumulative breadth was an age-counter.** The breadth term counted distinct
  publisher domains over the trend's whole lifetime (no window):
  corr(age, breadth) = 0.42; median all-time domains 3 vs median *active-in-21d*
  domains 1. It measured "how old," not "how validated right now."
- **External (Google Trends) was a coverage lottery.** ~80% of trends have no
  GT row on a given day (#32), so the 20-pt external term was a hard 0 for
  most — capping the top of the scale.
- **The modifier never worked as designed.** Zero positive modifiers across
  all 337 latest evals (guidance said GROWING may go to +15). Its only large
  use (−20) was the agent manually compensating for the candidate inflation
  above. The rubric's "use sparingly" + a source-breadth callout that
  double-penalized what the formula already penalized left it inert and
  status-blind.

## Decision

Heat becomes a pure, deterministic measure of **linked evidence** — signals
attached to the trend in `FCT_TREND_SIGNALS` (link kinds `'supporting'` /
`'attributed'`). Candidate signals remain in the agent's prompt as a growth
hint but earn **zero** heat points; the path for a candidate to start counting
is attribution, not similarity.

```
heat_base = 25·recency + 25·velocity + 40·breadth + 10·confidence

recency    = exp(−hours_since_newest_LINKED_signal / 120)   (no LAST_UPDATE_AT fallback —
                                                             bookkeeping timestamps are not evidence)
velocity   = min(1, linked_signals_last_7d / 3)             (linear; replaces the sigmoid and its
                                                             0.34 zero-signal floor)
breadth    = clamp((log₂(d) − 0.5) / (log₂(6) − 0.5), 0, 1) × shannon_entropy
             d = distinct publisher domains active in the last 21 days
new_heat   = clamp(0, 100, heat_base × (1 + m[status]/100))
             m: GROWING +10, RESURGENT +10, STABLE 0, NEW 0, DECLINING −10, DORMANT −15
```

- **Google Trends is removed from heat entirely.** Demand-side evidence lives
  on the [white space] / [opportunity score] axis, which already consumes GT.
  Heat is earned publisher behavior; the axes stay clean.
- **Breadth is windowed (21d) and re-anchored to 6 active domains** (observed
  windowed max 6, p90 3), and its weight rises to 40 — making the glossary's
  "breadth is the dominant term" true in code for the first time.
- **The status modifier survives, but as a fixed per-status table applied in
  code.** The agent's judgment is fully expressed in choosing the status; the
  magnitude is never the LLM's to pick (it never once used the intended range).
- **Anti-feedback rule:** the status rubric's re-tuned thresholds key only on
  raw linked metrics (linked n7 vs prior week, active-publisher deltas, days
  silent) and never on modified heat — otherwise status→heat→status closes a
  loop.
- **Deploy honest, no blending.** Simulated on 2026-07-10 live data: median
  drops 48.5 → 11.4, with 262/337 in the 0–30 band — because that is the truth
  of the linked evidence. The top-10 under v2 is face-valid, and the old
  formula was actively *misranking* (a genuinely-surging trend, "Sashiko
  Socials," scored 22.6 old vs 77.9 new). Retirement sweeps are expected to
  clear the cold backlog over the following weeks.
- Heat remains **trend-intrinsic and absolute**: bands are descriptive
  vignettes re-anchored empirically, never percentile guarantees ("top decile"
  phrasing is banned — it would make heat population-relative).
- EWMA smoothing (α = 0.5) and the ledger schema are unchanged.

## Considered alternatives

- **Redistribute weight when GT is missing** (issue #34's suggestion): rejected
  for the measurement-penalty perversity — an unpolled trend would outscore an
  identical polled-but-modest one, and heat would *drop* the day the poller
  finally reached a trend.
- **Count candidates at a stricter cosine (~0.75)**: rejected — keeps two
  evidence standards inside one number and makes the attribution agent's job
  ambiguous (why link anything if unlinked already counts?).
- **Percentile-calibrated heat** (make "75+ = top decile" literally true):
  rejected — a trend's number would change because *other* trends changed,
  breaking trend-intrinsic, EWMA semantics, and prediction's gate stability.
- **Retire the modifier entirely** (`NEW_HEAT = HEAT_BASE`): a close call;
  keeping a deterministic status factor was chosen so trajectory visibly
  renders into the level strategists see. The accepted double-count (velocity
  paid once in `heat_base`, again via the GROWING factor) is deliberate.

## Consequences

- **Prediction (#33) must be recalibrated.** The `heat_now < 70` eligibility
  gate was calibrated to the compressed 0–77 scale; and for ~1–2 weeks after
  cutover the `acceleration` input reads as board-wide deceleration (heat
  levels drop ~30 pts), so the Predictions Queue will go quiet before it
  recovers. Re-derive the gate against the v2 distribution.
- **Heat accuracy now depends on attribution coverage** (~470 attributed links
  per 14d today). If the attribution agent is too conservative, real activity
  goes uncounted — attribution throughput becomes a first-class health metric
  (candidate follow-up issue).
- The board gets visibly colder before retirement rebalances it; stakeholders
  should be briefed that this is the correction, not a regression.
- Doc syncs required at implementation: `docs/dashboard/fields/heat-index.md`
  (full rewrite; also fixes the `INTEREST_PEAK_PCT` drift by deleting the
  external row), `docs/dashboard/fields/lifecycle-status.md` (stale vocabulary:
  lists `STAGNANT`, missing GROWING/DORMANT/RESURGENT), `docs/prediction-contract.md`
  (gate note), and the Confluence ATLAS mirrors.
