# Promotion extraction: the seam the typed path needs

Decided on [CRMA-1242](https://mcclatchy.atlassian.net/browse/CRMA-1242), 2026-09-28, map
[CRMA-1214](https://mcclatchy.atlassian.net/browse/CRMA-1214).

This file is a checklist. Promotion's lift-and-shift to Cloud Run (CRMA-429 phase 2, sequenced by
CRMA-537) is checked against it. The file does not describe the extraction itself. It names only
what the extraction must leave open, so that the typed Jev path can replace the Gemini tool loop
later without a rewrite of the service.

**Faithful** means below that every verdict, every ledger row and every candidate timestamp stays
the same as on Pipedream. It does not mean that the deploy topology stays the same.

## The facts this rests on

Repo read of `promotion-p_xMC99jg/` and `promotion-agent-p_yKCmm9r/`, 2026-09-28.

- The lead POSTs each candidate to the subagent over plain HTTP: a worker pool of 6 and a 240 s
  timeout per call (`run_lead_agent/entry.js:26-101`, `:520-525`). No suspend/resume.
- No promotion step imports anything. `classifyCandidate`, `buildClusters`, `buildDispatch`, the
  ET adapter and the prompt loader are inline copies of `agents/lib/*`. The copies drift.
- The replay harness (`scripts/replay/lanes/promotion.mjs`, branch
  `wayfinder/gemini-3-7-flash-model-allocation`) loads the deployed step files by binding name
  through `loadStep()`. Its own copy of the user message already lacks ET-rescue step "2b"
  (`run_subagent/entry.js:670-672`).
- `PROC_PROMOTION_APPLY` (596 lines) applies each decision in its own transaction. The
  transaction covers `FCT_TRENDS`, the candidate timestamps, the starter rows for the lifecycle and
  enrichment ledgers, `FCT_TREND_ET_LEDGER`, follower resolution for `MERGE_INTO_CANDIDATE`, and
  the `FCT_PROMOTION_LEDGER` row. Its `results[]` feeds `fire_enrichment_chain` and
  `eval_and_retrigger`.
- Today a failure has two different results. A crash inside the loop (`:698`) or a loop with no
  terminal call (`:717`) returns `DEFER`, and the ledger gets a row. A transport failure (HTTP
  error or timeout) drops the candidate with no row (`run_lead_agent/entry.js:531-533`).
- `dry_run` skips the model at both levels (`run_lead_agent/entry.js:490`,
  `run_subagent/entry.js:639`) and returns placeholder `DEFER` rows. Nothing in the repo sends it.
- CRMA-1326 (map CRMA-1315) requires a Reddit corroboration oracle to use the same seam as
  Exploding Topics.

## The constraints

Each item is a pass/fail check on the extraction PR.

**1. The decider is a replaceable module.** All per-candidate judgment sits behind one module, the
**decider**. The HTTP handler and the lead loop call only the decider. The Gemini tool loop is the
first and only implementation at extraction time. Its tool executor, its four tool schemas and its
fallbacks are private to that implementation. *Check:* no file outside the implementation names
`compare_topics`, `query_neighbor_details`, `verify_exploding_topics` or `propose_decision`.

**2. One service; the decider runs in-process.** `services/promotion` holds the lead and the
decider. The lead calls the decider in-process with a concurrency of 6. The subagent's HTTP
contract is not carried forward. *Check:* there is no second service and no HTTP call between the
lead and the decider.

**3. `PROC_PROMOTION_APPLY` stays the only writer.** The service never writes `FCT_PROMOTION_LEDGER`
or any other promotion table directly. The bundle JSON is the contract between the service and
Snowflake. The typed path's new fields (`RUN_OUTCOME`, `DECISION_RULE`, `ORACLE_KEYWORD`,
`ORACLE_KEYWORD_SOURCE`, `JUDGMENT_DETAIL`; CRMA-1224) enter later as a bundle and proc migration,
with no change to the decider. *Check:* the service issues no INSERT or UPDATE of its own.

**4. The helpers are exported modules in `services/lib/promotion/`.** The decider contract, the
gate helpers (`classifyCandidate`, `buildClusters`, `buildDispatch`, `indexCombinedRows`), the ET
adapter and the prompt loader are exported modules with unit tests under
`scripts/test_services_lib.sh`. The replay harness imports these modules and stops using
`loadStep()` for promotion. The composition rule lands here later, as pure code with no model call.
*Check:* the replay lane and production import the same file.

**5. Corroboration oracles are an injected list.** The decider receives an ordered list of
corroboration oracles, each `{name, lookup(keyword) → results}`. It does not receive an Exploding
Topics client. Each adapter owns its own match threshold. The ET volume floor of 1000
(`agents/lib/exploding_topics.mjs:39`) moves into the ET adapter and out of the model. The
extraction ships with the list `[exploding_topics]`. *Check:* a second oracle is one new adapter
plus one list entry, with no change to the decider or the lead.

**6. The `Decision` type carries `failed` from day one.** The decider returns
`{outcome: 'decided', verdict, category, target, …}` or `{outcome: 'failed', stage, error}`.
During the lift-and-shift, the Gemini implementation keeps its own caught fallbacks, and they
return `decided` with `DEFER`, as today. An exception that escapes the decider becomes `failed`,
and the lead drops that candidate with no row, as the HTTP-error path does today. When the typed
path ships, `DEFER` leaves the verdict set (CRMA-1219), and every machine failure becomes `failed`.
One lead function maps `failed` to the bundle. *Check:* exactly one function in the lead reads
`outcome === 'failed'`.

**7. The implementation is chosen per revision.** `services/promotion/deploy.env` sets
`PROMOTION_DECIDER=gemini_loop` (later `jev`). The lead reads it once at startup. No request field
can choose the implementation, because a Pipedream-called service is public behind one header key
(CRMA-528). When the typed path ships, `deploy.env` also pins `JEV_MODEL` to an explicit version,
never `jev-latest`. Rollback is the standard `update-traffic` to the prior revision. *Check:* the
request schema has no decider field.

**8. `dry_run` is removed.** The service has no `dry_run`. The extraction deletes the flag, its two
placeholder `DEFER` sites (`run_lead_agent/entry.js:490`, `run_subagent/entry.js:639`) and the
`dry_run` stop reason in `eval_and_retrigger`. The PR states the removal. The replay harness is the
only way to run the decider without writes. A new revision is proven by replay before it gets
traffic. *Check:* no `dry_run` in `services/promotion/`.

**9. The pre-gate stays in the lead; ET-rescue routing moves into the Gemini decider.** The reject
arm of `classifyCandidate()` runs in the lead, **before** intra-batch clustering, in today's order.
A rejected candidate therefore never becomes a leader whose outcome followers copy. The `et_rescue`
flag is computed inside the Gemini implementation, which is its only reader. When the typed path
ships, it deletes the pre-gate stage (dormant since August; CRMA-1220) and never sees the router.
*Check:* the lead does not pass `et_rescue` to the decider.

**10. Per-run dependencies go to a factory; per-candidate inputs go to `decide()`.**
`createDecider({prompts, oracles, modelClient, config})` runs once per lead run.
`decide(candidate, neighbourPool)` runs once per candidate. Each implementation declares the
`DIM_LLM_PROMPT` keys it needs (Gemini: `promotion.subagent.system`,
`promotion.subagent.decision_rubric`; typed: the six `promotion.jev.*` rows), and the lead loads
them once per run. *Check:* the prompt rows load once per run, not once per candidate.

**11. `Decision` carries `usage` and an opaque `trace`.** `usage` is model, tokens and cost, which
the bundle already forwards. Each implementation defines the content of its `trace`: for the
Gemini loop, turns, `stop_reason` and the tool-call list; for the typed path, the Jev request ids
and the raw answers. The lift-and-shift writes the `trace` as a structured Cloud Logging entry only
and adds no DDL. The typed path later persists its `trace` into `JUDGMENT_DETAIL`. *Check:* a run
that exhausts `max_iterations` shows in the logs with its turn count.

**12. The claim query is one named function.** The claim query moves into the service as a single
function. When the typed path ships, it adds the `PARKED_AT` clause there (CRMA-1224), because the
retry bound lives in the ledger and the claim filter never reads the ledger. *Check:* no other code
path selects candidates to claim.

## Out of this checklist

- The extraction itself, its scaling, cost alert and ingress: CRMA-429's template rules
  (CRMA-496, CRMA-497, CRMA-528) govern those.
- The typed path's contents: question set, rubric, composition rule and record (CRMA-1220,
  CRMA-1221, CRMA-1224).
- What counts as a Reddit match and where its call runs: CRMA-1326.
