# Heat velocity is acceleration; breadth anchors at 10 publishers

**Status:** accepted (2026-11-02). Amends the velocity and breadth lines of
ADR-0005; everything else in ADR-0005 stands.

## Context

On 2026-11-02, trends promoted 120+ days ago held the top of `HEAT_INDEX`:
41 of 242 sat at 80 or above (median 45.5), and some 4-month-old trends sat at
100. Their fresh evidence was almost entirely `attributed` links.

CRMA-1459 (2026-10-16) rotates the attribution sweep over every live trend.
Attributed links rose from about 40–200 per week to about 1,000 per week from
the week of 2026-10-12, spread over about 300 trends. ADR-0005's anchors were
set when attribution added about 30 links per week: velocity saturated at 3
linked signals per week and breadth at 6 publishers. At about 3.5 links per
trend per week, every swept trend maxed out velocity, and broad old trends
maxed out breadth.

## Decision

```
velocity = clamp((n7 − baseline) / max(3, baseline), 0, 1)
           n7       = linked signals in the last 7 days
           baseline = linked signals 8–35 days ago / 4   (per week)
breadth  = clamp((log₂(d) − 0.5) / (log₂(10) − 0.5), 0, 1) × shannon_entropy
```

- **Velocity measures acceleration against the trend's own baseline.** A
  steady flow scores 0; doubling the baseline earns full points. With no
  baseline it equals ADR-0005's `min(1, n7/3)`, so new trends and the
  promotion seed are unchanged.
- **The counts are uncapped SQL counts** in the `metrics` prefetch, not the
  30-row `recent_signals` prefetch the agent reads.
- **Breadth saturates at 10 evenly distributed publishers**, up from 6.
- **No age ceiling.** An age cap was simulated and works (0 trends aged 120+
  days at heat ≥ 80), but it makes heat a measure of novelty, not current
  validation. Rejected for now.

## Consequences

- Simulated on 2026-11-02 over 583 live trends: trends at heat ≥ 80 fall from
  65 to 40, at ≥ 60 from 152 to 80; the 120+ day bucket's median falls from
  43.1 to 33.2.
- Old trends still read as accelerating for about 4 weeks, until the 8–35 day
  window absorbs the October attribution jump. Re-check the distribution then.
- Breadth (40) + recency (25) + confidence (10) still let a broadly attributed
  steady trend reach about 75. If that remains a problem after the baseline
  settles, the next lever is the age ceiling or attribution quality, not
  velocity.
- The status rubric's `n7` / `n7_prior` inputs are unchanged (anti-feedback
  rule: status never reads heat).
