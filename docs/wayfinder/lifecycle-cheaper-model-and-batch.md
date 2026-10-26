<!-- map: CRMA-1644 -->

# Map: lifecycle agent on a cheaper model and a Gemini batch

## Destination

A locked, handoff-ready spec for the lifecycle agent as **one Cloud Run job that sends a Gemini batch** (one request per trend) and evaluates every due trend, plus a **decided lifecycle model** backed by an offline shadow comparison. Success: no live non-RETIRED trend is more than one cadence period past `NEXT_EVAL_AT`, at no more than today's **$15.60/day**.

## Notes

- **Two words, two meanings.** A **Cloud Run job** is the deployable (`KIND=job`, started by Cloud Scheduler). A **Gemini batch** is one Batch API submission holding one request per trend. The job does not imply the batch; they are separate decisions.
- **This map plans; it does not build.** One exception: once "Decide: the lifecycle model" closes on a change, that switch may ship as its own story on the current Pipedream workflow, before the spec is done.
- **The fleet migration map binds lifecycle.** Every standing constraint of [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429) (map file `docs/wayfinder/move-the-agent-fleet-off-pipedream-to.md` on its own branch) applies here, except a constraint this map amends by name. The known amendment: CRMA-429 says a lead + subagent pair "fans out to the subagent loop in-process through a bounded worker pool"; this map replaces that loop with a Gemini batch. The last ticket reports every amendment back to CRMA-429 and [CRMA-537](https://mcclatchy.atlassian.net/browse/CRMA-537).
- **Skills:** `/grilling` + `/domain-modeling` for decisions, `/research` for research, `/prototype` for the prototype, `pipedream-synced-project` for how the lifecycle workflows are wired today.
- **Recommendations go in prose** with the deciding fact first, not as option cards.

## Established facts

- Lifecycle is about 97% of tracked LLM spend: $109.04 of $112.10 over 7 days; 4,185 evals (about 598/day = `sweep_cap` 25 × 24); median $0.0255 per eval; median 11,558 input and 193 output tokens; model `gemini-3.1-pro-preview` (`FCT_TREND_LIFECYCLE_LEDGER`, `FCT_PROMOTION_LEDGER`, `FCT_TREND_ENRICHMENT_LEDGER`, measured 2026-10-26).
- Only enrichment, lifecycle, promotion and the audit agent record cost in Snowflake. Attribution, distillation, the cluster-agent, discovery and revisit record none (`INFORMATION_SCHEMA.COLUMNS`, 2026-10-26).
- `TOOL_CALLS_JSON` is NULL on recent lifecycle rows, so the turn and tool-call count per eval is not recorded (2026-10-26).
- The model is a constant: `const MODEL = "gemini-3.1-pro-preview"` in `lifecycle-subagent-p_gYC562o/run_subagent/entry.js` (2026-10-26).
- The four lifecycle tools (`query_trend_neighbors`, `query_signal_velocity`, `query_lifecycle_history`, `propose_lifecycle_decision`) only read data the workflow prefetched; none calls a live API (`run_subagent/entry.js`, 2026-10-26).
- The agent picks `next_eval_in_hours`; `PROC_LIFECYCLE_APPLY` clamps it to [1, 168] and writes `NEXT_EVAL_AT` (`sql/proc_lifecycle_apply.sql`, 2026-10-26).
- There is no shadow mode. `WRITE_LIVE` is deprecated and every ledger insert is canonical; `dry_run` skips the LLM call (`sql/proc_lifecycle_apply.sql`, `run_subagent/entry.js`, 2026-10-26).
- `gemini-3.7-flash` was deprecated 2026-10-08; Google routes its calls to `gemini-3.8-flash`, so the Flash candidate is **3.8 Flash** ([CRMA-1645](https://mcclatchy.atlassian.net/browse/CRMA-1645), 2026-10-26).
- A Gemini batch costs 50% of standard. Per 1M tokens, in / out, thinking billed as output: 3.1 Pro $2 / $12 standard, $1 / $6 batch (prompts up to 200k); 3.8 Flash $0.75 / $3.75 standard, $0.375 / $1.875 batch, doubling on 2027-01-01 (CRMA-1645, 2026-10-26).
- At 600 evals/day and the baseline token counts: 3.1 Pro $15.26 standard, $7.63 batch; 3.8 Flash batch $2.82 through 2026, $5.64 from 2027 (CRMA-1645, 2026-10-26).
- A Gemini batch targets 24 h and usually finishes much sooner; a batch still pending after 48 h expires with no results; Google publishes no typical spread (CRMA-1645, 2026-10-26).
- Each batch entry is one call: `responseSchema` and tools are supported, `thinkingConfig` is likely but not confirmed, and a multi-turn tool loop needs one batch round per turn (CRMA-1645, 2026-10-26).
- The existing Generative Language API key submits batches (inline under 20 MB, or a JSONL file through the Files API); Vertex is not needed. Tier 1 caps enqueued tokens at 5M (3.1 Pro) and 3M (3.8 Flash), below one day's ~6.9M, and the account's tier is not checked (CRMA-1645, 2026-10-26).
- Explicit caching works in a Gemini API batch; implicit caching there is unconfirmed (CRMA-1645, 2026-10-26).
- After CRMA-1633 (merged 2026-10-26 05:03 UTC) the sweep picks the most overdue trends first: the 01:00 and 02:00 ET sweeps picked trends a median 2,279 h and 2,205 h overdue, 25 evals each.
- Production's lifecycle cost leaves out thinking tokens and reads about 20% low: on the 120-trend snapshot Pro's true mean is $0.0318 per eval against $0.0256 as recorded, so 600 evals/day is about $19.10 standard and $9.55 on a Pro batch, not $15.26 / $7.63 ([CRMA-1647](https://mcclatchy.atlassian.net/browse/CRMA-1647), 2026-10-26).
- In today's tool loop 3.8 Flash takes 3.1 turns per eval against Pro's 2.0 and resends the ~10k-token prompt each turn: mean $0.0219 per eval, $6.57/day on a batch through 2026, about $13.14/day from 2027, which is more than Pro's $9.55 (CRMA-1647, 2026-10-26).
- Both models sometimes omit the required `status` from `propose_lifecycle_decision` (3.8 Flash 6 of 120, Pro 1 of 240); the Gemini API does not enforce the function schema's `required` list. `PROC_LIFECYCLE_APPLY` rejects such a decision, writes no ledger row and leaves `NEXT_EVAL_AT` unchanged, so the trend is re-evaluated on a later sweep (CRMA-1647, 2026-10-26).
- On the snapshot neither model requested re-enrichment for any trend, including the 20 Pro requested it for in the prior 7 days, so the re-enrichment gate has not been tested (CRMA-1647, 2026-10-26).

## Standing constraints

- The model comparison runs **offline**: a local harness, outputs to a file, no writes to `FCT_TREND_LIFECYCLE_LEDGER` and no call to `PROC_LIFECYCLE_APPLY`.
- A candidate model is judged against **Pro's own run-to-run agreement** on one snapshot (Pro twice, candidate once), across four outputs: status, `next_eval_in_hours`, retirement proposals, re-enrichment requests.
- **The lifecycle model is `gemini-3.8-flash`** ([CRMA-1648](https://mcclatchy.atlassian.net/browse/CRMA-1648), 2026-10-26). The owner chose it although it failed two gates in the tool-loop shape (CRMA-1647), and accepts its known gaps: it omits the required `status` on about 5% of trends, and it sets longer re-eval intervals. The prompt and the queries get adjusted as needed after the switch; the switch does not wait for a gate re-run. The switch ships as its own story on the current Pipedream workflow, ahead of the job spec. The pass bar below stays as the yardstick for any later request shape.
- The pass bar (CRMA-1646, now a yardstick, not a switch condition): the candidate is `gemini-3.8-flash`. It replaces `gemini-3.1-pro-preview` only if it clears every gate of the pass bar ([CRMA-1646](https://mcclatchy.atlassian.net/browse/CRMA-1646)) on one frozen snapshot of 120 trends in five strata: 40 status transitions, 25 DORMANT (all recent retirement proposals), 20 re-enrichment requests, 15 GROWING/DECLINING holds, 20 STABLE controls. The gates are: status exact-match agreement on the 100 hard-stratum trends ≥ the noise floor − 5 points, with the control status-change rate ≤ 2× Pro's; zero false retirement proposals, with misses ≤ the Pro-vs-Pro disagreements + 1; `next_eval_in_hours` bucket agreement (≤ 6 h / 7–24 h / > 24 h) ≥ the noise floor − 10 points, which becomes report-only if code sets the interval; and a re-enrichment request rate within 0.5×–2× of Pro's. The gates bind the request shape that ships, and a shape change means the comparison runs again on the same snapshot.
- The snapshot and the harness are fixed: `docs/wayfinder/assets/crma-1647/` (`out/snapshot.jsonl.gz`, frozen 2026-10-26). Any re-run, including one for a new request shape, uses that snapshot and `score.mjs`, and reports a status omission as a disagreement.
- The lifecycle status and heat may update on a **batch cadence**, not hourly. If research shows batches often take longer than 6 h, "Decide: the lifecycle job's cadence and run shape" may reopen this.

## Decisions so far

- [Research: Gemini Batch API facts for the lifecycle agent](https://mcclatchy.atlassian.net/browse/CRMA-1645) — **Decided:** a Gemini batch is half price on the existing API key, one call per entry; Flash candidate is 3.8 (3.7 deprecated); 600 evals/day = 7.63 USD on Pro batch, 2.82 USD on 3.8 Flash batch in 2026

- [Decide: the pass bar for switching the lifecycle model](https://mcclatchy.atlassian.net/browse/CRMA-1646) — **Decided:** gemini-3.8-flash replaces Pro only if it clears four gates on 120 stratified trends: status within 5 pts of the Pro noise floor, zero false retirements, interval buckets within 10 pts, re-enrichment rate 0.5x-2x

- [Build and run the offline lifecycle shadow harness](https://mcclatchy.atlassian.net/browse/CRMA-1647) — **Decided:** 3.8 Flash fails the pass bar in the tool loop: it omits the required status on 5% of trends and moves 16 of 120 re-eval intervals past 24 h; its status judgement matches Pro. It saves only 31% (6.57 vs 9.55 USD/day on a batch), and production under-records Pro cost by about 20%

- [Decide: the lifecycle model](https://mcclatchy.atlassian.net/browse/CRMA-1648) — **Decided:** Owner switches the lifecycle subagent to gemini-3.8-flash despite two failed gates; it ships as its own story on the current Pipedream workflow, and the prompt and queries get adjusted as needed afterwards

## Not yet specified

- The set-based port of the subagent's 7 queries (`q_metrics`, `q_signal_domains`, `q_lifecycle_history`, `q_recent_signals`, `q_candidate_signals`, `q_neighbors`, `q_prompts`): once per run for all due trends, not once per trend.
- The `DIM_LLM_PROMPT` migration for a one-request prompt, with the audit manifest bump in `q_prompt_drift`.
- The cut-over: shadow window and close under CRMA-429's window-close rule, then deactivating `lifecycle-agent-p_JZCz73w` and `lifecycle-subagent-p_gYC562o`.
- The alert policy and the `STG_AGENT_RUN_COSTS` rows the CRMA-535 rules require, and what a per-run budget cap means for a batch.

## Out of scope

- **lifecycle-attribution** (`lifecycle-attribution-agent-p_KwCoaap` + subagent): it records no cost, and CRMA-1459 is changing its sweep. It can copy this spec later as its own effort.
- **Changing the heat formula**: already ruled out of scope in CRMA-1633.
- **Executing the migration**: the map ends at the locked spec (the model switch excepted, see Notes).
