<!-- prd: lifecycle-job · epic: see JIRA remote link · map: CRMA-1644 -->

# PRD: The lifecycle agent as one Cloud Run job that sends a Gemini batch

Produced 2026-10-26 from wayfinder map [CRMA-1644](https://mcclatchy.atlassian.net/browse/CRMA-1644)
(`docs/wayfinder/lifecycle-cheaper-model-and-batch.md` on branch
`wayfinder/lifecycle-cheaper-model-and-batch`). Every decision below was settled on that map's
tickets; this document assembles them into one buildable spec. Where this spec makes a choice
that no ticket made, it says so in **Choices made while assembling this spec**.

Two words keep two meanings throughout. A **Cloud Run job** is the deployable (`KIND=job`,
started by Cloud Scheduler). A **Gemini batch** is one Batch API submission that holds one
request per trend. [Lifecycle status], [heat index] and [link kind] are used exactly as
`CONTEXT.md` defines them.

## Problem Statement

The lifecycle agent is about 97% of the pipeline's tracked LLM spend: $109.04 of $112.10 over
the 7 days to 2026-10-26, for 4,185 evaluations. It runs as two Pipedream workflows.
`lifecycle-agent-p_JZCz73w` sweeps every hour, picks at most 25 due trends, and fires one HTTP
call per trend at `lifecycle-subagent-p_gYC562o`. The subagent runs 7 Snowflake queries for that
one trend, then a multi-turn Gemini 3.1 Pro tool loop, then `PROC_LIFECYCLE_APPLY`.

Three problems follow from that shape:

- **It costs too much.** Every evaluation is a standard-price Pro call, and the tool loop resends
  the ~10k-token prompt on every turn. Production also under-records the cost by about 20%,
  because it leaves out thinking tokens (CRMA-1647).
- **It cannot keep up.** At 25 trends an hour the sweep evaluates about 600 trends a day. On
  2026-10-26, 452 of the 591 live trends were overdue, some by more than 2,000 hours.
- **It sits on Pipedream,** which the fleet migration map (CRMA-429) is leaving.

## Solution

One Cloud Run job, `trend-tree-lifecycle`, replaces both workflows. Cloud Scheduler starts it
every hour. Each execution is a **tick** with two halves:

1. **Collect.** If a Gemini batch is in flight and finished, the tick reads its keyed results
   and applies each decision through `PROC_LIFECYCLE_APPLY`. If the batch is still running,
   the tick does nothing more.
2. **Submit.** If no batch is in flight, the tick selects the due trends, most overdue first,
   up to 200. It builds one `generateContent` request per trend from set-based queries and
   submits them as one Gemini batch on `gemini-3.8-flash`.

No tick waits for a batch. Each request carries the prefetched context in its prompt, no tools,
and the decision schema as its `responseSchema`. The batch costs half the standard price.
CRMA-1649 measured about $2/day for this shape on Flash through 2026, against today's
$15.60/day.

Success: no live, non-RETIRED trend is more than 6 hours past its `NEXT_EVAL_AT`, at no more
than $15.60/day.

## User Stories

### Pipeline operator (Martin)

1. As the operator, I want lifecycle to run as one Cloud Run job, so that I can run it locally
   and debug it, and so that it leaves Pipedream.
2. As the operator, I want each tick to collect a finished batch before it submits a new one, so
   that no execution blocks on Google.
3. As the operator, I want at most one Gemini batch in flight, so that two batches can never
   evaluate the same trend.
4. As the operator, I want every failure to leave the trend due, so that a later tick retries it
   with no manual step.
5. As the operator, I want a batch still pending 6 hours after submit to be cancelled and its
   trends resubmitted, so that one slow batch cannot hold trends past the cadence period.
6. As the operator, I want a failed execution, or 3 hours with no completed execution, to email
   me, so that I learn about a broken job the same morning.
7. As the operator, I want a FAILED, EXPIRED or cancelled batch to be an outcome in
   `STG_AGENT_RUN_COSTS`, not an alert, so that Google's slowness does not page me.
8. As the operator, I want one `STG_AGENT_RUN_COSTS` row per batch with the true cost
   (thinking tokens included), so that the audit's cost rollup stops reading 20% low.
9. As the operator, I want a per-run cap of 200 trends per batch in `deploy.env`, so that I can
   change the cap with one env-var override and no build.
10. As the operator, I want the cut-over to be one ordered sequence with a 10-trend gate, so
    that the job and the Pipedream sweep never run together.

### Trend consumers (ATLAS, the Insights Agent)

11. As a consumer of `DT_TREND_DASHBOARD`, I want `LIFECYCLE_STATUS` and `HEAT_INDEX` to keep
    their meaning and their source table (`FCT_TREND_LIFECYCLE_LEDGER`), so that nothing
    downstream changes.
12. As a consumer, I want no live trend more than 6 hours stale, so that status and heat
    describe the trend as it is now.

### Data quality owner

13. As the data quality owner, I want the two-cycle retirement confirm to keep working, so that
    one evaluation can never retire a trend.
14. As the data quality owner, I want a retried tick never to apply one batch entry twice, so
    that a duplicate cannot count as the second retirement cycle.
15. As the data quality owner, I want the audit agent to grade YELLOW when any live trend is more
    than 6 hours past `NEXT_EVAL_AT`, so that the success test is watched every day.

## Implementation Decisions

### The model and the request shape

- **The model is `gemini-3.8-flash`** (CRMA-1648). The owner chose it although it failed two
  gates of the pass bar in the tool-loop shape (CRMA-1647). The known gaps are accepted: it can
  omit `status`, and it sets longer intervals. The prompt and the queries get adjusted after the
  switch as needed. The model is a code constant, as in every other agent here.
- **One `generateContent` request per trend** (CRMA-1649). The request carries:
  - `systemInstruction`: the rendered `lifecycle.job.system` prompt (see **The prompt
    migration**), with every prefetched context block.
  - `contents`: one user turn, built in code: "Evaluate trend `<id>`. Current status is
    `<status>`. Use the prefetched context to decide the new status, heat modifier, and any
    description update. Return your final answer as one JSON object."
  - `generationConfig`: `responseMimeType: "application/json"`, `responseSchema` =
    `propose_lifecycle_decision`'s `input_schema` from today's
    `lifecycle-subagent-p_gYC562o/run_subagent/entry.js` (copied verbatim, `required` list
    included), `maxOutputTokens` from `MODEL_PARAMS.per_call_max_tokens`, `thinkingConfig:
    { thinkingLevel }` from `MODEL_PARAMS.thinking_level`, `temperature: 1.0`.
  - No `tools`.
- **`maxOutputTokens` is at least 8192.** The job refuses to start if
  `MODEL_PARAMS.per_call_max_tokens` is below 8192.
- **An answer that does not parse as JSON gets one retry.** The retry is one standard (not
  batch) `generateContent` call with the same request. An errored batch entry gets the same
  retry. A retry that also fails leaves the trend due.

### The tick

The job's entrypoint runs one tick and exits. A tick runs these steps in order:

1. **Load config.** Read env vars and secrets. Read the active prompt rows.
2. **Find the in-flight batch.** Read the newest `STG_LIFECYCLE_BATCHES` row whose `STATE` is
   `SUBMITTED`. If there is none, go to step 5.
3. **Poll it.** `GET batches/<name>`.
   - `BATCH_STATE_PENDING` or `BATCH_STATE_RUNNING`, less than 6 h after `SUBMITTED_AT`: exit 0.
     No submit happens while a batch is in flight.
   - Still pending or running 6 h or more after `SUBMITTED_AT`: `POST batches/<name>:cancel`,
     set the row's `STATE` to `CANCELLED`, write its `STG_AGENT_RUN_COSTS` row with `STATUS =
     TIMEOUT`, and go to step 5. Its trends are still due, because nothing moved their
     `NEXT_EVAL_AT`.
   - `BATCH_STATE_FAILED` or `BATCH_STATE_EXPIRED`: set `STATE` to `FAILED`, write the cost row
     with `STATUS = ERROR`, and go to step 5.
   - `BATCH_STATE_SUCCEEDED`: go to step 4. A batch the tick cancelled also reports
     `SUCCEEDED`, with every entry `error.code` 1 (CRMA-1672); step 4 handles that.
4. **Collect.** For each inlined response, keyed by `metadata.key` = `TREND_ID`:
   - An entry with `error.code` 1 (cancelled): skip it. The trend stays due.
   - Any other errored entry, or a response that does not parse as JSON: one standard retry.
   - **Skip any trend that already has a `FCT_TREND_LIFECYCLE_LEDGER` row with `EVALUATED_AT`
     after the batch's `SUBMITTED_AT`.** This makes collect safe to re-run after a crash.
   - Build one decision object per remaining trend (the shape `PROC_LIFECYCLE_APPLY` documents)
     with `next_eval_in_hours` clamped to [6, 168] in code. Call
     `PROC_LIFECYCLE_APPLY(PARSE_JSON(:1)::ARRAY, <batch name>, TRUE)` once with all of them.
   - Set the row's `STATE` to `COLLECTED` and write its `STG_AGENT_RUN_COSTS` row.
5. **Select the due set.** The query is today's `q_select_due_trends` with `LIMIT` = the cap
   (env `LIFECYCLE_BATCH_CAP`, default 200) minus the standard retries this tick spent. If the
   due set is empty, exit 0. If more trends were due than the limit, record
   `BUDGET_EXHAUSTED` on the cost row of the batch this tick submits.
6. **Prefetch, set-based.** Run the 7 context queries once for the whole due set (see **The
   set-based queries**). Compute `heat_base` per trend in code.
7. **Build and submit.** Render one request per trend. Refuse to submit if the serialized
   payload is 20 MB or more (the inline limit); that is a tick failure. Submit with
   `POST models/gemini-3.8-flash:batchGenerateContent`, `displayName` = the tick's chain id.
8. **Record.** Insert the `STG_LIFECYCLE_BATCHES` row right after the submit call returns. Exit 0.

The job exits non-zero only when the tick itself breaks: Snowflake, the submit call, or the
collect call. A bad batch is an outcome, never a non-zero exit.

### The batch tracking table

```sql
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_LIFECYCLE_BATCHES (
  BATCH_NAME    VARCHAR(128)  NOT NULL PRIMARY KEY,  -- batches/<id> from Google
  CHAIN_ID      VARCHAR(64)   NOT NULL,              -- lcy-chain-<uuid>, also the displayName
  TREND_IDS     ARRAY         NOT NULL,
  SUBMITTED_AT  TIMESTAMP_NTZ NOT NULL,
  STATE         VARCHAR(16)   NOT NULL,              -- SUBMITTED | COLLECTED | FAILED | CANCELLED
  UPDATED_AT    TIMESTAMP_NTZ NOT NULL
);
```

The DDL lands as `sql/stg_lifecycle_batches.sql`. Nothing moves `NEXT_EVAL_AT` at submit. If the
insert in step 8 fails after a successful submit, the batch is orphaned: Google bills it, nobody
collects it, and its trends stay due for the next tick. That is the accepted cost of a rare
failure.

### Cadence, interval and cap

- **The cadence period is 6 h** (CRMA-1651). The success test is no live trend more than 6 h past
  `NEXT_EVAL_AT`.
- **The agent chooses the interval** (CRMA-1650). `next_eval_in_hours` stays in the response
  schema. The job clamps it to [6, 168] before the proc call. The proc's own [1, 168] clamp stays
  and has no effect on clamped input. No per-status floor exists.
- **The per-run cap is 200 trends per Gemini batch** (CRMA-1672), env `LIFECYCLE_BATCH_CAP` in
  `deploy.env`. Standard retries count against it. There is no USD cap. When more trends are due,
  the 200 most overdue go and the rest wait (CRMA-1633's order). At 591 live trends and a 6 h
  minimum interval, steady-state demand is about 100 trends an hour, under the cap.
- 200 requests at about 11.5k input tokens is about 2.3M enqueued tokens. That fits the Tier 1
  enqueued-token limit for 3.8 Flash (3M), which CRMA-1645 found but did not check against the
  account's tier.
- **If batches regularly take longer than about 5 h, CRMA-1651 reopens.** The two measured
  batches took 2 min 48 s and 5 min 25 s.

### The set-based queries

Today the subagent runs 7 queries per trend. The job runs each once per tick for the whole due
set. Each query becomes one statement over a `due` CTE built from the bound array of trend ids:

```sql
WITH due AS (SELECT VALUE::STRING AS TREND_ID FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:1))))
```

Each per-trend `WHERE TREND_ID = '<id>'` becomes a join to `due`, and each per-trend
`ORDER BY … LIMIT n` becomes `QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY …) <= n`.
The output columns stay the same, plus `TREND_ID` where a query did not return it. The job groups
the rows by `TREND_ID` in code.

| Query | Per-trend today | Set-based form |
|---|---|---|
| `q_metrics` | one row per trend | the latest lifecycle and enrichment rows by `QUALIFY … = 1` per trend; the counts by `GROUP BY TREND_ID` |
| `q_signal_domains` | domain counts, 21 d | the same CASE, `GROUP BY ts.TREND_ID, DOMAIN` |
| `q_lifecycle_history` | latest 5 ledger rows | `QUALIFY … <= 5` per trend |
| `q_recent_signals` | latest 30 linked signals, 14 d | `QUALIFY … <= 30` per trend |
| `q_candidate_signals` | top 20 unlinked signals, cosine ≥ 0.45, 7 d | due trend vectors × the 7 d signal pool, `NOT EXISTS` per pair, `QUALIFY … <= 20` per trend |
| `q_neighbors` | top 30 trends by cosine | due trend vectors × all enriched trends, excluding self, `QUALIFY … <= 30` per trend |
| `q_prompts` | the active prompt rows | unchanged; once per tick |

`computeHeatBase` and the context-block builders move from `run_subagent/entry.js` into
`services/lib/lifecycle_context.mjs` unchanged. They are pure functions of one trend's rows.

### The prompt migration

`DIM_LLM_PROMPT` deploys live and immediately, so the job gets its **own system prompt key**,
`lifecycle.job.system` version 1. The rubric key `lifecycle.subagent.decision_rubric` stays
shared, because no edit touches it.

`sql/update_prompts_lifecycle_job_v1.sql` follows the v7 migration's pattern. It inserts
`lifecycle.job.system` v1 as a surgical `REPLACE` over the **live** `lifecycle.subagent.system`
template, guarded by one `CONTAINS` per replaced string, so a drifted source inserts nothing.
The replacements are the prototype's (`docs/wayfinder/assets/crma-1647/oneshot.mjs`, `EDITS`
plus `RETIRE_NOTE`):

| From | To |
|---|---|
| `emitting one structured decision via \`propose_lifecycle_decision\`` | `returning one structured JSON decision` |
| ` The in-process query tools just slice and filter that prefetched data.` | (removed) |
| the `═══ AVAILABLE TOOLS ═══` section, up to `═══ THE DECISION YOU MUST MAKE ═══` | (removed) |
| `Output via \`propose_lifecycle_decision\`:` | `Output one JSON object:` |
| `Use query tools if you want to slice it differently. ` | (removed) |
| `Then call \`propose_lifecycle_decision\` exactly once with your final answer.` | `Then return your final answer as one JSON object.` |
| `Otherwise this is the first proposal and the trend stays DORMANT/DECLINING for now.` | `Otherwise this is the first proposal. Still return \`status: RETIRED\`: the commit step records it as the first proposal and keeps the trend DORMANT/DECLINING for now. Returning DORMANT records no proposal.` |

The row sets `MODEL = 'gemini-3.8-flash'` and copies `MODEL_PARAMS` with `per_call_max_tokens`
set to 8192. The same commit adds `('lifecycle.job.system', 1)` to both copies (`sql.value`
and `sql.query`) of the manifest in `audit-agent-p_xMC9nm3/workflow.yaml`'s `q_prompt_drift`
step. The job also refuses to start if the rendered prompt still contains
`propose_lifecycle_decision` or `query_trend_`, `query_signal_` or `query_lifecycle_`.

### What the job writes

- **`FCT_TREND_LIFECYCLE_LEDGER`, through `PROC_LIFECYCLE_APPLY` only.** The proc stays
  unchanged. Each decision object carries `chain_id` = the batch name, `agent_session_id` =
  `lcy-sess-<uuid>`, `heat_base`, `lifecycle_decision` (the parsed JSON), `llm_token_usage`,
  `llm_cost_estimate` and `agent_telemetry: { model, turns: 1, stop_reason: <finishReason>,
  tool_call_count: 0 }`.
- **Per-entry cost includes thinking tokens:** `promptTokenCount` × input rate +
  (`candidatesTokenCount` + `thoughtsTokenCount`) × output rate, at batch rates for a batch entry
  and standard rates for a retry. This is the harness's `cost_with_thinking`.
- **`STG_AGENT_RUN_COSTS`, one row per batch** (CRMA-1672). `RUN_ID` = the batch name,
  `CHAIN_ID` = the tick's chain id, `WORKFLOW_NAME = 'trend-tree-lifecycle'`, `MODEL`, token sums
  over every entry plus its retries, `TURN_COUNT` = entries, `TOOL_CALL_COUNT = 0`, `COST_USD` =
  the sum of the per-entry costs. `STATUS` takes the first match: `ERROR` (FAILED or EXPIRED),
  `TIMEOUT` (the tick cancelled it), `BUDGET_EXHAUSTED` (the cap cut the due set), `OK`.
  Per-entry failures go in `ERROR_MESSAGE`, truncated to 2,000 characters.
- `REQUESTED_RE_ENRICHMENT` is recorded as today. Nothing reads it today, and the job adds no
  consumer.

### The deployable

`services/lifecycle/`, a copy of the `tiktok-ingest` layout:

- `tick.mjs` (entrypoint), `config.mjs`, `snowflake.mjs`, `Dockerfile` (build context is the
  repo root), `package.json` + lock.
- `services/lib/gemini_batch.mjs`: submit, get, cancel, and one standard `generateContent`,
  direct `fetch()` with no SDK, on the `GEMINI_API_KEY` secret.
- `services/lib/lifecycle_context.mjs`: the set-based queries, `computeHeatBase`, the block
  builders, prompt rendering, the [6, 168] clamp, and decision building.
- `deploy.env`: `KIND=job`, `SERVICE=trend-tree-lifecycle`, `ENTRYPOINT=tick.mjs`,
  `MAX_RETRIES=1` (CRMA-535), `TIMEOUT=1500`, `CPU=1`, `MEMORY=512Mi`,
  `LIFECYCLE_BATCH_CAP=200`, the Snowflake env vars, and `SECRETS` =
  `snowflake-private-key` and `generic-gemini-api-key`, as `tiktok-ingest` has them.
- `schedule.sh`: a copy of `tiktok-ingest`'s, job name `trend-tree-lifecycle-hourly`,
  schedule `0 * * * *`, time zone UTC.
- `alert-policy.json` (CRMA-1672, CRMA-535): Harbor's shape, OR-combining two conditions — an
  execution of `trend-tree-lifecycle` with `result=failed`, and no completed execution for 3 h.
  The email channel "Trend Tree alerts: mmena@mcclatchy.com", `autoClose` 24 h, a
  `documentation` field pointing at the runbook line in `services/lifecycle/README.md`. No rate
  condition. `services/deploy.sh` does not apply alert policies yet (CRMA-535 is not built), so
  the first deploy applies it once with `gcloud monitoring policies create --policy-from-file`.

### The audit agent's outcome check

`audit-agent-p_xMC9nm3` gets one new row in its freshness prefetch: the count of live,
non-RETIRED trends more than 6 h past `NEXT_EVAL_AT`, using the due query's
`COALESCE(NEXT_EVAL_AT, PROMOTED_AT + 24 h)`. Any count above zero grades YELLOW. The existing
`lifecycle_24h` and `lifecycle_1h` rows stay.

### Cut-over

The cut-over is a guaranteed migration with no rollback and no window (CRMA-1674). It amends
CRMA-444 for lifecycle.

0. **Before:** the code, the DDL, the prompt migration and the audit check are merged and
   applied. `services/deploy.sh lifecycle --no-execute` deploys the job, and the alert policy is
   applied. No `schedule.sh` has run, so the job never runs beside the Pipedream sweep. The job
   has no off switch in code.
1. A person deletes `lifecycle-agent-p_JZCz73w` and `lifecycle-subagent-p_gYC562o` in Pipedream
   by hand.
2. One execution with `--update-env-vars LIFECYCLE_BATCH_CAP=10` submits a 10-trend batch. When
   the batch finishes, one more execution collects it. It must land 10 ledger rows and one `OK`
   `STG_AGENT_RUN_COSTS` row. A failure here is fixed forward.
3. `services/lifecycle/schedule.sh` creates the hourly entry.
4. One commit deletes both workflow directories and their two `WORKFLOW_REGISTRY` lines in
   `audit-agent-p_xMC9nm3/fetch_pipedream_errors/entry.js`.

A failure after cut-over is fixed forward, signalled by the alert policy and the audit's 6 h
overdue check. The cut-over does not wait for the Pipedream `gemini-3.8-flash` switch
(CRMA-1648).

### Suggested story order for `/to-tickets`

1. The Pipedream model switch to `gemini-3.8-flash` (CRMA-1648) — independent, can ship first.
2. `services/lib/lifecycle_context.mjs`: the set-based queries and the pure functions, with the
   parity test.
3. The prompt migration and the manifest bump.
4. `services/lib/gemini_batch.mjs` and `services/lifecycle/` (tick, DDL, deploy.env,
   schedule.sh, alert-policy.json, README).
5. The audit's 6 h overdue check.
6. The cut-over (a `ready-for-human` story).

## Testing Decisions

- **Unit tests in `scripts/test_services_lib.sh`** for the pure functions: `computeHeatBase`
  against hand-built fixtures that cover each factor; the [6, 168] clamp; decision
  building; cost with thinking; the tick's state machine over a fake Gemini client and a fake
  Snowflake client (pending, pending past 6 h, FAILED, EXPIRED, SUCCEEDED with code-1 entries,
  SUCCEEDED with a non-JSON entry, a collect re-run after a crash).
- **Parity test for the set-based queries.** For 20 due trends, render the system prompt from
  today's per-trend queries and from the set-based queries, in the same minute. The two must
  match character for character. This proves the port, not the model.
- **The re-collect test is mandatory.** Run collect twice over one finished batch. The second
  run must write zero ledger rows. A duplicate row would satisfy the two-cycle retirement
  confirm in one cycle.
- **The model is not re-gated.** CRMA-1648 accepted Flash without a re-run. The pass bar
  (CRMA-1646) and the frozen snapshot (`docs/wayfinder/assets/crma-1647/`) stay as the yardstick
  for any later request shape.
- **Production proof is the cut-over gate:** 10 ledger rows and one `OK` cost row for the
  10-trend batch, checked by querying the tables, not by reading job logs.

## Out of Scope

- **lifecycle-attribution** (`lifecycle-attribution-agent-p_KwCoaap` + subagent). It records no
  cost, and CRMA-1459 is changing its sweep. It can copy this spec later.
- **Changing the heat formula** (ruled out in CRMA-1633).
- **A consumer for `REQUESTED_RE_ENRICHMENT`.** No code fires a re-enrichment today, and the
  ledger column's comment ("TRUE if commit step POSTed to enrichment") is wrong.
- **A Files API (JSONL) submit path.** The cap keeps the inline payload near 9 MB.
- **A poison-trend guard** (CRMA-1651).
- **An `IS_SHADOW` column or any shadow mode.** The comparison ran offline.

## Choices made while assembling this spec

No ticket decided these. Each is the smallest choice that honours the decisions above. Change
any of them in review.

1. **A new prompt key, not version 8 of `lifecycle.subagent.system`.** The table deploys live.
   A v8 without the tool wording would break the running Pipedream tool loop before cut-over,
   and the Pipedream Flash switch (CRMA-1648) may bump that same key.
2. **The [6, 168] clamp lives in job code, not in the proc.** It needs no SQL deploy, and the
   proc's [1, 168] clamp has no effect on clamped input.
3. **Collect skips trends with a ledger row newer than the batch's submit time.** The job
   retries once (`MAX_RETRIES=1`), and without this rule a retried collect applies a batch
   twice.
4. **`TIMEOUT=1500`.** With one retry, two attempts end inside the hour, so a retried tick
   cannot overlap the next tick.
5. **The ledger's `CHAIN_ID` is the batch name,** the same value as the cost row's `RUN_ID`, so
   ledger rows join their batch.
6. **The cut-over applies the alert policy by hand,** because `services/deploy.sh` does not
   apply policies until CRMA-535 is built.

## Further Notes

- Pricing for 3.8 Flash doubles on 2027-01-01 (CRMA-1645). The one-request shape still lands
  near $4/day.
- This spec amends five CRMA-429 constraints for lifecycle: the lead + subagent pair runs as a
  Gemini batch, not an in-process worker pool (CRMA-536); the cut-over has no rollback window
  (CRMA-444); it writes one cost row per batch, not per run, and adds a 3 h absence condition
  (CRMA-535); it is a batch Job, not an agent-loop scaling posture (CRMA-496); and its
  runaway guard is the 200-trend cap, with no `budget_usd` and no rate alert (CRMA-497).
  "Report this map's amendments back to the fleet migration map" (CRMA-1653) wrote these into
  the CRMA-429 map file and commented them on CRMA-429 and CRMA-537.
