<!-- map: CRMA-1686 -->

# Map: attribution agent as a Cloud Run job that sends a Gemini batch

## Destination

A locked, handoff-ready spec, `docs/prd/attribution-job.md`, for the attribution agent (`lifecycle-attribution-agent-p_KwCoaap` + `lifecycle-attribution-subagent-p_PACe77B`) as **one Cloud Run job that sends a Gemini batch** (one request per trend). Success: no eligible trend goes longer than one cycle between sweeps, at less than today's measured cost.

## Notes

- **Same words as the lifecycle map.** A **Cloud Run job** is the deployable; a **Gemini batch** is one Batch API submission holding one request per trend. A **cycle** is the time the round-robin takes to sweep every eligible trend once.
- **The lifecycle map binds this map.** Every standing constraint of [CRMA-1644](https://mcclatchy.atlassian.net/browse/CRMA-1644) (`docs/wayfinder/lifecycle-cheaper-model-and-batch.md` on branch `wayfinder/lifecycle-cheaper-model-and-batch`, spec `docs/prd/lifecycle-job.md`) and of [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429) applies here, except a constraint this map amends by name. Decide only where attribution differs. The last ticket reports every amendment back to both maps.
- **This map plans; it does not build.**
- **Skills:** `/grilling` + `/domain-modeling` for decisions, `pipedream-synced-project` for how the attribution workflows are wired today.
- **Recommendations go in prose** with the deciding fact first, not as option cards.

## Established facts

- The attribution subagent is a `gemini-3.1-pro-preview` tool loop: `max_iterations` 6, `budget_usd` 0.04 per trend. Its two tools do no work: `filter_candidates` filters the pool `q_candidate_signals` already fetched, and `commit_attributions` only stores the answer (`lifecycle-attribution-subagent-p_PACe77B/run_subagent/entry.js`, 2026-11-03).
- Attribution writes no cost row: its only write is the `FCT_TREND_SIGNALS` insert, and `STG_AGENT_RUN_COSTS` has no attribution rows over 30 days (2026-11-03).
- The insert has a `NOT EXISTS` guard on `(TREND_ID, SIGNAL_ID)`, so a repeated apply links nothing twice (`workflow.yaml` step `commit_attributions`, 2026-11-03).
- The candidate pool is at most 20 signals with cosine ≥ 0.35 to the trend vector, embedded in the last `lookback_hours` (default 72), not already linked to the trend (`q_candidate_signals`, 2026-11-03).
- The sweep is an hourly round-robin over a stable `HASH(TREND_ID)` order, `sweep_cap` 30 (max 100), dispatched at concurrency 6 (CRMA-1459; `q_select_active_trends`, `dispatch_to_subagents/entry.js`, 2026-11-03).
- 571 trends are eligible (an enrichment `TREND_VECTOR`, status not RETIRED or DORMANT), so one cycle is ceil(571 / 30) = 20 h (2026-11-03).
- Over the last 30 days the agent added 3,731 `attributed` links across 435 trends. It is live: 116–316 links a day from 2026-10-16 to 2026-11-02, about 0.28 per eval (2026-11-03).
- 569 of 573 eligible trends have a non-empty candidate pool and the median pool is the full 20, so nearly all 720 evals/day make a paid call (2026-11-03).
- Today's tool loop costs **$0.0250 per eval, $18.02/day** on Pro with thinking billed; production's own formula leaves thinking out and would record $0.0177. The loop takes 1.98 turns: `commit_attributions`, then a closing turn that resends the ~4k-token prompt (8,086 input tokens per eval). 1 of 50 evals hit `MAX_TOKENS` under the 2048-token per-call cap and committed nothing ([CRMA-1687](https://mcclatchy.atlassian.net/browse/CRMA-1687), 2026-11-03).
- In the one-request shape (3,401 input tokens, no tools, `commit_attributions`' schema as `responseSchema`): Pro $0.0136 per eval, $9.82/day standard, **$4.91/day on a Gemini batch**; `gemini-3.8-flash` $0.0060 per eval, $4.35/day standard, **$2.18/day on a batch through 2026**, $4.35/day from 2027-01-01 (CRMA-1687, 2026-11-03).
- On the same 50 frozen trends the replayed Pro loop linked 2 signals, Pro one-request 14 and Flash one-request 8; production's rate predicts about 14. The loop replay's link rate is not trusted, so the comparison must check it before it uses a loop run as a baseline (CRMA-1687, 2026-11-03).
- The prompts are `DIM_LLM_PROMPT` keys `signal.attribution.system` and `signal.attribution.rubric` (`q_prompts`, 2026-11-03).

## Standing constraints

- **Attribution is its own Cloud Run job, `services/attribution`**, built on `services/lib` (`createGeminiBatchClient`, `runTick`), not a mode of `services/lifecycle`. Its cut-over is independent of the lifecycle cut-over.
- **The cost measurement is offline.** It changes no Pipedream workflow and adds no cost row to the live subagent.
- **The attribution agent converts.** The two Pipedream workflows are replaced, not kept: CRMA-429 requires a full Pipedream exit, and the batch shape alone cuts cost from $18.02 to $4.91/day on Pro.
- **The job targets `gemini-3.8-flash`, gated by the pass bar.** If Flash fails the pass bar, the job ships on `gemini-3.1-pro-preview`. The conversion does not wait for a model.
- **Links may arrive hours late.** The delay a Gemini batch adds (up to 24 h) is acceptable; the job computes the candidate pool at submit time, so a slow batch loses no link.
- **Selection is least-recently-swept first, 30 trends per Gemini batch, one tick an hour** (CRMA-1692). A trend's last sweep is the newest `SUBMITTED_AT` of a `COLLECTED` batch that holds it. Never-swept trends go first, ties by `HASH(TREND_ID)`. A failed or cancelled batch does not count as a sweep, so its trends lead the next tick. The cap is env `ATTRIBUTION_BATCH_CAP` (default 30) in `deploy.env`. The cycle is ceil(eligible / cap) hours: 20 h at 571 trends. A tick that leaves a trend unsubmitted whose last sweep is more than 24 h old records `BUDGET_EXHAUSTED`, the signal to raise the cap. The lifecycle tick rules (one batch in flight, collect before submit, a 6 h cancel) apply unchanged. The Scheduler entry runs at minute 30, UTC, half an hour off the lifecycle tick.
- **The candidate pool query is today's `q_candidate_signals`, unchanged:** at most 20 signals, cosine ≥ 0.35, embedded in the last 72 h, not already linked to the trend. 72 h covers the longest gap between two sweeps of one trend (a 20 h cycle plus a 6 h cancelled batch) more than twice.
- **A model is judged by the CRMA-1689 pass bar**, in the one-request shape, on one frozen snapshot of 300 eligible trends: 150 that got an `attributed` link in the last 14 days and 150 that got none. Empty-pool trends are not scored. Pro runs twice (A, B) and the candidate once. Pro self-agreement S = mean(|A∩B|/|A|, |A∩B|/|B|). The candidate passes when its precision against a Pro run is at least S − 5 points, its recall is at least S − 25 points, and at most 2% of its answers fail to parse. A signal id outside the trend's pool counts as a false link. If A and B hold fewer than 40 links together, the result is inconclusive: enlarge the snapshot, do not decide. Precision is the strict gate because a false link inflates heat and nothing removes it later.

## Decisions so far

- [Measure: the attribution agent's real cost per day](https://mcclatchy.atlassian.net/browse/CRMA-1687) — **Decided:** today's Pro tool loop costs $18.02/day ($0.0250/eval × 720); the one-request shape on a Gemini batch costs $4.91/day on Pro and $2.18/day on 3.8 Flash through 2026 ($4.35 from 2027)

- [Decide: convert the attribution agent or leave it on Pipedream](https://mcclatchy.atlassian.net/browse/CRMA-1688) — **Decided:** convert: one Cloud Run job on a Gemini batch, targeting gemini-3.8-flash behind the pass bar with Pro as fallback; CRMA-429 requires the exit and the batch alone cuts 18.02 to 4.91 USD/day

- [Decide: the pass bar for switching the attribution model](https://mcclatchy.atlassian.net/browse/CRMA-1689) — **Decided:** Flash replaces Pro when, on a stratified 300-trend snapshot in the one-request shape, precision is within 5 points of Pro's self-agreement, recall within 25 points, and at most 2% unparseable

- [Decide: the attribution job's selection and cadence](https://mcclatchy.atlassian.net/browse/CRMA-1692) — **Decided:** hourly tick at minute 30, at most 30 trends per Gemini batch, least-recently-swept first; cycle about 20 h; 72 h lookback and the pool query unchanged

## Not yet specified

- **The cut-over.** Probably copies CRMA-1674 (delete the two workflows by hand, a capped first execution, then `schedule.sh`), but it waits on the model and cadence decisions.
- **The spec.** Assembles every constraint into `docs/prd/attribution-job.md` and reports amendments back to CRMA-1644 and CRMA-429.

## Out of scope
