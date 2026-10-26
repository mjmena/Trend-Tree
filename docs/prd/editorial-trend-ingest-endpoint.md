<!-- prd: editorial-trend-ingest-endpoint · epic: see JIRA remote link · map: CRMA-1424 -->

# PRD: an endpoint to ingest an editorial trend

Produced 2026-10-26 from wayfinder map [CRMA-1424](https://mcclatchy.atlassian.net/browse/CRMA-1424)
(`docs/wayfinder/editorial-trend-ingest-endpoint.md`). Every decision below was settled on that
map's tickets; this document assembles them into one buildable spec. The terms editorial trend,
candidate, trend, [evidence purity], [white-space prediction], [heat index], [lifecycle status]
and [prediction score] are used exactly as `CONTEXT.md` defines them. ADR-0011 fixes where an
editorial trend enters the pipeline.

"Editorial trend" here never means the Product Growth Squad's trend entity in the Trend Hunter
CMS. See `CONTEXT.md` → Flagged ambiguities.

## Problem Statement

Strategists and editors see trends in the world before Trend Tree promotes them. Today they
have no way to put such a trend into Trend Tree. ATLAS shows only trends that the pipeline
discovered from signals, and ATLAS reaches Trend Tree only by reading Snowflake. A person who
knows a trend is real must wait until discovery, distillation and promotion find it, and they
may never find it.

## Solution

A strategist or an editor nominates a trend from ATLAS with a short free-text brief and one to
ten URLs that show the trend. The ATLAS backend sends the nomination to a new Trend Tree
endpoint. The endpoint accepts it at once and does the work in the background:

- If the nomination describes a trend that already exists, the person's URLs attach to that
  trend as new evidence. No second trend appears.
- If not, a new trend appears on ATLAS a few minutes later, enriched and named like any other
  trend, and marked `TREND_ORIGIN = 'EDITORIAL'`.

No judgment rejects a valid nomination. A nomination fails only when the request is invalid:
a wrong key, a malformed body, or no URL that resolves.

```text
ATLAS backend --X-Api-Key--> accept route
  check key, validate body, dead-URL check
  enqueue Cloud Tasks task (name = nomination_id)      -> 202 {nomination_id, dropped_urls}
Cloud Tasks --OIDC--> task handler
  Gemini writes the trend topic from the brief
  Gemini judges sameness over promotion's neighbor pool
  MERGE_EXTERNAL_SIGNALS (the person's URLs)
  STG_TREND_CANDIDATES row (VERDICT NULL, REASONING = brief)
  PROC_PROMOTION_APPLY, decision_category EDITORIAL:
    no match       -> PROMOTE_NEW, then dispatcher POST -> enrichment names the trend
    match          -> MERGE_INTO_EXISTING, no dispatch
    RETIRED match  -> MERGE_INTO_EXISTING + a RESURGENT lifecycle row
```

## User Stories

1. As a strategist, I want to nominate a trend from ATLAS, so that a trend I see in the world gets into Trend Tree without waiting for discovery.
2. As an editor, I want to nominate a trend from ATLAS, so that a trend from my beat gets into Trend Tree.
3. As a strategist, I want my nomination to always produce a trend or point to an existing one, so that no hidden judgment discards what I submitted.
4. As a strategist, I want to describe the trend in my own words in a brief, so that I do not have to invent a polished trend name.
5. As a strategist, I want to attach one to ten URLs, so that the trend carries real evidence from the start.
6. As a strategist, I want a URL that is clearly dead or malformed to be dropped, so that the trend does not carry broken evidence.
7. As a strategist, I want a URL that is only blocked or slow (401, 403, 429, 5xx, timeout) to be kept, so that paywalled or rate-limited sources still count.
8. As a strategist, I want to be told which URLs were dropped and why, so that I can fix them.
9. As a strategist, I want a nomination with no usable URL to be refused, so that no trend exists without evidence.
10. As a strategist, I want my nomination of a trend that already exists to add my URLs to that trend, so that ATLAS does not show two copies of one trend.
11. As a strategist, I want a nomination that matches a retired trend to bring that trend back, so that a trend that returns is visible again.
12. As a strategist, I want my new trend to be enriched and named like any other trend, so that it reads the same as discovered trends on ATLAS.
13. As a strategist, I want the trend name to come from the enrichment agent, so that names follow the house register (ADR-0001).
14. As a strategist, I want my trend to gain evidence over time from signals the pipeline finds, so that its heat and lifecycle status reflect the world, not only my URLs.
15. As an ATLAS user, I want to see whether a trend is editorial or discovered, so that I can weigh it accordingly.
16. As an ATLAS user, I want editorial trends scored by the same heat index, prediction score and opportunity score as any trend, so that the scores stay comparable.
17. As the ATLAS backend, I want a quick `202` response, so that the nomination form does not wait minutes for the outcome.
18. As the ATLAS backend, I want to retry a nomination with the same `nomination_id` safely, so that a network failure never creates two trends.
19. As the ATLAS backend, I want a reused `nomination_id` with different content to get `202` and keep the first content, so that retries are always safe.
20. As the ATLAS backend, I want distinct statuses for a malformed body, a wrong key, all URLs dropped, and a temporary failure, so that I know what to retry and what to show the person.
21. As the ATLAS backend, I want `429` and `503` to mean "retry with the same `nomination_id`", so that temporary failures recover without duplicate trends.
22. As the ATLAS backend, I want to send `nominated_by`, so that the record shows who nominated the trend.
23. As an ATLAS developer, I want a written request and response contract, so that I can stub the endpoint and build the form without a test environment.
24. As a Trend Tree operator, I want the endpoint to accept only callers with the shared key, so that nobody else can create trends.
25. As a Trend Tree operator, I want only prod ATLAS to hold the key, so that dev ATLAS cannot write into the production pipeline.
26. As a Trend Tree operator, I want to rotate the key by a coordinated swap with the ATLAS team, so that a leaked key can be replaced.
27. As a Trend Tree operator, I want the task handler to accept only Cloud Tasks' OIDC token, so that nobody can skip the accept route's checks.
28. As a Trend Tree operator, I want a failed topic call, a failed sameness judgment or a failed promotion to be retried by Cloud Tasks, so that a temporary fault does not lose a nomination.
29. As a Trend Tree operator, I want a failed sameness judgment never to fall back to creating a new trend, so that a fault cannot silently create a duplicate.
30. As a Trend Tree operator, I want a retried task that finds its candidate already written to resume at promotion, so that a crash between steps does not create a second candidate or trend.
31. As a Trend Tree operator, I want the audit agent to count editorial candidates with no promotion-ledger row after one hour, so that a nomination that exhausted its retries is noticed.
32. As a Trend Tree operator, I want the audit agent to count `EDITORIAL` promotions next to the Exploding Topics rescue count, so that the volume of hand-nominated trends is visible.
33. As a Trend Tree operator, I want Cloud Run to cap the service at two instances, so that a burst of nominations cannot run up cost; overflow gets Cloud Run's own `429`.
34. As a Trend Tree operator, I want both new prompts in `DIM_LLM_PROMPT` with migrations and audit-manifest entries, so that the prompt-drift audit stays GREEN.
35. As a data analyst, I want the nomination (who and the brief, verbatim) on the promotion ledger, so that I can audit editorial trends without the dashboard exposing personal data.
36. As a data analyst, I want a trend's origin to come from its `PROMOTE_NEW` row, so that a nomination that merges into a discovered trend leaves that trend discovered.
37. As a data analyst, I want both `EDITORIAL` ledger rows to carry the closest neighbor similarity, the neighbors considered and the judge's rationale, so that I can review a match decision.
38. As a prediction-pillar reader, I want an editorial trend to resolve a white-space prediction like any trend, so that a claim that arrived is not graded Incorrect.
39. As a prediction-pillar reader, I want the track record to report hits on editorial trends as a separate group, so that the pipeline's own calibration stays honest.
40. As a prediction-pillar reader, I want an editorial trend's group never to change, even after it gains attributed links, so that the grouping is simple and stable.
41. As a pipeline maintainer, I want the person's URLs to be the only rows that link straight to the editorial trend, so that evidence purity holds.
42. As a pipeline maintainer, I want rows found by any later search to link to the editorial trend only through attribution, so that no claim confirms itself.
43. As a pipeline maintainer, I want the person's URLs claimed by the endpoint's own session, so that distillation does not cluster them into a second candidate.
44. As a pipeline maintainer, I want `PROC_PROMOTION_APPLY` to stay the only writer of `FCT_TRENDS`, so that every trend keeps its candidate and its ledger seeds.

## Implementation Decisions

**The service.** A new Cloud Run service under `services/`, deployed by `services/deploy.sh`
into `mcc-crm-automations` / `us-east4`, with its own `deploy.env`. It is not a route on the
ecomm agent or the prediction service. It is built in the same shape as the prediction service:
a FastAPI app from a factory that takes its Snowflake client, LLM client, task queue client and
token verifier as arguments, and the shared `tt_services_lib` for Snowflake and OIDC. It serves
three routes: the accept route, the task-handler route, and `/health`.

**Ingress and auth.**

- The service binds `allUsers` to `roles/run.invoker`, the `harbor-api` pattern. A new
  `deploy.env` switch, `PUBLIC_INGRESS=true`, makes `deploy.sh` pass `--allow-unauthenticated`.
  Only this service sets it.
- The accept route rejects a missing or wrong `X-Api-Key` with `401`, compared in constant time,
  before any other work.
- One key lives in Secret Manager in `mcc-crm-automations`. ATLAS prod
  (`insights-agent-504817`) keeps a copy. Dev ATLAS gets no key. The service accepts one key at
  a time; rotation is a manual swap coordinated with the ATLAS team.
- The task-handler route accepts only a Google OIDC token from the queue's service account,
  checked with `google_oidc_verifier`.
- The endpoint trusts the `nominated_by` that ATLAS sends and stores it as ATLAS's claim.

**The request contract (accept route).** A JSON body with four required fields:

| Field | Meaning |
| --- | --- |
| `nomination_id` | Generated by ATLAS once per form submission. The idempotency key, the Cloud Tasks task name, and the candidate's `CANDIDATE_ID`. |
| `brief` | The person's free-text description of the trend. Not a name. No cap of its own. |
| `urls` | 1 to 10 URLs. |
| `nominated_by` | Who nominated, as ATLAS knows them. |

The body is capped at 64 KB. The request has no `rationale`, no `category` and no `dry_run`.

**The response contract.**

| Status | When | ATLAS action |
| --- | --- | --- |
| `202 {nomination_id, dropped_urls}` | Accepted, or a repeat of an accepted `nomination_id` | Done; the trend appears later |
| `400` | Malformed body | Fix the request |
| `401` | Missing or wrong key | Fix the key |
| `422 {urls: [{url, reason}]}` | Every URL dropped | Show the reasons to the person |
| `429` | Cloud Run overflow | Retry with the same `nomination_id` |
| `503` | Enqueue failed; nothing written | Retry with the same `nomination_id` |

The endpoint has no status route. The editorial trend shows up in the list later.

**The dead-URL check (accept route).** The same rule as discovery's `canonicalize_and_validate`.
Only a provably dead or malformed URL drops. A 401, 403, 429, 5xx or timeout passes, marked
`unverified: true`. Discovery's freshness and title-relevance filters do not apply.

**Enqueue.** One Cloud Tasks task per nomination, named by `nomination_id`. Cloud Tasks refuses a
second task with the same name; the accept route answers that refusal with `202`. A reused
`nomination_id` with different content gets `202`, and the first content wins.

**The task handler.** It runs these steps in order and writes nothing until steps 1 and 2
succeed. On any failure it returns non-2xx so Cloud Tasks retries with backoff. It has no retry
loop of its own.

1. **Topic.** A tool-free Gemini call writes the trend topic: at most 200 characters, in the
   register of distillation's topics, from the brief and the URL titles. New `DIM_LLM_PROMPT`
   key.
2. **Sameness judgment.** Build the neighbor pool with promotion's recipe: embed
   `topic | first 800 characters of the brief | top 3 URL titles` with
   `snowflake-arctic-embed-l-v2.0`, cosine ≥ 0.50 against each live trend's latest
   `TREND_VECTOR` on `FCT_TREND_ENRICHMENT_LEDGER`, top 8. One tool-free Gemini 3.8 call reads
   the pool and returns `match: <trend_id>` or `no match`, with a rationale. It has no `REJECT`
   and no `DEFER`. A `trend_id` outside the pool is a failure. An empty pool skips the call and
   means no match. New `DIM_LLM_PROMPT` key. The build confirms the exact model ID.
   - A `RETIRED` trend can match.
   - No URL match, and no match against open candidates. Promotion later merges an open
     candidate into the editorial trend if the two are the same.
   - A failure, a timeout or an out-of-pool `trend_id` never falls back to `PROMOTE_NEW`.
3. **Signals.** `MERGE_EXTERNAL_SIGNALS` with the person's URLs, under source name `editorial`
   (a new entry mechanism under ADR-0010), with the request's own `AGENT_SESSION_ID` so
   distillation cannot acquire them. A URL another session claimed first keeps that claim and
   still links to the editorial trend.
4. **Candidate.** One `STG_TREND_CANDIDATES` row: `CANDIDATE_ID` = `nomination_id`, `VERDICT`
   NULL, the same `AGENT_SESSION_ID`, the signal IDs in `SUPPORTING_SIGNAL_IDS`, `TOPIC` from
   step 1, `REASONING` = the brief verbatim, `CONFIDENCE` and `SPECIFICITY_SCORE` NULL.
5. **Promotion.** `PROC_PROMOTION_APPLY` with `decision_category` `EDITORIAL`:
   - no match → `PROMOTE_NEW`, then a dispatcher POST, the same as promotion's
     `fire_enrichment_chain`;
   - match → `MERGE_INTO_EXISTING` with `target_trend_id`, and no dispatch;
   - a `RETIRED` match → also a `RESURGENT` row to `FCT_TREND_LIFECYCLE_LEDGER`. The endpoint
     becomes the second writer of that ledger, because the lifecycle sweep skips `RETIRED`.
   - Both decisions carry `max_neighbor_sim`, `considered_neighbors` and the judge's rationale.

**Resume and idempotency.** A task that finds its candidate (keyed on `nomination_id`) with a
promotion-ledger row does nothing and returns 2xx. A task that finds its candidate without a
ledger row skips steps 3 and 4 and resumes at step 5. Accepted gap: a second person who
nominates the same trend inside the 2-to-3-minute window before the first trend's vector exists
can still create a second trend.

**Schema and SQL changes.**

- `FCT_PROMOTION_LEDGER` gets a nullable `NOMINATION` VARIANT holding
  `{nominated_by, brief}`, with the brief verbatim. The time is `DECIDED_AT`.
- `PROC_PROMOTION_APPLY` accepts `decision_category` `EDITORIAL` and a `nomination` field on the
  decision, and its `log_audit` writes the `NOMINATION` column.
- `DT_TREND_DASHBOARD` gets `TREND_ORIGIN` (`DISCOVERED` | `EDITORIAL`), read from the
  category on the trend's `PROMOTE_NEW` row. Nothing else about the nomination reaches the
  dashboard. Nothing is added to `FCT_TRENDS`. The dashboard does not join
  `STG_TREND_CANDIDATES`.
- `docs/dashboard/data-contract.md` documents `TREND_ORIGIN`, and its ATLAS Confluence mirror
  is updated from it.

**Origin.** A trend's origin is the category on its `PROMOTE_NEW` row. A nomination that merges
into a discovered trend leaves that trend discovered.

**What does not change.**

- No scorer reads the origin. `HEAT_INDEX`, `PREDICTION_SCORE` and the opportunity score treat
  an editorial trend like any trend; with `CONFIDENCE` NULL the heat formula uses 0.5.
- The lifecycle agent and the lifecycle-attribution agent do not change. An editorial trend
  gets the same rubric and gains evidence only through the normal attribution sweep (about
  every 18 hours), with no priority.
- Enrichment does not change and does not read the brief. It reads the topic and the linked
  signals, and it names the trend.
- No scout agent searches for evidence. A row any search finds may enter `FCT_SIGNALS`, but it
  links to the editorial trend only through attribution.
- The prediction matcher does not change. An editorial trend may resolve a white-space
  prediction.
- The promotion agent does not read candidates with `VERDICT` NULL, so it never sees the
  editorial candidate (ADR-0011).

**Prediction track record.** §7.6 of `docs/prediction-pillar-strategy.md` gains one rule: the
track record reports hits on editorial trends as a separate group, derived at read time by
following `MATCHED_TREND_ID` to the trend's `PROMOTE_NEW` row. The verdict ledger stores
nothing new. The group never changes, even after the trend gains `attributed` links. No
track-record query exists yet, so this is a doc change only.

**Audit agent.** Two new counts: `EDITORIAL` promotions, next to `q_et_rescue`; and editorial
candidates with no promotion-ledger row older than one hour. No dead-letter queue and no
callback to ATLAS. The registry adds the new service.

**Capacity.** No rate limit and no daily cap in code. `deploy.env` sets `MAX_INSTANCES=2` and
keeps the default concurrency.

**Prompt governance.** Each of the two new `DIM_LLM_PROMPT` keys lands as a committed
`sql/update_prompts_*.sql` migration, with its entry in the audit agent's `q_prompt_drift`
manifest (both the `sql.value` and `sql.query` copies), in the same commit.

**Vocabulary.** `CONTEXT.md`'s source-name table gains `editorial`.

## Testing Decisions

A good test fires a route and asserts on what reached Snowflake or the queue. It never asserts
on prompt text or on the order of internal calls.

**Live smoke test (the main test).** Against the candidate revision that `deploy.sh`
dark-deploys, then by Snowflake query. This project has no stage environment, so each live
nomination writes to production.

- A wrong `X-Api-Key` gets `401`; a malformed body gets `400`; a request whose URLs are all dead
  gets `422`. These write nothing.
- A nomination that copies a live trend gets `202`, and its `nomination_id` ends with an
  `EDITORIAL` `MERGE_INTO_EXISTING` row on `FCT_PROMOTION_LEDGER`, with `NOMINATION` filled and
  the person's URL linked to the existing trend. No new trend appears.
- The same request sent twice leaves one candidate row and one ledger row.
- The first real nomination of a new trend is the `PROMOTE_NEW` check: an `EDITORIAL`
  `PROMOTE_NEW` row with `NOMINATION`, an `initial` enrichment row within minutes, and
  `TREND_ORIGIN = 'EDITORIAL'` on `DT_TREND_DASHBOARD` after a refresh.

**Fake-based tests (two only).** The two failure paths cannot be forced live without test code
in the production path. Each uses the app factory with a recording `FakeSnowflake` and a fake
LLM, in the prediction service's pattern (its route tests and fakes are the prior art).

1. A failed sameness judgment (an error, or a `trend_id` outside the pool) returns non-2xx and
   writes no signal, no candidate and no promotion decision.
2. A task that finds its candidate without a ledger row calls `PROC_PROMOTION_APPLY` once and
   writes no second signal merge and no second candidate.

Nothing else gets a unit test. The `503` on an enqueue failure stays untested; it is one branch.

## Out of Scope

- The nomination form in ATLAS (`insights-agent`): a different repo and a different team.
- Bulk import of many editorial trends: one trend per request.
- The PGS link between a Trend Hunter CMS editorial trend and an analytical trend.
- The lifecycle-rubric gap that keeps low-evidence trends of every origin in `STABLE`
  ([CRMA-1655](https://mcclatchy.atlassian.net/browse/CRMA-1655)).
- A "your nominations" view in ATLAS, which needs a `nomination_id` → `TREND_ID` link on the
  dashboard.
- A status route, a callback to ATLAS, and a dead-letter queue.
- A rate limit or a budget beyond `MAX_INSTANCES=2`.
- Building the prediction track record itself.

## Further Notes

- Decisions and their reasoning live on the map's tickets: CRMA-1425 (guarantee), CRMA-1426
  (evidence search), CRMA-1429 / ADR-0011 (entry point), CRMA-1430 (origin), CRMA-1431
  (hosting and auth), CRMA-1432 (contract), CRMA-1638 (sameness), CRMA-1639 (lifecycle),
  CRMA-1640 (rate limit), CRMA-1643 (predictions), CRMA-1658 (topic and name).
- The source name `editorial` is the one decision this spec adds beyond the map. ADR-0010 gives
  each entry mechanism its own name, and a hand nomination is a new mechanism. The promotion
  gate does not apply to an editorial candidate, so no `sourceFamilyOf()` rule is needed.
- No request for this endpoint exists in writing; the requirement comes from the map's driver.
- The ATLAS team needs the key and the contract table above before they build the form.
