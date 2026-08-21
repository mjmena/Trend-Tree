<!-- Parent: ATLAS space homepage · Confluence mirror: "Trend Tree Prediction Pillar Strategy" (ATLAS space) -->
<!-- Canonical source. Edit this file first, then republish the Confluence page. -->

# Trend Tree Prediction Pillar Strategy

**Status:** Draft for review — Jason Smith, Marcelo Freitas, Josh (+ Trend Hunter input welcome)
**Author:** Martin Mena · **Date:** 2026-08-20
**Provenance:** Every decision here was worked and recorded on wayfinder map
[CRMA-481](https://mcclatchy.atlassian.net/browse/CRMA-481); each section links its
decision ticket. The engineering spec that implements this strategy is a successor
effort and inherits the constraints in §10.

---

## 1. What this document decides

Trend Tree today computes a nightly `PREDICTION_SCORE` for every mature trend with a
deterministic SQL formula. This document replaces that model with a **prediction
pillar**: an agent that makes explicit, falsifiable calls about what happens next,
records a verdict for each call, and builds a visible track record of how those calls
resolve.

It defines five things:

1. **What a prediction is** — and its boundary with trends and with prediction cards (§2, §9).
2. **How predictions are generated** — predictions-first, blind to existing trends (§3).
3. **The scoring philosophy** — verdicts as the source of truth, numerics as their projection (§4–5).
4. **The verdict record** — what one contains and where it lives (§6).
5. **The feedback loop** — coverage, resolution, the track record, and the isolation guarantees (§7–8).

Implementation is deliberately out of scope. A `/to-spec` successor effort consumes
§10 and produces the engineering spec.

## 2. What a prediction is

> A trend says "something is happening **now**." A prediction says "we think this
> happens **next**."

This is the Trend Hunter / ATLAS methodology's own boundary language, and the pillar
adopts it. Trend Tree's trends may stay utility-oriented (a product category moving, a
behavior spreading); predictions lean **cultural** — identity, community, fandom,
taste. Utility signals still count when they create the conditions for behavioral
change.

A prediction candidate must satisfy the methodology's core formula:

**emerging evidence + cultural implication + meaningful white space + plausible outcome**

If the thing is already obvious, it is a trend, not a prediction. If there is no
credible evidence, it is speculation, and the pillar does not emit it.

**Every prediction is a falsifiable 4-part claim** ([CRMA-485](https://mcclatchy.atlassian.net/browse/CRMA-485)):

| Part | Meaning | Example |
| --- | --- | --- |
| **Subject** | An atomic descriptor-vocabulary subject (ADR-0003) | `rucking vests` |
| **Directional claim** | What changes in the world | mainstream retail adoption expands beyond specialty fitness |
| **Horizon** | One of four controlled bands (§7.5) | emerging, 3–6 months |
| **Observable check** | What we look at to grade the claim | major-retailer listings + sustained search-interest growth |

A topic without a claim — "targeted supplement stacking" — is never emitted, however
confident the agent feels. The 4-part structure is what makes grading possible later;
it is enforced by the record schema (§6), not by prompt discipline.

**Two different "white spaces" — read this once.** The phrase spans two axes in our
system, and this doc touches both:

- A **white-space prediction** is a prediction whose claim matches no current Trend
  Tree trend — the pipeline has not promoted this emergence yet. Prediction axis.
- **White space** (unqualified, opportunity axis) is a market condition: live demand
  with no McClatchy *coverage*.

The two can co-occur but measure different absences. This doc never shortens
"white-space prediction" to bare "white space."

## 3. Predictions-first: how predictions are generated

Decision: [CRMA-482](https://mcclatchy.atlassian.net/browse/CRMA-482).

The pillar is **not** a scoring layer on top of vetted trends. The flow is reversed:

1. **Generate blind.** The prediction agent generates candidate predictions from the
   signal corpus (`FCT_SIGNALS`) **without reading** `FCT_TRENDS`, heat, or lifecycle.
2. **Compare.** It then compares each candidate against current Trend Tree trends:
   - **Match** → the prediction **corroborates** an existing trend and can inform that
     trend's prediction state on the dashboard.
   - **No match** → a **white-space prediction** — the genuinely interesting output:
     a call the trend pipeline has not made yet.

Generation-blindness is a structural answer to the self-fulfilling-prophecy concern
(raised by Upstatement): generation cannot be steered by heat it never sees.

Generation inputs are `FCT_SIGNALS` only, to start. Independence comes from not
reading the trend and heat tables, not from separate ingestion. Own external lenses —
e.g. the Exploding Topics API — are a **named intended extension**, not the starting
point.

The methodology's **five emergence paths** describe what the agent looks for: signal
convergence, a high-potential single signal, cross-category transfer, a
structural-enabling change, a pattern break. Note that four of the five do not start
from an existing trend — independent support for the predictions-first shape.

## 4. Why the deterministic scorer retires

The current `prediction-agent` is a nightly batch SQL formula with six hard AND
eligibility gates (`docs/prediction-contract.md`). Two independent lines of evidence
retire it:

**The measured v2 baseline** (carried from the closed prediction-scoring-v3 map,
CRMA-428): eligible-set precision ≈ 22.6% against a 13.5% base rate (P@10 0.30);
**zero lift** in the Emerging band; half the formula's terms and 3 of 5 live gates
dead under heat v2; and attribution throughput (~6% of trends per week) caps how many
trends the scorer can ever cover. The formula measures pipeline attention, not the
world.

**Stakeholder methodology, independently.** The Trend Hunter doc's rule — *convergence
multiplies confidence; it must never gate eligibility; evidence quality beats signal
counts* — is a direct indictment of hard AND gates arrived at without seeing our
measurements.

The 2026-08-07 alignment (Jason + Martin) already pointed here: verdict-based
reasoning will be adopted, starting with the prediction agent, while numeric scores
stay in the UI.

## 5. Scoring philosophy: verdicts, with numerics as projection

Decision: [CRMA-485](https://mcclatchy.atlassian.net/browse/CRMA-485).

**Verdicts are the source of truth; numerics are their projection.** The agent emits a
verdict record per prediction (§6). The match path projects the latest active matched
verdict into the retained dashboard fields:

| Dashboard field | Becomes |
| --- | --- |
| `PREDICTION_SCORE` | the verdict's calibrated confidence |
| `PREDICTION_FLAG` | its banding |
| `PREDICTION_ELIGIBLE` | "this trend has an active queued prediction" |

Column names, types, and ranges are preserved per the meeting alignment. The
**semantics** change deliberately: today every mature trend gets a number; under this
strategy, only trends the system made a call about do. A trend with no active matched
prediction reads `NULL` — an honest "no active prediction about this trend."

**The named trade: coverage → integrity.** This strategy deliberately trades a score
on every trend for a score only where the system made a call. If stakeholders expect
wall-to-wall numbers, this is the sentence to argue with.

Supporting stances:

- **The six v2 gates demote to evidence.** Heat, acceleration, cumulative source and
  signal growth, and trend age become named context the verdict must address — never
  mechanical filters. Only a **data-quality floor** stays mechanical: no verdict is
  requested on trends too young or too sparse to judge (≈ the old 14-day rule). The
  percentile gate dies with the batch run; the heat-v2 gate-recalibration follow-up
  (GitHub #33) closes as mooted.
- **Saturation enters as evidence, not a gate.** Exploding Topics' `peaked`
  classification (looked up via `descriptor.query`) and GDELT article breadth are
  required context on the verdict. `peaked` argues against high confidence; nothing is
  mechanically excluded; an ET miss carries no penalty (ET's catalog skews away from
  local and news trends). Of the four patterns framed by the saturation research
  ([CRMA-483](https://mcclatchy.atlassian.net/browse/CRMA-483)), this is the
  verdict-native form of the weighted-inverse factor.
- **The Predictions Queue stays trend-facing for now.** Queue entry = a trend with a
  matched, sufficiently-confident verdict. White-space predictions land in the ledger —
  building an auditable history of calls — but reach no strategist surface yet.
  Surfacing them is a deliberate future step, taken after the first resolution cycle
  shows what they are worth.
- **The methodology's six scoring dimensions** (cultural relevance, white space,
  plausibility, evidence breadth, cross-category potential, consumer interest) map
  onto the verdict's evidence contract (§6) — they are what `REASONING` must address,
  not a parallel numeric rubric.

## 6. The verdict record

Decision: [CRMA-486](https://mcclatchy.atlassian.net/browse/CRMA-486).

**A prediction is a durable object.** A `PREDICTION_ID` is minted at first emission,
and the 4-part claim is **frozen at mint** — a claim you can silently rewrite is a
claim you can never grade. Every evaluation appends a new row against that id (row
grain: prediction × evaluation). Re-evaluations move confidence and status, never the
claim.

**Home: a new ledger** — `FCT_PREDICTION_VERDICT_LEDGER` (working name). Append-only,
agent-owned, consistent with the 2026-04 agent-owned-ledgers refactor. Nullable
`MATCHED_TREND_ID`; NULL marks a white-space prediction. The existing
`FCT_TREND_PREDICTION_LEDGER` freezes as v1/v2 history (no new writes), mirroring the
`FCT_TREND_METRICS` freeze precedent.

**The record envelope** — the part designed to generalize to the other agents:

| Component | Content |
| --- | --- |
| **Claim** (frozen) | `SUBJECT_DESCRIPTOR`, `DIRECTIONAL_CLAIM`, `HORIZON_AT`, `OBSERVABLE_CHECK` — four NOT NULL columns. Falsifiability is a schema constraint. |
| **Verdict** (two axes, never conflated) | `CONFIDENCE` (calibrated number → projects to `PREDICTION_SCORE`) + `PREDICTION_STATUS` (`ACTIVE` / `RESOLVED_TRUE` / `RESOLVED_FALSE` / `EXPIRED` / `WITHDRAWN`). Strengthened/weakened is always derived from the prior row's confidence delta, never stored. |
| **Evidence** | One contracted `EVIDENCE` VARIANT with documented required keys: `source_signals` (the `FCT_SIGNALS` ids behind the call), `saturation` (ET classification + GDELT breadth), `trend_context` (heat / acceleration / growth / age; NULL for white-space), `coverage` (§7). Rule: filterable facts are columns; readable context is JSON. |
| **Narrative** | `REASONING` and `WHAT_CHANGED` as first-class text columns — the agent's answer to "what is your verdict, what changed, what is your evidence" at every step. |

**Surface: the story, not just the score.** The dashboard gains additive columns
projected from the latest active matched verdict: the rendered claim sentence, the
reasoning, what changed, and when it was evaluated. Evidence JSON stays ledger-only.
This is the direct answer to the content team's "how are these decisions getting
made" ask.

The envelope — claim + verdict + evidence + reasoning + what-changed — is the pattern
intended to generalize to the lifecycle, promotion, and attribution agents. Each
agent's evidence keys differ; the envelope does not. That rollout is out of scope
here (§9).

## 7. The feedback loop

Decision: [CRMA-487](https://mcclatchy.atlassian.net/browse/CRMA-487), grounded in
the coverage-signal research
([CRMA-484](https://mcclatchy.atlassian.net/browse/CRMA-484)).

### 7.1 Isolation is a hard invariant

Coverage signal only ever touches prediction-side records — the `coverage` key of the
verdict's `EVIDENCE`. It never influences `HEAT_INDEX` or `LIFECYCLE_STATUS`, never
lands in `FCT_SIGNALS` or the clustering corpus, and is never a source. This extends
the existing prediction/trend isolation guarantee in the same register. The general
principle is the named `CONTEXT.md` invariant **evidence purity**: every
`FCT_SIGNALS` row traces to a verifiable external artifact; system-authored content
may inform agents as *context*, never enter as *evidence*.

### 7.2 Coverage: detect mechanically, consume via verdict

Detection is the empirically-proven embedding match: prediction/trend text embedded
at 768 dims via Cortex, cosine-matched against `MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS`
(1.92M-story CMS publish feed) — cheap, auditable SQL. Consumption is verdict-side
only: coverage lands as evidence, and the posture the Predictions Queue shows derives
from the latest verdict. There is **no mechanical flag demotion** — that would
quietly recreate the batch scorer this strategy retires.

**Coverage definition** is inclusive: any McClatchy-published content attributable to
the prediction's subject — commerce, wire, and staff alike — with syndicated
duplicates counted once (one editorial decision, not 33 markets' worth). Coverage can
only demote (§7.3), so a false positive costs little. The newsroom/commerce
distinction is a weighting refinement implementation may add; thresholds and dedupe
rules are delegated to the spec.

### 7.3 The one-way valve

**Internal coverage may only demote** — lower actionability, lower queue priority. It
may never raise confidence or corroborate a prediction; only external evidence
corroborates. This single rule kills the circular-reporting objection ("fiber
maxing's crushing it because we created 100 fiber-maxing stories") and the
self-fulfilling-prophecy concern.

### 7.4 The human tier outranks automation

Precedence: **strategist action > coverage demotion > automated evidence.**

- **Dismiss** → the agent records a `WITHDRAWN` verdict.
- **Approve** → protection from automated demotion until the next human touch, plus
  queue standing.
- Strategist Approve/Dismiss decisions (Insights Postgres `prediction_decisions`) are
  retained as a **calibration label tier** — recorded now, regression-tuned against
  later, never live-trained.
- The methodology's editorial publish gate is the same tier: a human **surfacing**
  gate, not a truth gate. Predictions resolve on their own record regardless of what
  publishes.

### 7.5 Horizons: four controlled bands

The minted horizon adopts the Trend Hunter bands as controlled vocabulary: **near
term 1–3 months / emerging 3–6 / cultural shift 6–12 / longer range 12–24.** Band
boundaries are revisable; the band structure is not. Resolution timing keys off the
band's window.

### 7.6 The track record: Correct / Early–Late / Incorrect, always derived

The methodology's resolution vocabulary is **computed** from three ledger facts —
latest `PREDICTION_STATUS`, the resolving verdict's timestamp, and mint date +
horizon band. It is never stored:

| Latest status | Resolving timestamp vs horizon window | Grade |
| --- | --- | --- |
| `RESOLVED_TRUE` | inside window | **Correct** |
| `RESOLVED_TRUE` | outside window | **Early–Late** |
| `RESOLVED_FALSE` | — | **Incorrect** |
| `EXPIRED` (no later truth) | — | **Incorrect** |
| `WITHDRAWN` | — | excluded from the track record |

`EXPIRED` is non-terminal but bounded: the agent re-checks an expired prediction for
**one additional horizon length**, then the grade freezes. A later `RESOLVED_TRUE`
inside that grace window flips the grade to Early–Late. No enum change is needed —
the §6 status set and its "direction is derived, never stored" rule both hold.

### 7.7 Queue-exit semantics: demotion is not removal — saturation is

- **Internal coverage demotes only**: "act now" → "watch/covered," still visible on
  the queue. External demand can re-raise a covered prediction — never internal
  coverage; the valve holds. If Google Trends interest keeps climbing after we ship
  three rucking-vest stories, the next verdict can raise it back to "act."
- **External saturation removes from the queue**: the queue's promise is earliness.
  When the world piles on (ET `peaked`, broad GDELT breadth), the call window is
  over — often as `RESOLVED_TRUE`: the claim arrived, and the track record reads
  Correct.
- **Removal is queue-exit, not deletion**: the record persists, resolves, and counts
  in the track record. Exit is always verdict-driven — resolution, expiry freeze,
  saturation verdict, or strategist `WITHDRAWN`. No separate mechanical eviction rule.
- **Boundary with the opportunity axis**: saturation kills the *prediction* (too late
  to be early), not necessarily the *white space* — a nationally-saturated,
  McClatchy-uncovered topic can stay live on the ATLAS opportunity surface. The
  Predictions Queue and the opportunity surface part ways exactly there; the two
  readings are complementary, not contradictory.

## 8. White-space predictions and the trend pipeline: hints, never evidence

Decision: [CRMA-498](https://mcclatchy.atlassian.net/browse/CRMA-498).

White-space predictions seed the trend pipeline through exactly one door:
**distillation-tier hints**. When the distillation lead dispatches the shared
cluster-agent, the open white-space predictions' claims enter the cluster-agent's
prompt as recognition context — "if signals already in your pool independently
support one of these, you may form a candidate." The hint binds the shared
cluster-agent, so the revisit pass activates identically.

**Why this tier.** The forcing risk lives in the generative tier: a discovery agent
handed "watch areas" will return something for them, so discovery-tier hints
*create* evidence rows that exist because we asked. The distillation cluster-agent
only works over signals that already arrived — a hint there cannot cause a single
new row; it buys recognition of thinly-scattered support the pool already holds.
Residual eager-clustering risk is absorbed by the unchanged promotion gate.

**Named anti-pattern:** discovery-tier steering and synthetic-signal injection are
ruled out by the **evidence purity** invariant (§7.1). Discovery stays blind; no
prediction-derived row ever enters `STG_EXTERNAL_SIGNALS` or `FCT_SIGNALS`.

**Corroboration integrity.** Every relevant match records two facts in the verdict's
`EVIDENCE`: **hint provenance** (which prediction hinted the candidate — attention
influence) and **signal overlap** (the intersection of the prediction's
`source_signals` with the matched trend's `FCT_TREND_SIGNALS` links — evidence
independence; high overlap = the same observation read twice, weak corroboration).
The verdict weighs both when setting confidence — no mechanical discount — and the
track record segments hint-influenced resolutions from blind ones so calibration
stays honest.

**Phasing.** Seeding ships as a **named extension with an activation gate**, like the
external lenses: stance and mechanism are committed now, but the switch flips only
after the first resolution cycle produces a track record — evidence that white-space
predictions are worth steering by. Hints are not v1 spec scope.

## 9. Boundaries

- **Prediction cards are out of scope**
  ([CRMA-488](https://mcclatchy.atlassian.net/browse/CRMA-488), closed). The right
  model is **nominate-then-curate** — the agent flags card-worthy predictions, an
  insights analyst curates what ships, and no card exists without a human — but
  everything card-side (nomination queue UX, curation flow, the card rubric) belongs
  to a successor effort. The methodology doc leans on consumer-card framing ("Are you
  in or out?", consumer-interest scoring, sample cards, the editorial publish gate);
  this pillar's deliverable ends at **prediction records**, and the card framing is
  handed forward with this boundary stated.
- **Verdict rollout to the other agents** (lifecycle / promotion / attribution) is
  out of scope. The envelope (§6) is designed to generalize; prove the pattern on
  the prediction agent first.
- **ATLAS UI changes** beyond retaining the existing numbers and the additive
  columns in §6 are out of scope.

## 10. Constraints and assumptions for the successor spec

The `/to-spec` effort that implements this strategy inherits these:

1. **Heat/lifecycle isolation.** Prediction outputs never influence `HEAT_INDEX`,
   `LIFECYCLE_STATUS`, or any other scoring path. Existing product requirement,
   extended by §7.1 to the coverage loop, generalized by evidence purity.
2. **The dashboard contract is no longer frozen.** The prior effort carried a
   provisional "the 3 `PREDICTION_*` columns stay frozen" constraint. The verdict
   record decision supersedes it: the three columns keep their names, types, and
   ranges but change semantics (`NULL` = no active call), and **additive** columns
   (rendered claim, reasoning, what-changed, evaluated-at) join them. This change is
   deliberate, not an oversight.
3. **The old ledger freezes.** `FCT_TREND_PREDICTION_LEDGER` takes no new writes;
   the new verdict ledger replaces it. The deterministic scorer workflow retires.
4. **Mechanical residue is minimal by design.** Only the data-quality floor (§5) and
   coverage *detection* (§7.2) stay mechanical. Any new mechanical gate, discount,
   or eviction rule contradicts this strategy and needs a decision, not a commit.
5. **External dependencies are assumptions with owners:**
   - **Exploding Topics API** — saturation evidence and the named external lens;
     commercial access and its terms owned by Martin/product. An ET miss is never a
     penalty.
   - **`MCC_RAW.STORY_DATA` (CUE publish feed + `CUE_CONTENT_VECTORS`)** — coverage
     detection substrate, owned by the data platform; near-real-time freshness
     assumed.
   - **Insights Postgres `prediction_decisions`** — the strategist Approve/Dismiss
     label tier, owned by the Insights Agent side.
   - **CMS trend_id lineage is dropped as a dependency.** Attribution is
     embedding-based and CMS-independent. Id lineage survives only as an optional
     future strengthening for analytics-level joins, owned by the Insights/CMS side
     if ever wanted.
6. **v1 scope exclusions:** white-space surfacing to strategists, distillation-tier
   hints (activation-gated, §8), prediction cards, verdict rollout to other agents.

## 11. Sources

- Wayfinder map: [CRMA-481 — Prediction Pillar Strategy](https://mcclatchy.atlassian.net/browse/CRMA-481) (map file: `docs/wayfinder/prediction-pillar-strategy.md`)
- Decision tickets: [CRMA-482](https://mcclatchy.atlassian.net/browse/CRMA-482) (pillar boundary), [CRMA-485](https://mcclatchy.atlassian.net/browse/CRMA-485) (scoring philosophy), [CRMA-486](https://mcclatchy.atlassian.net/browse/CRMA-486) (verdict record), [CRMA-487](https://mcclatchy.atlassian.net/browse/CRMA-487) (feedback loop), [CRMA-498](https://mcclatchy.atlassian.net/browse/CRMA-498) (white-space seeding); [CRMA-488](https://mcclatchy.atlassian.net/browse/CRMA-488) closed out-of-scope (cards)
- Research: `docs/research/2026-08-08-coverage-signal-availability.md` ([CRMA-484](https://mcclatchy.atlassian.net/browse/CRMA-484)), `docs/research/2026-08-08-saturation-penalizing-engines.md` ([CRMA-483](https://mcclatchy.atlassian.net/browse/CRMA-483))
- [ATLAS – Prediction Scoring Polish meeting notes, 2026-08-07](https://docs.google.com/document/d/1Pf32tNS3Omt2gm13U0YKoy58OTOj-9a2XR3fJjuP8UQ/edit) (Jason Smith + Martin Mena)
- ["Trends vs. Predictions" — Trend Hunter / ATLAS methodology doc](https://docs.google.com/document/d/1noBCUR4W-cS-fmbMRLNV2cpHMBc2VA5VfPIdeYSyYqk/edit?tab=t.395xtj66s4jp) (received 2026-08-20)
- Current implementation grounding: `docs/prediction-contract.md`, `docs/prediction-flow.md`; measured v2 baseline carried from CRMA-428 (closed 2026-08-18, superseded by CRMA-481)
