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
  On 2026-10-06 all 19 were `STABLE` at 15 to 39 days old. On 2026-10-26, after
  attribution reached them, 9 of the 20 rescues have linked signals and some are
  `GROWING` or `DECLINING`; 11 still have none.
  _Source: CRMA-1427 findings, `lifecycle-subagent-p_gYC562o` prompt version 7 and
  Snowflake, 2026-10-06; re-measured 2026-10-26 (CRMA-1639)._
- **The enrichment chain completes for a trend with no linked signals.** All 19 have a full
  `initial` enrichment record, written 2 to 3 minutes after promotion, with 3 to 6 evidence
  items. Every step that reads `FCT_TREND_SIGNALS` proceeds on an empty result.
  _Source: CRMA-1427 findings, code read and Snowflake, 2026-10-06._
- **The lifecycle-attribution agent reaches every live trend about every 18 hours.** A
  trend is eligible as soon as it has a `TREND_VECTOR`. Since CRMA-1459 (2026-10-16) each
  hourly run sweeps one block of 30 trends in hash order, over 541 eligible trends.
  October trends got their first `attributed` link after a median of 39 hours, and 42 of
  60 have one. This replaces an earlier line that read "does not reach a new trend": that
  was starvation in the old sweep order, which CRMA-1459 fixed.
  _Source: `lifecycle-attribution-agent-p_KwCoaap/workflow.yaml` on `production`,
  Snowflake, 2026-10-26 (CRMA-1639)._
- **Most live trends are `STABLE` with little evidence.** 490 of 644 trends are `STABLE`,
  with a median of 1 linked signal in 14 days. 389 of them are under the 5-signal floor
  that `STABLE` → `DECLINING` needs.
  _Source: Snowflake, 2026-10-26 (CRMA-1639)._
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
- **Ingesting an editorial trend guarantees a trend on ATLAS.** No judgment rejects it. The
  promotion gate and the promotion agent's verdict do not stand between a valid request and
  a trend. ([CRMA-1425](https://mcclatchy.atlassian.net/browse/CRMA-1425), 2026-10-26.)
- **A request carries one or more URLs, and each URL becomes a linked signal.** Each URL
  enters as a normal signal row with a link in `FCT_TREND_SIGNALS`, after the dead-URL
  check from discovery's `canonicalize_and_validate`. Only a provably dead or malformed URL
  drops; a 401, 403, 429, 5xx or timeout passes with `unverified: true`. Discovery's
  freshness and title-relevance filters do not apply. A request with no URL, or with every
  URL dropped, fails as invalid input. That failure is validation, not a judgment of the
  trend. (CRMA-1425, 2026-10-26.)
- **A duplicate returns the matching live trend, never a second row.** The person's URL
  attaches to that trend as a new linked signal. (CRMA-1425, 2026-10-26.)
- **A search never links its rows straight back to the claim that prompted it.** This
  holds whoever authored the claim. A row an agent search tool finds for an editorial
  trend may enter `FCT_SIGNALS`, but it links to the trend only through attribution. Only
  the person's own URLs link at ingest. The evidence purity entry in `CONTEXT.md`
  carries the rule.
  ([CRMA-1426](https://mcclatchy.atlassian.net/browse/CRMA-1426), 2026-10-26.)
- **No scout agent.** Enrichment's existing tool loop gives an editorial trend its first
  context. The spec adds no new agent to search for evidence. (CRMA-1426, 2026-10-26.)
- **An editorial trend enters as a candidate that the endpoint promotes itself.** The
  endpoint merges the URLs through `MERGE_EXTERNAL_SIGNALS` with its own
  `AGENT_SESSION_ID`, inserts a `STG_TREND_CANDIDATES` row with `VERDICT` NULL and the
  same session ID, and calls `PROC_PROMOTION_APPLY`: `PROMOTE_NEW` plus a dispatcher POST
  for a new trend, `MERGE_INTO_EXISTING` and no dispatch for a duplicate.
  `PROC_PROMOTION_APPLY` stays the only writer of `FCT_TRENDS`. If the promotion call
  fails, the endpoint returns an error and leaves the inert candidate in place.
  ([ADR-0011](../adr/0011-editorial-trend-enters-as-a-self-promoted-candidate.md),
  [CRMA-1429](https://mcclatchy.atlassian.net/browse/CRMA-1429), 2026-10-26.)
- **The promotion ledger records the origin.** The endpoint calls `PROC_PROMOTION_APPLY`
  with `decision_category` `EDITORIAL`, for `PROMOTE_NEW` and `MERGE_INTO_EXISTING`
  alike. A trend's origin is the category on its `PROMOTE_NEW` row, so a nomination that
  merges into a discovered trend leaves that trend discovered. A new nullable
  `FCT_PROMOTION_LEDGER.NOMINATION` VARIANT holds `{nominated_by, brief}`, with the
  person's text verbatim. The time is `DECIDED_AT`. The proc's `log_audit` must write the
  column. Nothing goes on `FCT_TRENDS`. The dashboard does not join `STG_TREND_CANDIDATES`.
  ([CRMA-1430](https://mcclatchy.atlassian.net/browse/CRMA-1430), 2026-10-26.)
- **`DT_TREND_DASHBOARD` exposes `TREND_ORIGIN` (`DISCOVERED` | `EDITORIAL`) and nothing
  else about the nomination.** `nominated_by` and `brief` stay off the dashboard. The
  spec changes `docs/dashboard/data-contract.md` and its ATLAS Confluence mirror.
  (CRMA-1430, 2026-10-26.)
- **No scorer reads the origin.** `HEAT_INDEX`, `PREDICTION_SCORE` and the opportunity
  score treat an editorial trend like any trend. The endpoint writes the candidate's
  `CONFIDENCE` and `SPECIFICITY_SCORE` as NULL, and the heat formula falls back to 0.5.
  The audit agent adds a count of `EDITORIAL` promotions next to `q_et_rescue`.
  (CRMA-1430, 2026-10-26.)
- **The endpoint is its own Cloud Run service under `services/`.** It is deployed by
  `services/deploy.sh` in `mcc-crm-automations` / `us-east4`, and it is not a route on
  `trend-tree-ecomm-agent` or the prediction service. It serves an accept route, a
  task-handler route, and `/health` (amended by CRMA-1432). ([CRMA-1431](https://mcclatchy.atlassian.net/browse/CRMA-1431), 2026-10-26.)
- **ATLAS calls with a static API key, not a Google ID token.** The service binds
  `allUsers` to `roles/run.invoker` (the `harbor-api` pattern) and rejects a missing or
  wrong `X-Api-Key` header with 401, compared in constant time, before any work. A new
  `deploy.env` switch (`PUBLIC_INGRESS=true`), set by this service only, makes
  `deploy.sh` pass `--allow-unauthenticated`. (CRMA-1431, 2026-10-26.)
- **One key, and only prod ATLAS holds it.** The key lives in Secret Manager in
  `mcc-crm-automations`, and ATLAS prod (`insights-agent-504817`) keeps a copy. Dev ATLAS
  gets no key. Rotation is a manual swap coordinated with the ATLAS team; the service
  accepts one key at a time. (CRMA-1431, 2026-10-26.)
- **The endpoint trusts the `nominated_by` that ATLAS sends.** The key proves the caller is
  ATLAS, not which person nominated. The ledger stores the value as ATLAS's claim.
  (CRMA-1431, 2026-10-26.)
- **An LLM judges whether an editorial trend duplicates a trend, and it judges sameness
  only.** One Gemini 3.8 call, with no tools, reads promotion's neighbor pool: the
  `q_compute_vectors_and_neighbors` embedding recipe, cosine ≥ 0.50 against the latest
  `TREND_VECTOR` on `FCT_TREND_ENRICHMENT_LEDGER`, top 8. It returns `match: <trend_id>`
  or `no match`, with a rationale. It has no `REJECT` or `DEFER`. The `trend_id` must come
  from the pool. An empty pool skips the call and promotes a new trend. The prompt is a new
  `DIM_LLM_PROMPT` key, with its migration and audit-manifest entry. The build confirms the
  exact model ID. ([CRMA-1638](https://mcclatchy.atlassian.net/browse/CRMA-1638),
  2026-10-26.)
- **No URL match, and no match against open candidates.** A URL is evidence, not identity.
  Promotion later merges an open candidate into the editorial trend if the two are the same.
  (CRMA-1638, 2026-10-26.)
- **A `RETIRED` trend can match, and the match revives it.** The lifecycle sweep skips
  `RETIRED` trends, so the endpoint writes a `RESURGENT` row to
  `FCT_TREND_LIFECYCLE_LEDGER`. The endpoint is the second writer of that ledger.
  (CRMA-1638, 2026-10-26.)
- **The judgment runs before any write, and a failed judgment is retried.** A failure,
  a timeout, or a `trend_id` outside the pool never falls back to `PROMOTE_NEW`. Cloud
  Tasks retries the task handler (CRMA-1432). Both `EDITORIAL`
  ledger rows carry `max_neighbor_sim`, `considered_neighbors` and the judge's rationale.
  (CRMA-1638, 2026-10-26.)
- **The lifecycle agent does not read the origin.** An editorial trend gets the same
  rubric as any trend, with no exit rule of its own. It gains evidence only through the
  normal attribution sweep, with no priority, so its first `attributed` link can take
  about 18 hours. The spec changes neither the lifecycle agent nor the attribution agent.
  ([CRMA-1639](https://mcclatchy.atlassian.net/browse/CRMA-1639), 2026-10-26.)
- **The endpoint has no rate limit and no budget.** It has no limit per caller and no
  daily cap. The service's `deploy.env` sets `MAX_INSTANCES=2` and keeps the default
  concurrency, so Cloud Run refuses overflow with its own 429. The spec adds no code for
  it. ([CRMA-1640](https://mcclatchy.atlassian.net/browse/CRMA-1640), 2026-10-26.)
- **The endpoint is asynchronous, and ATLAS never waits for the outcome.** The accept route
  checks `X-Api-Key`, validates the body, runs the dead-URL check, enqueues one Cloud Tasks
  task named by `nomination_id`, and returns `202 {nomination_id}` with any dropped URLs.
  The editorial trend shows up in the list later. The endpoint has no status route.
  ([CRMA-1432](https://mcclatchy.atlassian.net/browse/CRMA-1432), 2026-10-26.)
- **The request carries four required fields: `nomination_id`, `brief`, `urls` (1 to 10),
  `nominated_by`.** `brief` is the person's free-text description of the trend, not a
  name. It has no cap of its own; the service caps the body at 64 KB. The request has no
  `rationale`, no `category` and no `dry_run`. The contract has no test path: the ATLAS
  team stubs the endpoint against the contract. (CRMA-1432, 2026-10-26.)
- **`nomination_id` is the idempotency key and the candidate's ID.** ATLAS generates it
  once per form submission. Cloud Tasks refuses a second task with the same name, and the
  candidate row keyed on it guards after that window. A task that finds its candidate
  without a ledger row resumes at `PROC_PROMOTION_APPLY`. A reused key with different
  content gets 202, and the first content wins. A second person who nominates the same
  trend inside the 2-to-3-minute vector window can still create a second trend; that gap
  is accepted. (CRMA-1432, 2026-10-26.)
- **The task handler runs the work and Cloud Tasks owns the retry.** The task handler runs
  the sameness judgment, `MERGE_EXTERNAL_SIGNALS`, the candidate insert and
  `PROC_PROMOTION_APPLY`, and returns non-2xx on any failure so Cloud Tasks retries with
  backoff. It accepts only a Google OIDC token from the queue's service account
  (`google_oidc_verifier` in `services/lib/tt_services_lib`). It has no retry loop of its
  own. (CRMA-1432, 2026-10-26.)
- **The contract has five statuses.** `202` accepted (a repeat also gets 202); `400`
  malformed body; `401` missing or wrong key; `422 {urls: [{url, reason}]}` when every URL
  drops; `429` (Cloud Run overflow) or `503` (enqueue failed, nothing written), which ATLAS
  retries with the same `nomination_id`. (CRMA-1432, 2026-10-26.)
- **The audit agent counts editorial candidates with no promotion-ledger row older than one
  hour.** That count catches a task that exhausted its retries and the inert candidate from
  ADR-0011. The contract adds no dead-letter queue and no callback to ATLAS.
  (CRMA-1432, 2026-10-26.)
- **An editorial trend may resolve a white-space prediction.** The matcher treats it like
  any trend and does not read the origin. The spec changes nothing in the prediction
  service. ([CRMA-1643](https://mcclatchy.atlassian.net/browse/CRMA-1643), 2026-10-26.)
- **The track record reports hits on editorial trends as a separate group, derived at read
  time.** It follows `MATCHED_TREND_ID` to the trend's `PROMOTE_NEW` row and reads its
  `DECISION_CATEGORY`. The verdict ledger stores nothing new. The group never changes,
  even after the trend gains `attributed` links. The spec adds this rule to §7.6 of
  `docs/prediction-pillar-strategy.md`, beside the hint segmentation of §8.
  (CRMA-1643, 2026-10-26.)
- **The enrichment agent names an editorial trend.** The endpoint never writes a trend
  name; the name freezes at first enrichment (ADR-0001).
  ([CRMA-1658](https://mcclatchy.atlassian.net/browse/CRMA-1658), 2026-10-26.)
- **The brief goes verbatim into the candidate's `REASONING`, and enrichment does not read
  the brief.** The duplicate judgment's embedding reads the first 800 characters of
  `REASONING`. Enrichment reads the topic and the linked signals, as for any trend, and
  does not change. (CRMA-1658, 2026-10-26.)
- **A tool-free Gemini call writes the trend topic.** It writes at most 200 characters, in
  the register of distillation's topics, from the brief and the URL titles. It runs in the
  task handler before the duplicate judgment, because the judgment embeds the topic. A
  failure returns non-2xx and Cloud Tasks retries it. The prompt is a new
  `DIM_LLM_PROMPT` key, with its migration and audit-manifest entry. (CRMA-1658,
  2026-10-26.)

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

- [Decide: what ingesting an editorial trend guarantees](https://mcclatchy.atlassian.net/browse/CRMA-1425) — **Decided:** Ingesting guarantees a trend on ATLAS: no judgment rejects it, the person supplies one or more URLs that become linked signals, and a duplicate returns the matching live trend

- [Decide: whether the pipeline may search for evidence for an editorial trend](https://mcclatchy.atlassian.net/browse/CRMA-1426) — **Decided:** A search may add rows for an editorial trend, but they link to it only through attribution, whoever authored the claim; the person's own URLs are the one direct door; no scout agent and no ADR

- [Decide: where an editorial trend enters the pipeline](https://mcclatchy.atlassian.net/browse/CRMA-1429) — **Decided:** An editorial trend enters as a candidate with no verdict that the endpoint promotes itself through PROC_PROMOTION_APPLY (PROMOTE_NEW, or MERGE_INTO_EXISTING for a duplicate); ADR-0011

- [Decide: how an editorial trend stays distinguishable from a discovered trend](https://mcclatchy.atlassian.net/browse/CRMA-1430) — **Decided:** The promotion ledger records the origin (DECISION_CATEGORY EDITORIAL plus a NOMINATION column); the dashboard exposes only TREND_ORIGIN; no scorer reads the origin

- [Decide: where the endpoint runs and who may call it](https://mcclatchy.atlassian.net/browse/CRMA-1431) — **Decided:** The endpoint is its own Cloud Run service; ATLAS prod calls it with a static X-Api-Key (allUsers ingress, key checked in the app); dev ATLAS gets no key; nominated_by is trusted

- [Decide: how the endpoint detects that an editorial trend duplicates a live trend](https://mcclatchy.atlassian.net/browse/CRMA-1638) — **Decided:** Gemini 3.8 judges sameness only (match or no match) over promotion's neighbor pool; no URL match; open candidates ignored; a RETIRED match revives the trend; a failed judgment is retried, never falls back to a new trend

- [Decide: how an editorial trend gains evidence and leaves STABLE](https://mcclatchy.atlassian.net/browse/CRMA-1639) — **Decided:** No exit rule and no attribution priority for an editorial trend; the lifecycle agent does not read the origin; since CRMA-1459 attribution reaches every trend about every 18 hours; the low-evidence STABLE gap is out of scope (CRMA-1655)

- [Decide: whether the endpoint needs a rate limit or a budget](https://mcclatchy.atlassian.net/browse/CRMA-1640) — **Decided:** No rate limit and no daily cap; deploy.env sets MAX_INSTANCES=2 so Cloud Run refuses overflow with its own 429; the vector-window double-promote on retry goes to CRMA-1432

- [Decide: the request and response contract for the endpoint](https://mcclatchy.atlassian.net/browse/CRMA-1432) — **Decided:** Asynchronous: ATLAS sends nomination_id, brief, urls and nominated_by, gets 202 after the key, body and dead-URL checks, and a Cloud Tasks task named by nomination_id does the work; no status route, no dry_run

- [Decide: whether an editorial trend may resolve a white-space prediction](https://mcclatchy.atlassian.net/browse/CRMA-1643) — **Decided:** An editorial trend may resolve a white-space prediction; the matcher does not read the origin; the track record reports those hits as a separate group, derived from the PROMOTE_NEW row, that never changes

- [Decide: who writes the trend topic and the trend name for an editorial trend](https://mcclatchy.atlassian.net/browse/CRMA-1658) — **Decided:** The enrichment agent names the trend; a tool-free Gemini call writes the topic from the brief before the duplicate judgment; the brief goes verbatim into REASONING and enrichment does not read it

## Not yet specified

<!-- The fog of war: in-scope decisions you can tell are coming but cannot yet
     phrase precisely. The test is whether you can state the question NOW — not
     whether you can answer it. Graduates into tickets as the frontier advances. -->


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
- **A low-evidence trend can never leave `STABLE` or retire.** The rubric needs 5 linked
  signals in 14 days for `STABLE` → `DECLINING`, so 389 trends of every origin are stuck.
  It is a lifecycle-rubric gap, not an editorial-trend gap
  ([CRMA-1639](https://mcclatchy.atlassian.net/browse/CRMA-1639)); filed for triage as
  [CRMA-1655](https://mcclatchy.atlassian.net/browse/CRMA-1655).
- **A view of a person's own nominations in ATLAS.** A nomination that matches a
  discovered trend leaves no visible mark, so the person finds it by searching the list.
  A "your nominations" view needs a `nomination_id` → `TREND_ID` link on the dashboard and
  is a later effort ([CRMA-1432](https://mcclatchy.atlassian.net/browse/CRMA-1432)).
