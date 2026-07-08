# Exploding Topics — A Trend-Yield & Validation Opportunity

**Status:** Evaluation / proposal — not yet built
**Author:** Martin Mena
**Last updated:** 2026-06-22
**Audience:** Anyone weighing whether Exploding Topics is worth adding to Trend Tree.
No familiarity with the internals required.

---

## The one-paragraph version

Trend Tree finds emerging consumer trends and promotes the real ones into its
database. To keep that database clean, every candidate must clear a few quality
gates before it's promoted — and the strictest gate requires that a trend be seen
by **two independent sources** before we'll trust it. That gate does its job, but
it's blunt: it also turns away a large number of genuinely promising trends whose
only flaw is that, so far, just one source has noticed them. **Exploding Topics is
an independent, authoritative second opinion on exactly those trends.** Adding it
lets us rescue the strongest single-source trends — an estimated **15–40% increase
in the number of trends we promote each month** — while also enriching every trend
with real search-volume data, all comfortably within a small monthly API budget.

---

## How Trend Tree promotes trends (in brief)

1. Trend Tree continuously gathers signals about what's emerging — from social
   platforms, retail data, search data, and several AI discovery agents.
2. Those signals are grouped into **candidate trends**.
3. Each candidate is evaluated and either **promoted** into the database or rejected.

We promote roughly **100 new trends per month** today.

### The gates that protect the database

Most candidates are rejected — that's by design. If everything were promoted, the
database would flood with noise and the genuinely useful trends would be buried.
The two hard rules are:

- **Not an orphan** — a candidate has to be more than a single isolated data point.
- **Seen by two independent sources** — a trend that only one source has noticed is
  treated as possible noise, not yet a real movement.

The second rule is the important one here. We call it the **two-source gate.**

---

## The opportunity: the two-source gate is too blunt

The two-source gate is a reasonable safety rule, but it can't tell the difference
between *"only one source noticed this because it's noise"* and *"only one source
has noticed this **yet** because it's early."* It rejects both.

When we look at what the gate is actually turning away, the pattern is striking:

- About **170 candidates a month** are rejected **solely** because they haven't yet
  picked up a second independent source.
- These are **not** thin or junky. On average they carry several corroborating
  signals and score high on confidence. They look like real trends — they're just
  early, or surfaced by a single discovery source the others missed.
- A high-quality core of roughly **44 a month** is especially compelling
  (high confidence *and* multiple supporting signals).

Examples of trends recently turned away at this gate — each plausible, each
single-sourced:

- Japanese head spas / clinical scalp facials
- Protein-fortified versions of everyday snack foods
- NAD+ supplementation for longevity
- Off-peak / shoulder-season travel as a deliberate strategy
- Raw milk consumption as a wellness-and-identity statement

These are the kinds of trends Trend Tree exists to catch early. Today we let them go.

---

## What Exploding Topics adds

Exploding Topics is a commercial trend-intelligence service that tracks search
demand across more than a million topics and flags which ones are emerging,
growing, or peaking — updated daily, drawn from data entirely independent of our
own sources.

That independence is the whole point. When our pipeline flags a single-source
candidate and Exploding Topics independently shows the same topic gaining
search demand, **that's the missing second source** — an authoritative, outside
confirmation that the trend is real.

### Three ways it helps

**1. Higher trend yield (the headline).**
Use Exploding Topics as the second opinion on single-source candidates. When it
confirms one, that candidate clears the two-source gate and gets promoted like any
other trend. Confirming even the strongest slice of what's currently rejected would
lift our monthly output by an estimated **15–40% (roughly +15 to +40 trends per
month** on top of ~100). The exact figure depends on how many of these topics
Exploding Topics recognizes — which is why we'd start with the high-confidence core
and measure before scaling.

Importantly, this just helps us **find the right trends sooner.** A single-source
trend that's genuinely real will sometimes pick up a second source on its own days
or weeks later — Exploding Topics simply lets us recognize it now instead of waiting
and hoping. (In practice, many of these never do resurface on their own, so the
upside is real — but the simplest way to think about it is *earlier*, not *saved*.)

**2. Better enrichment data.**
Beyond the yes/no confirmation, Exploding Topics provides real numbers for each
trend: actual monthly search volume, growth rate, years of history, and a forward
projection. Trend Tree already has a place to display search metrics, but today
they come from a fragile, partial source. Exploding Topics is a cleaner, richer
feed — making every promoted trend more credible and easier to act on.

**3. A confidence check, especially early on.**
While Trend Tree is still young, the most valuable question to answer is *"are we
finding the right trends at all?"* Each time Exploding Topics independently
recognizes a trend we promoted, that's outside validation that the pipeline is
working. Tracking how often the two agree gives us a simple, defensible health
score — and a strong story to tell stakeholders.

---

## The cost fits easily

Exploding Topics access comes with a budget of about **1,000 API requests per
month.** Our needs sit well inside it:

| Use | Approx. requests / month | Share of budget |
|---|---:|---:|
| Confirm single-source candidates (high-quality core) | ~44 | ~4% |
| ...or the full set of single-source candidates | ~170 | ~17% |
| One search-data lookup per promoted trend | ~100 | ~10% |
| **Everything above, combined** | **~270** | **~27%** |

We can run all of it as a standing, always-on capability and still use barely a
quarter of the monthly allowance — leaving plenty of headroom. There's no need to
ration it or save it for end-of-month.

### A timely fit on cost

Trend Tree's current search-metrics feed is a stopgap awaiting proper, sanctioned
data access. Exploding Topics supplies the same class of data through a supported,
reliable service at a comparable price to what that access will cost — so adopting
it now slots into the same budget envelope rather than opening a new one. (One
caveat: the budget covers a fresh search-data snapshot *per trend*, not a daily
re-poll of every trend in the database — so we'd use it to enrich trends as they're
promoted and to fill today's coverage gaps, not as a wholesale daily replacement.)

---

## Using the full quota each month

To be clear up front: the core use — rescuing strong single-source trends and
enriching every promoted trend — is already worth it on its own, and it only spends
about a quarter of the monthly allowance. Everything in this section is about what
to do with the *rest*.

Our guiding principle is simple: **aim to use as close to the full monthly quota as
we can, because it's already paid for** — unused requests are wasted value, not
saved money. Each month's leftover headroom should cascade into progressively more
optional enhancements, filling the budget from the top down:

1. **Core uses (~270/mo)** — confirm single-source candidates and attach search
   data to newly promoted trends. *(Covered above.)*
2. **Pull in their trending lists as a discovery feed (~30/mo)** — a cheap daily
   pull of newly-exploding topics, used to corroborate trends already moving
   through our pipeline.
3. **Refresh search data on the live trend database (~300/mo)** — periodically
   re-check the trends we've already promoted so their numbers stay current and we
   can see which are still accelerating.
4. **Reach deeper into the rejected pool and retry near-misses (the remainder)** —
   lower the bar to validate more of the single-source candidates we currently turn
   away, and re-try topic lookups that didn't match on the first attempt to improve
   coverage.

Spent this way, we comfortably approach the full 1,000 requests a month while every
tier beyond the core is pure upside.

### A firm boundary: additive only, never required

However much quota we use, Exploding Topics is **strictly additive.** Nothing in
Trend Tree's core operation will ever depend on it. Every trend can still be found,
promoted, and enriched with Exploding Topics completely absent — it is one more
surface layered on top, never a link in the chain. If the service is unavailable,
rate-limited, or we let it lapse, the pipeline runs exactly as it does today, just
without the extra confirmation and richer numbers. That keeps it a low-risk
enhancement: all upside, no new dependency.

---

## Recommended next steps

1. **Confirm Exploding Topics' coverage** of the kinds of trends we surface — i.e.
   how often it actually recognizes our candidate topics. This is the single
   biggest unknown and determines the real size of the yield gain.
2. **Start with enrichment** — attach Exploding Topics data to newly promoted
   trends. Lowest risk, immediately useful, and it gives us the agreement/health
   metric for free.
3. **Then turn on yield recovery** — use it as the second opinion on the
   high-confidence single-source candidates, measure the lift, and scale from there.

---

### A note on the numbers

The figures here come from Trend Tree's own promotion records over roughly the last
two months and are reproducible on request. They describe steady-state behavior;
the yield estimate is deliberately a range because the binding factor — how much of
our trend space Exploding Topics covers — can only be pinned down by testing it
against real candidates.
