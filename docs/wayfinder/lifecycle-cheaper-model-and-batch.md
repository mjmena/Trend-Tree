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
- After CRMA-1633 (merged 2026-10-26 05:03 UTC) the sweep picks the most overdue trends first: the 01:00 and 02:00 ET sweeps picked trends a median 2,279 h and 2,205 h overdue, 25 evals each.

## Standing constraints

- The model comparison runs **offline**: a local harness, outputs to a file, no writes to `FCT_TREND_LIFECYCLE_LEDGER` and no call to `PROC_LIFECYCLE_APPLY`.
- A candidate model is judged against **Pro's own run-to-run agreement** on one snapshot (Pro twice, candidate once), across four outputs: status, `next_eval_in_hours`, retirement proposals, re-enrichment requests.
- The lifecycle status and heat may update on a **batch cadence**, not hourly. If research shows batches often take longer than 6 h, "Decide: the lifecycle job's cadence and run shape" may reopen this.

## Decisions so far

## Not yet specified

- The set-based port of the subagent's 7 queries (`q_metrics`, `q_signal_domains`, `q_lifecycle_history`, `q_recent_signals`, `q_candidate_signals`, `q_neighbors`, `q_prompts`): once per run for all due trends, not once per trend.
- The `DIM_LLM_PROMPT` migration for a one-request prompt, with the audit manifest bump in `q_prompt_drift`.
- The cut-over: shadow window and close under CRMA-429's window-close rule, then deactivating `lifecycle-agent-p_JZCz73w` and `lifecycle-subagent-p_gYC562o`.
- The alert policy and the `STG_AGENT_RUN_COSTS` rows the CRMA-535 rules require, and what a per-run budget cap means for a batch.

## Out of scope

- **lifecycle-attribution** (`lifecycle-attribution-agent-p_KwCoaap` + subagent): it records no cost, and CRMA-1459 is changing its sweep. It can copy this spec later as its own effort.
- **Changing the heat formula**: already ruled out of scope in CRMA-1633.
- **Executing the migration**: the map ends at the locked spec (the model switch excepted, see Notes).
