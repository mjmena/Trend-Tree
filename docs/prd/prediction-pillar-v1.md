# Prediction Pillar v1 — verdict-based predictions on GCP

**Strategy source:** `docs/prediction-pillar-strategy.md` (blessed copy: [Trend Tree Prediction Pillar Strategy](https://mcclatchy.atlassian.net/wiki/spaces/ATLAS/pages/2252832769/Trend+Tree+Prediction+Pillar+Strategy), ATLAS space). This spec implements that strategy's §10 constraints; where the two disagree, the strategy doc wins and this spec has a bug.
**Platform decision (Martin, 2026-08-21):** the pillar's home is **GCP** — it is a new Cloud Run service, not a Pipedream workflow, and inherits the fleet-migration platform decisions (map CRMA-429).

## Problem Statement

As a content strategist, the prediction signal I get today is a bare number on
every mature trend, computed by a fixed formula. I cannot see what the system
actually expects to happen, why, or what changed since yesterday — and the
number is not trustworthy: its eligible set is right about 1 call in 4, its
"Emerging" band carries no lift over picking trends at random, and a trend
scores high partly because our own pipeline paid attention to it. When I ask
"how are these decisions getting made," there is no answer to show me. And when
the system is wrong, nothing records it — there is no track record, so the
signal never earns or loses my trust.

## Solution

Replace the deterministic scorer with a **prediction pillar**: a GCP-native
agent that

1. **generates falsifiable predictions** — each a frozen 4-part claim (subject,
   directional claim, horizon, observable check) — from the signal corpus,
   blind to existing trends and heat;
2. **matches** each prediction against current trends: a match corroborates a
   trend and feeds the dashboard; no match is recorded as a **white-space
   prediction** (ledger-only in v1);
3. **appends a verdict** (calibrated confidence + status + evidence + reasoning
   + what-changed) to a new append-only verdict ledger on every evaluation;
4. **projects** the latest active matched verdict into the three retained
   dashboard fields plus new narrative columns, so a strategist reads the
   story, not just the score;
5. **weighs coverage and saturation as evidence** under hard isolation rules —
   internal coverage can only ever demote, and no prediction-derived data ever
   touches trend scoring or the signal corpus;
6. **derives a track record** (Correct / Early–Late / Incorrect) from the
   ledger, never stored, so the pillar's accuracy becomes visible and gradable.

The old prediction ledger freezes as v1/v2 history and the deterministic
Pipedream scorer retires at cutover.

## User Stories

1. As a content strategist, I want each queued trend to show a rendered claim sentence ("what the system thinks happens next, by when"), so that I act on an explicit call instead of interpreting a bare number.
2. As a content strategist, I want the reasoning behind the current verdict visible on the dashboard, so that I can judge whether I believe the call.
3. As a content strategist, I want a "what changed" note on every re-evaluation, so that I can see why confidence moved since I last looked.
4. As a content strategist, I want `PREDICTION_SCORE` to read `NULL` when the system has made no active call about a trend, so that absence of a prediction is honest instead of dressed up as a low score.
5. As a content strategist, I want the Predictions Queue to contain only trends with an active, sufficiently-confident matched prediction, so that the queue is a list of calls, not a percentile cut.
6. As a content strategist, I want a prediction we have already covered internally to drop to a "watch/covered" posture rather than vanish, so that I keep sight of it without being told to act again.
7. As a content strategist, I want a covered prediction to return to "act" when external demand keeps climbing after our stories shipped, so that real momentum is not hidden by our own coverage.
8. As a content strategist, I want my Dismiss action to withdraw the prediction, so that automation never re-surfaces a call I have rejected.
9. As a content strategist, I want my Approve action to protect a prediction from automated demotion until a human touches it again, so that my judgement outranks the machine's.
10. As an insights analyst, I want every prediction to carry a defined horizon band (1–3 / 3–6 / 6–12 / 12–24 months), so that I know when a call is due to be judged.
11. As an insights analyst, I want predictions graded Correct / Early–Late / Incorrect from the ledger, so that the pillar builds a visible track record I can hold it to.
12. As an insights analyst, I want an expired prediction re-checked for one extra horizon length before its grade freezes, so that a late-arriving truth reads Early–Late instead of silently wrong.
13. As an insights analyst, I want withdrawn predictions excluded from the track record, so that human-rejected calls don't pollute the accuracy measure.
14. As a member of the content team, I want the evidence behind every verdict retained in the ledger, so that "how are these decisions getting made" has a concrete, auditable answer.
15. As a member of the content team, I want internal coverage to be structurally unable to raise a prediction's confidence, so that we never report a trend is real because we wrote about it ourselves.
16. As an Insights Agent backend engineer, I want the three existing `PREDICTION_*` dashboard columns to keep their names, types, and ranges, so that my consumers keep working through the semantics change.
17. As an Insights Agent backend engineer, I want the new narrative columns to be additive on the existing dashboard view, so that adoption is opt-in and nothing breaks on day one.
18. As an Insights Agent backend engineer, I want an updated data contract documenting the new column semantics (including the new `NULL` meaning), so that I can migrate consumers deliberately.
19. As a data analyst, I want the old prediction ledger frozen rather than dropped, so that historical v1/v2 scores stay queryable and clearly fenced from verdict-era rows.
20. As a data analyst, I want one ledger row per (prediction, evaluation) with the claim frozen at mint, so that I can reconstruct the full history of any call and trust that the claim never moved under it.
21. As a data analyst, I want filterable facts (status, confidence, horizon, matched trend) as real columns and contextual evidence as contracted JSON, so that common queries stay simple and evidence stays complete.
22. As the pipeline operator, I want the prediction agent to run as a Cloud Run service with the fleet's local iteration loop (fixtures, debugger, unit-testable prompt builders), so that I can iterate on generation quality without commit-to-deploy round-trips.
23. As the pipeline operator, I want the service fired by Cloud Scheduler on a daily cadence and manually via authenticated HTTP, so that routine runs are hands-off and test runs are one command.
24. As the pipeline operator, I want a single-trend / capped-scope run mode, so that a test run is cheap and doesn't re-evaluate the world.
25. As the pipeline operator, I want the run to fail loudly into the audit agent's view (ledger freshness), so that a silent dead scheduler cannot read as health.
26. As the pipeline operator, I want the deterministic scorer's workflow, cron, and audit-registry entry retired at cutover, so that two systems never write competing prediction state.
27. As the pipeline operator, I want generation to be structurally blind to `FCT_TRENDS`, heat, and lifecycle, so that the self-fulfilling-prophecy failure mode is impossible by construction, not by prompt discipline.
28. As a strategist reading ATLAS, I want prediction records kept separate from the opportunity axis's "white space" reading, so that "no trend yet" and "no coverage yet" never get conflated.
29. As the maintainer of the strategy, I want strategist Approve/Dismiss decisions retained as a calibration label tier, so that a later effort can tune confidence calibration against human judgement without live-training on it.
30. As a Trend Hunter stakeholder, I want the pillar's outputs to carry the methodology's vocabulary (claims, horizons, Correct / Early–Late / Incorrect), so that the system's record reads in the terms we agreed on.

## Implementation Decisions

**Platform & deployment (inherited from the fleet-migration map, CRMA-429):**

- A new Cloud Run **service** in the shared `mcc-crm-automations` project
  (`us-east4`), named with the `trend-tree-` prefix, built from its own
  Dockerfile, deployed with the fleet's scripted flow: git-SHA-tagged image →
  Artifact Registry → dark deploy (`--no-traffic`, `candidate` tag) → smoke
  test → traffic promote. Scale-to-zero; request timeout raised above the
  default at deploy.
- Code lives in the repo's `services/` namespace (the fleet's code-home
  decision), sharing the `services/lib` modules — notably the retrying
  Snowflake client. The service owns its writes.
- **Ingress is authenticated-only** (no public endpoint). Callers present a
  Google OIDC ID token. **Cloud Scheduler** (granted 2026-08-20) fires the
  daily run via OIDC; the same authenticated HTTP endpoint serves manual and
  test fires. One `run.invoker` binding per caller identity, each deliberate.
- **This is a greenfield GCP agent, not a migration** — there is no Pipedream
  caller, so the transition-phase crash-reporting pattern (dispatcher raises)
  does not apply. Failure visibility is the three-layer posture minus the
  caller layer: deploy-time smoke test (broken at rest) + Snowflake outcome
  freshness read by the audit agent (outcome). The audit agent gains a
  freshness area over the new verdict ledger; GCP-native alerting is
  unavailable (alert-policy creation denied in the shared project) and is not
  assumed.
- LLM: the fleet-standard Gemini path validated by the local-loop prototype
  (single-key, in-process tools). Generation quality iterates through the
  local loop: fixture-driven runs, extracted prompt builders under unit test.

**The run (three phases, one service):**

- **Generate.** The agent reads the signal corpus (`FCT_SIGNALS`) only —
  structurally blind to `FCT_TRENDS`, heat, and lifecycle during generation.
  It emits candidate predictions, each a 4-part claim: atomic subject in
  descriptor vocabulary (ADR-0003), directional claim, horizon band, observable
  check. Topics without a claim are never emitted. The five emergence paths
  (convergence, high-potential single signal, cross-category transfer,
  structural-enabling change, pattern break) frame the generation prompt;
  convergence multiplies confidence and never gates eligibility.
- **Match.** Each open prediction is compared against current trends via the
  descriptor vocabulary and embeddings. Match → `MATCHED_TREND_ID` set,
  the verdict corroborates that trend. No match → white-space prediction
  (`MATCHED_TREND_ID` NULL), ledger-only in v1.
- **Verdict.** Every evaluation appends one row per prediction: calibrated
  `CONFIDENCE`, `PREDICTION_STATUS` (`ACTIVE` / `RESOLVED_TRUE` /
  `RESOLVED_FALSE` / `EXPIRED` / `WITHDRAWN`), contracted `EVIDENCE`,
  `REASONING`, `WHAT_CHANGED`. Confidence-direction (strengthened/weakened) is
  always derived from the prior row, never stored. The daily sweep re-evaluates
  all `ACTIVE` predictions and runs a generation pass; a capped-scope /
  single-prediction mode exists for testing.

**The verdict ledger (schema decisions from CRMA-486):**

- New append-only table `FCT_PREDICTION_VERDICT_LEDGER`, agent-owned, keyed by
  (`PREDICTION_ID`, evaluation id). `PREDICTION_ID` is minted at first
  emission; the four claim columns (`SUBJECT_DESCRIPTOR`, `DIRECTIONAL_CLAIM`,
  `HORIZON_AT`, `OBSERVABLE_CHECK`) are NOT NULL and frozen at mint —
  falsifiability is a schema constraint. `HORIZON_AT` is a real timestamp
  derived from the horizon band at mint; the band itself is controlled
  vocabulary (near term 1–3 mo / emerging 3–6 / cultural shift 6–12 / longer
  range 12–24).
- `EVIDENCE` is one VARIANT with documented required keys: `source_signals`
  (the signal ids behind the call), `saturation` (Exploding Topics
  classification via `descriptor.query` + GDELT article breadth),
  `trend_context` (heat / acceleration / cumulative growth / age; NULL for
  white-space), `coverage` (the internal-coverage detections), `strategist`
  (CRMA-768 — the latest Approve/Dismiss on this prediction, the queue
  posture it settled on, and which rung of the precedence ladder settled it;
  present on every row, so "we asked and nobody had acted" and "the decision
  source was unreachable" are distinguishable). Rule: filterable facts are
  columns; readable context is JSON.
- The existing `FCT_TREND_PREDICTION_LEDGER` freezes — no new writes;
  `COMPUTATION_VERSION` fences the eras. The deterministic scorer's Pipedream
  workflow is deactivated at cutover, its daily cron deleted, and its
  audit-registry entry removed in the same change so its silence cannot read
  as health.

**Dashboard projection:**

- The dashboard dynamic table re-points the three retained columns to the
  latest **active matched** verdict per trend: `PREDICTION_SCORE` = calibrated
  confidence, `PREDICTION_FLAG` = its banding, `PREDICTION_ELIGIBLE` = "has an
  active queued prediction." A trend with no active matched prediction reads
  `NULL` — names, types, and ranges unchanged; semantics deliberately changed
  (the strategy's coverage → integrity trade).
- Additive columns from the same verdict: the rendered claim sentence (four
  claim parts composed in the projection SQL), `REASONING`, `WHAT_CHANGED`,
  evaluated-at, plus `ANGLE` and `AUDIENCE_QUESTION` (CRMA-782 — the
  reader-facing half the machine-facing claim has no room for; both nullable,
  so the card must degrade gracefully when either is absent). Evidence JSON
  stays ledger-only, with one narrow exception: `EVIDENCE:source_signals`
  projects as cited examples, so a card can lead with what is already true
  before it states the claim. White-space predictions reach no strategist
  surface in v1.
- The data-contract doc and its Confluence mirror update in the same change,
  including the new `NULL` semantics and the additive columns.

**Coverage, saturation, and the feedback loop (stances from CRMA-487):**

- Coverage **detection** is mechanical SQL: prediction subject text embedded at
  768 dims via Cortex, cosine-matched against the CMS story-embedding table
  (`CUE_CONTENT_VECTORS`), inclusive definition (commerce + wire + staff),
  syndicated duplicates counted once. Similarity threshold and dedupe rule are
  tuned at implementation. Detection results land only in `EVIDENCE.coverage`.
- Coverage **consumption** is verdict-side only. The one-way valve: internal
  coverage may only demote (act → watch/covered); it never raises confidence or
  corroborates. External demand may re-raise a covered prediction. External
  saturation is the only queue-remover, always via a verdict; exit is never a
  separate mechanical rule.
- Human tier precedence: strategist action > coverage demotion > automated
  evidence. Dismiss → the agent records `WITHDRAWN`; Approve → protection from
  automated demotion until the next human touch. What an Approve protects is
  *queue posture*, not the call's truth — an approved prediction still expires
  on its horizon and still resolves on its observable check. Strategist
  decisions (Insights Postgres `prediction_decisions`) are read as inputs and
  retained as a calibration label tier in its own append-only table,
  `FCT_PREDICTION_STRATEGIST_LABELS` (CRMA-768) — write-only at runtime, read
  by an offline tuning pass later, never live-trained.
- The **only mechanical gate** anywhere in the pillar is the data-quality
  floor: no verdict is requested on trends/subjects too young or sparse to
  judge. Any new mechanical gate, discount, or eviction rule contradicts the
  strategy and requires a decision, not a commit.
- Track-record grades (Correct / Early–Late / Incorrect) are **derived in
  SQL** from latest status + resolving timestamp + mint date + horizon band,
  never stored. `EXPIRED` is re-checked for one additional horizon length,
  then the grade freezes.

**Isolation invariants (enforced structurally):**

- Prediction outputs never influence `HEAT_INDEX`, `LIFECYCLE_STATUS`, or any
  other scoring path.
- **Evidence purity** (CONTEXT.md): no prediction-derived or coverage-derived
  row ever enters `STG_EXTERNAL_SIGNALS` or `FCT_SIGNALS`; system-authored
  content informs agents as context only.
- Generation-phase blindness to trend/heat tables is a code-structure
  guarantee (the generation module has no trend-table access), not a prompt
  instruction.

## Testing Decisions

A good test asserts **external behavior at the seams** — rows landed, columns
read, statuses transitioned — never prompt content or internal call order. The
repo's standing convention applies: "it worked" means rows landed in the target
table, verified by query, not by reading an HTTP response.

Three seams, all pre-existing patterns:

1. **Primary: the service's authenticated HTTP trigger → verdict-ledger rows.**
   Fire a capped-scope run; assert the ledger enforces the claim schema (the
   four NOT NULL columns reject an incomplete claim), the status enum holds,
   `EVIDENCE` carries its required keys, and a re-evaluation appends a row
   without mutating the minted claim. This one seam carries generation,
   matching, verdicting, and the isolation guarantees (assert no writes to
   signal or trend tables occurred).
2. **Projection: the dashboard dynamic table.** SQL assertions that the three
   retained columns read from the latest active matched verdict (`NULL` when
   none), and the additive narrative columns render — including the composed
   claim sentence.
3. **Coverage detection: plain SQL.** The Cortex embedding match is
   deterministic; test it directly against known published stories before it
   feeds any verdict.

Below the seams, the local-loop pattern from the fleet prototype applies:
extracted prompt builders and the grading/projection SQL get fast unit tests;
fixture-driven local runs exercise the agent loop without deploys. Prior art:
the enrichment testing recipe (fire HTTP, query the ledger), the dark-deploy
smoke test in the fleet's deploy flow, and the local-enrichment-loop prototype.

## Out of Scope

- **Surfacing white-space predictions to strategists** — ledger-only in v1;
  surfacing is a deliberate later step after the first resolution cycle.
- **Distillation-tier hints** (white-space predictions as cluster-agent
  context) — activation-gated named extension; not v1.
- **Prediction cards** — nomination queue UX, curation flow, card rubric; the
  pillar's deliverable ends at prediction records.
- **Verdict-envelope rollout to the other agents** (lifecycle / promotion /
  attribution) — prove the pattern here first.
- **ATLAS UI changes** beyond the retained numbers and the additive columns.
- **Migrating any existing agent to GCP** — that is the fleet-migration
  effort's scope; this service only inherits its platform decisions.
- **External lenses as generation inputs** (e.g. Exploding Topics as a signal
  source) — named extension; v1 generates from the signal corpus only.
- **Confidence-calibration tuning** against the strategist label tier — the
  labels are collected in v1, tuned later.

## Further Notes

- **External dependencies are assumptions with owners:** Exploding Topics API
  access (Martin/product; a miss is never a penalty), the CMS publish feed +
  story embeddings (`MCC_RAW.STORY_DATA`, data platform; near-real-time
  freshness assumed), Insights Postgres `prediction_decisions` (Insights Agent
  side). CMS trend_id lineage is **dropped** as a dependency — coverage
  attribution is embedding-based and CMS-independent.
- **Admin asks, batched once:** the Cloud Scheduler job's OIDC identity and the
  service's `run.invoker` bindings are the only new IAM needs; request the
  minimum per the standing access-request policy.
- **Cutover sequencing:** the new ledger and service can run in shadow
  (writing verdicts, dashboard unchanged) before the projection re-point and
  scorer retirement land — the projection change is the single visible
  cutover moment and is reviewed with the data-contract update.
- The strategy doc's blessing (Jason / Marcelo / Josh) is pending; if review
  changes the strategy, this spec revises before implementation starts.
