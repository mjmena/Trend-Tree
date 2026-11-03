<!-- map: CRMA-1686 -->

# Map: attribution agent as a Cloud Run job that sends a Gemini batch

## Destination

A locked, handoff-ready spec, `docs/prd/attribution-job.md`, for the attribution agent (`lifecycle-attribution-agent-p_KwCoaap` + `lifecycle-attribution-subagent-p_PACe77B`) as **one Cloud Run job that sends a Gemini batch** (one request per trend) — **or** a recorded decision not to convert, with the measured cost as the reason. Success: no eligible trend goes longer than one cycle between sweeps, at less than today's measured cost.

## Notes

- **Same words as the lifecycle map.** A **Cloud Run job** is the deployable; a **Gemini batch** is one Batch API submission holding one request per trend. A **cycle** is the time the round-robin takes to sweep every eligible trend once.
- **The lifecycle map binds this map.** Every standing constraint of [CRMA-1644](https://mcclatchy.atlassian.net/browse/CRMA-1644) (`docs/wayfinder/lifecycle-cheaper-model-and-batch.md` on branch `wayfinder/lifecycle-cheaper-model-and-batch`, spec `docs/prd/lifecycle-job.md`) and of [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429) applies here, except a constraint this map amends by name. Decide only where attribution differs. The last ticket reports every amendment back to both maps.
- **This map plans; it does not build.**
- **Skills:** `/grilling` + `/domain-modeling` for decisions, `pipedream-synced-project` for how the attribution workflows are wired today.
- **Recommendations go in prose** with the deciding fact first, not as option cards.

## Established facts

- The attribution subagent is a `gemini-3.1-pro-preview` tool loop: `max_iterations` 6, `budget_usd` 0.04 per trend. Its two tools do no work: `filter_candidates` filters the pool `q_candidate_signals` already fetched, and `commit_attributions` only stores the answer (`lifecycle-attribution-subagent-p_PACe77B/run_subagent/entry.js`, 2026-11-03).
- Attribution writes no cost row: its only write is the `FCT_TREND_SIGNALS` insert, and `STG_AGENT_RUN_COSTS` has no attribution rows over 30 days (2026-11-03). The upper limit is about 720 evals/day × 0.04 USD ≈ 29 USD/day.
- The insert has a `NOT EXISTS` guard on `(TREND_ID, SIGNAL_ID)`, so a repeated apply links nothing twice (`workflow.yaml` step `commit_attributions`, 2026-11-03).
- The candidate pool is at most 20 signals with cosine ≥ 0.35 to the trend vector, embedded in the last `lookback_hours` (default 72), not already linked to the trend (`q_candidate_signals`, 2026-11-03).
- The sweep is an hourly round-robin over a stable `HASH(TREND_ID)` order, `sweep_cap` 30 (max 100), dispatched at concurrency 6 (CRMA-1459; `q_select_active_trends`, `dispatch_to_subagents/entry.js`, 2026-11-03).
- 571 trends are eligible (an enrichment `TREND_VECTOR`, status not RETIRED or DORMANT), so one cycle is ceil(571 / 30) = 20 h (2026-11-03).
- Over the last 30 days the agent added 3,731 `attributed` links across 435 trends; the last one landed 2026-11-02 11:38 (2026-11-03).
- The prompts are `DIM_LLM_PROMPT` keys `signal.attribution.system` and `signal.attribution.rubric` (`q_prompts`, 2026-11-03).

## Standing constraints

- **Attribution is its own Cloud Run job, `services/attribution`**, built on `services/lib` (`createGeminiBatchClient`, `runTick`), not a mode of `services/lifecycle`. Its cut-over is independent of the lifecycle cut-over.
- **The cost measurement is offline.** It changes no Pipedream workflow and adds no cost row to the live subagent.
- **A model is judged mainly on link precision**, against Pro's own run-to-run agreement on one frozen snapshot (Pro twice, candidate `gemini-3.8-flash` once). A false link inflates heat and nothing removes it later.

## Decisions so far

## Not yet specified

- **The cut-over.** Probably copies CRMA-1674 (delete the two workflows by hand, a capped first execution, then `schedule.sh`), but it waits on the model and cadence decisions.
- **The spec.** Assembles every constraint into `docs/prd/attribution-job.md` and reports amendments back to CRMA-1644 and CRMA-429.

## Out of scope
