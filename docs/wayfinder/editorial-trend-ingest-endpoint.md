<!-- map: CRMA-1424 -->

# Map: an endpoint to ingest an editorial trend

## Destination

A **spec** for an endpoint that ingests an **editorial trend** into Trend Tree. An
editorial trend is a trend that a strategist or an editor nominates by hand from ATLAS,
instead of a trend that the pipeline discovers from signals. The spec covers the endpoint,
its request and response contract, what an editorial trend becomes in the pipeline, and how
an editorial trend stays distinguishable from a discovered trend.

The map stops before the build. When no decision remains, `/to-spec` writes
`docs/prd/<slug>.md` from the decisions below.

## Notes

- **Domain**: read `CONTEXT.md` before writing about signals, candidates, trends, or
  [evidence purity]. The tracker contract is `docs/agents/issue-tracker.md`.
- **Skills**: `/grilling` + `/domain-modeling` for decision tickets, `/research` for
  research tickets, `pipedream-synced-project` for anything that touches a live workflow.
- **Put each decision as prose with a recommendation and its reasoning.** Give the deciding
  argument first, grounded in a fact from the repo. Do not use multiple-choice cards.
- **"Editorial trend" has a second meaning outside this repo.** The Product Growth Squad
  (Jira `PGS`) uses the phrase for the trend entity that Trend Hunter editors author in the
  Trend Hunter CMS. This map never means that entity. See `CONTEXT.md` → Flagged
  ambiguities.
- **Never commit this map to `production`.** A commit to the default branch is a Pipedream
  deploy of every changed workflow.

## Established facts

<!-- Measured state of the world. Falsified by RE-MEASUREMENT, never by a decision.
     Every line carries its source and the date it was verified. -->

- **Every trend comes from a candidate.** `FCT_TRENDS.CANDIDATE_ID` is `NOT NULL`, and
  `PROC_PROMOTION_APPLY` holds the only production `INSERT INTO FCT_TRENDS`.
  _Source: `sql/fct_trends.sql:18`, `sql/proc_promotion_apply.sql:405`, repo-wide grep,
  2026-10-06 at `354662a`._
- **The promotion gate counts source families from the candidate's `SOURCE_BREAKDOWN`.**
  Two or more families route to the normal path. Fewer than two families route to the
  Exploding Topics rescue when confidence and specificity both reach the threshold.
  Anything else is a reject. A candidate with no signals has zero families, and the gate
  still routes it to the rescue when its scores are high enough.
  _Source: `agents/lib/promotion_gate.mjs:70-100` (`classifyCandidate`), 2026-10-06._
- **The pipeline already holds trends that were promoted with no evidence.** 20 trends came
  from candidates with an empty `SUPPORTING_SIGNAL_IDS` and an empty `SOURCE_BREAKDOWN`, all
  through the Exploding Topics rescue, between 2026-08-28 and 2026-09-21. 19 of them still
  have zero rows in `FCT_TREND_SIGNALS`. ADR-0004 states that distillation enforces at least
  two supporting signals, so these 20 contradict it.
  _Source: [CRMA-1427](https://mcclatchy.atlassian.net/browse/CRMA-1427) findings,
  Snowflake, 2026-10-06; the count of 19 re-measured by the charting session the same day._
- **A trend with no linked signals shows a heat index of 8.4 to 9.6, not zero.** Only the
  confidence term scores: 10 times the candidate's promotion confidence. The recency,
  velocity and breadth terms read linked signals and score 0. Promotion seeds about 33,
  which decays to the floor in about two days. This replaces an earlier line on this map
  that read "zero heat" from one code comment.
  _Source: CRMA-1427 findings, Snowflake (19 trends, median 8.6), 2026-10-06._
- **A trend with no linked signals stays `STABLE` and never retires.** The lifecycle agent
  sets `NEW` for 24 hours, then `STABLE`. The rubric allows `STABLE` → `DECLINING` only with
  at least 5 linked signals in 14 days, and `DORMANT` is reachable only from `DECLINING`.
  All 19 are `STABLE` at 15 to 39 days old.
  _Source: CRMA-1427 findings, `lifecycle-subagent-p_gYC562o` prompt version 7 and
  Snowflake, 2026-10-06._
- **The enrichment chain completes for a trend with no linked signals.** All 19 have a full
  `initial` enrichment record, written 2 to 3 minutes after promotion, with 3 to 6 evidence
  items. Every step that reads `FCT_TREND_SIGNALS` proceeds on an empty result.
  _Source: CRMA-1427 findings, code read and Snowflake, 2026-10-06._
- **The lifecycle-attribution agent does not reach a new trend in practice.** A trend is
  eligible as soon as it has a `TREND_VECTOR`, and promotion writes one from `TREND_TOPIC`.
  But 0 of the 192 trends promoted since 2026-07-20 has an `attributed` link. The reason is
  an inference: the sweep works a queue that is about 11 weeks behind.
  _Source: CRMA-1427 findings, Snowflake, 2026-10-06._
- **A trend with no linked signals is never `PREDICTION_ELIGIBLE`, and shows 0 for
  `DISTINCT_PUBLISHER_COUNT` and `TOTAL_CLUSTER_SIZE`.** No audit query counts such trends.
  _Source: CRMA-1427 findings, 2026-10-06._
- **A system-authored claim already has one permitted door into the pipeline.** Open
  white-space predictions enter the shared cluster-agent's prompt as hints over
  independently ingested signals. They never become rows.
  _Source: [CRMA-498](https://mcclatchy.atlassian.net/browse/CRMA-498),
  `docs/prediction-pillar-strategy.md` §8, 2026-10-06._
- **A Cloud Run service in this repo is not public.** `services/deploy.sh` deploys with
  `--no-allow-unauthenticated`, so a caller needs a `roles/run.invoker` binding.
  _Source: `services/deploy.sh:25-43,278`, 2026-10-06._
- **ATLAS runs in its own GCP projects, not in `mcc-crm-automations`.** The backend is the
  Cloud Run service `insights-agent-backend` in `insights-agent-dev-504817` (dev) and
  `insights-agent-504817` (prod). No stage environment exists. The email of its runtime
  service account is in no source.
  _Source: Confluence "Atlas (insights-agent) — Deployment Runbook" (id `2325315603`,
  2026-09-15), reported in
  [CRMA-1428](https://mcclatchy.atlassian.net/browse/CRMA-1428), 2026-10-06._
- **ATLAS authenticates every outbound service call with a static key in a header.** It
  sends `X-API-Key` to CSA and `X-Api-Key` to Harbor. Harbor is a Cloud Run service in
  `mcc-crm-automations` that binds `allUsers` to `roles/run.invoker` and checks the key in
  the application. No source shows ATLAS sending a Google ID token.
  _Source: CRMA-1428 findings; the `harbor-api` policy re-read with `gcloud` on 2026-10-06._
- **No cross-project `roles/run.invoker` grant exists in `mcc-crm-automations`.** All 12
  services and the project policy were read. `trend-tree-ecomm-agent` admits one service
  account from the same project. No `trend-tree-*` service checks a header key.
  _Source: CRMA-1428 findings, read-only `gcloud`, 2026-10-06._
- **ATLAS reaches Trend Tree only through Snowflake today.** It reads
  `MCC_PRESENTATION.TREND_AGENT` as user `TH_APIUSER` with role `TH_APIROLE`. No ATLAS →
  Trend Tree HTTP call exists.
  _Source: CRMA-749 (2026-08-20), repo grep, reported in CRMA-1428, 2026-10-06._
- **The Pipedream HTTP triggers in this repo are open URLs.** No step checks a caller
  credential, and the internal callers send none.
  _Source: repo code read in CRMA-1428, CRMA-528, 2026-10-06._
- **No request for this endpoint exists in writing.** A search of Slack and of Jira `CRMA`
  on 2026-10-06 found no message or ticket that asks for it. The requirement comes from the
  map's driver directly.

## Standing constraints

<!-- Settled decisions in binding present tense, already rolled up with their
     amendments. Answers "what binds me right now?", which the chronological index
     below cannot. Overturned only by ANOTHER DECISION — that distinction is the
     point: filing a measurement here is how a stale number quietly becomes binding. -->

- **The term is "editorial trend".** It names a trend that a person nominates by hand. It
  does not name the PGS entity in the Trend Hunter CMS. (Charting session, 2026-10-06.)
- **Strategists and editors nominate from ATLAS, and the ATLAS backend (`insights-agent`)
  is the only caller.** No person calls the endpoint directly. (Charting session,
  2026-10-06.)
- **The destination is a spec, not a build.** No ticket on this map deploys the endpoint.
  (Charting session, 2026-10-06.)

## Decisions so far

<!-- The index — one line per closed ticket. Enough to judge relevance, then open
     the link for the detail the ticket already holds. Never the reasoning,
     alternatives, or evidence.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>

     A decision that constrains later work writes that constraint into
     '## Standing constraints' in the same edit — never a per-entry Binds block.

     `resolve` appends here. Do not hand-edit while a session is running. -->

- [Find out how the ATLAS backend can authenticate to a Cloud Run service](https://mcclatchy.atlassian.net/browse/CRMA-1428) — **Decided:** ATLAS runs on Cloud Run in its own GCP projects and authenticates outbound calls with a static header key today; a Google ID token is possible but has no cross-project precedent here

- [Find out what the pipeline does with a trend that has no linked signals](https://mcclatchy.atlassian.net/browse/CRMA-1427) — **Decided:** A trend with no linked signals is a permanent quiet row: heat about 8.6, STABLE and never retired, fully enriched, and not reached by attribution; 19 such live trends exist already through the Exploding Topics rescue

## Not yet specified

<!-- The fog of war: in-scope decisions you can tell are coming but cannot yet
     phrase precisely. The test is whether you can state the question NOW — not
     whether you can answer it. Graduates into tickets as the frontier advances. -->

- **Deduplication.** What happens when an editorial trend matches a live trend or an open
  candidate. The shape of this question depends on where an editorial trend enters the
  pipeline: the promotion agent already merges duplicates for a candidate, and nothing does
  for a direct row.
- **How an editorial trend without evidence gains evidence, or leaves.** The research
  reversed the first form of this question. A trend with no linked signals does not retire
  too early: it stays `STABLE` at a heat of about 8.6 and never retires, and the
  lifecycle-attribution agent does not reach it. So an editorial trend that enters without
  evidence needs its own path to evidence and its own exit rule. Waits on the entry point.
- **Who names the trend.** Whether the person's wording becomes the [trend name], the
  [trend topic], or only an input to enrichment. The [trend name] freezes at first
  enrichment (ADR-0001), so the first writer wins.
- **Interaction with the prediction pillar.** Whether an editorial trend may match a
  [white-space prediction] and resolve it. A person who nominates a predicted trend could
  make the prediction track record look better than it is.
- **What the person learns after a reject.** Whether a rejected or merged editorial trend
  reports its outcome back to ATLAS, and in what form. Waits on the guarantee decision.
- **Cost and volume limits.** Whether the endpoint needs a rate limit or a budget per
  editorial trend. Waits on the entry point, which sets the cost of one request.

## Out of scope

<!-- Work ruled beyond the destination. Closed, never graduates. One line each:
     the gist plus why it is out, linking the closed ticket. -->

- **The nomination form in `insights-agent`.** The form belongs to a different repo and a
  different team. This map specifies only the endpoint that the form calls.
- **Bulk import of many editorial trends.** The endpoint takes one editorial trend per
  request. A bulk path is a separate effort with its own cost and review questions.
- **The PGS link between a Trend Hunter CMS editorial trend and an analytical trend.** That
  is the other meaning of the phrase (PGS-664, PGS-908) and belongs to the Product Growth
  Squad.
