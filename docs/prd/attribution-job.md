<!-- prd: attribution-job · map: CRMA-1686 -->

# PRD: The attribution agent as one Cloud Run job that sends a Gemini batch

Produced 2026-11-13 from wayfinder map [CRMA-1686](https://mcclatchy.atlassian.net/browse/CRMA-1686)
(`docs/wayfinder/attribution-batch-job.md` on branch `wayfinder/attribution-batch-job`). Every
decision below was settled on that map's tickets. The map's own constraints and every constraint of
the lifecycle map (CRMA-1644, spec `docs/prd/lifecycle-job.md` on branch
`wayfinder/lifecycle-cheaper-model-and-batch`) apply, except where this spec says otherwise. Where
this spec makes a choice that no ticket made, it says so in **Choices made while assembling this
spec**.

A **Cloud Run job** is the deployable. A **Gemini batch** is one Batch API submission that holds
one request per trend. A **sweep** of a trend is one evaluation of its candidate pool. A **cycle**
is the time the job takes to sweep every eligible trend once.

## Problem Statement

The attribution agent links newly arrived signals to live trends. It runs as two Pipedream
workflows. `lifecycle-attribution-agent-p_KwCoaap` sweeps every hour, picks 30 trends from a
hash round-robin, and fires one HTTP call per trend at `lifecycle-attribution-subagent-p_PACe77B`.
The subagent fetches the trend's candidate pool, runs a `gemini-3.1-pro-preview` tool loop, and
inserts the confirmed links into `FCT_TREND_SIGNALS`.

- **It costs too much for what it does.** The tool loop costs $0.0250 per eval, $18.02/day
  (CRMA-1687). Its two tools do no work, and its closing turn resends the whole prompt.
- **It records no cost.** It writes no `STG_AGENT_RUN_COSTS` row (CRMA-725).
- **It sits on Pipedream,** which the fleet migration map (CRMA-429) is leaving.
- **It writes ids it never checked** against the pool it was given (CRMA-1461).

## Solution

One Cloud Run job, `trend-tree-attribution`, replaces both workflows. Cloud Scheduler starts it
every hour at minute 30, UTC. Each execution is one **tick**: collect the finished Gemini batch,
then submit the next 30 trends, least recently swept first. Each request is one
`generateContent` call with the candidate pool in its prompt, no tools, and
`commit_attributions`' schema as its `responseSchema`. The batch costs half the standard price.

Success: no eligible trend goes longer than one cycle (about 20 h) between sweeps, at less than
today's $18.02/day. CRMA-1687 priced this shape at $2.18/day on `gemini-3.8-flash` through 2026
and $4.91/day on Pro.

## User Stories

1. As the operator, I want attribution to run as one Cloud Run job, so that it leaves Pipedream
   and I can run it locally.
2. As the operator, I want each tick to collect a finished batch before it submits a new one,
   and at most one batch in flight, so that no execution blocks on Google and no trend is swept
   twice at once.
3. As the operator, I want a failed or cancelled batch to leave its trends first in line, so that
   the next tick sweeps them with no manual step.
4. As the operator, I want one `STG_AGENT_RUN_COSTS` row per batch with the true cost (thinking
   tokens included), so that attribution's spend is finally visible.
5. As the operator, I want the cap in `deploy.env`, and a `BUDGET_EXHAUSTED` status when the cap
   leaves a trend more than 24 h unswept, so that I know when to raise it.
6. As the operator, I want a failed execution, or 3 hours with no completed execution, to email
   me.
7. As a consumer of `FCT_TREND_SIGNALS`, I want `attributed` links to keep their shape
   (`LINK_KIND = 'attributed'`, the same `LINK_TYPE` values), so that nothing downstream changes.
8. As the data quality owner, I want no link to a signal outside the trend's pool, and no link
   twice, so that a model error cannot inflate heat.

## Implementation Decisions

### The model

- **`JOB_MODEL` is the model CRMA-1691 chose**, a code constant in
  `services/lib/attribution_context.mjs`, as in every other agent here. The map's constraint:
  `gemini-3.8-flash` if it passes the CRMA-1689 pass bar on the CRMA-1690 comparison,
  `gemini-3.1-pro-preview` if it fails. The conversion does not wait for the model.
- Per-entry cost uses that model's rates: Flash $0.75 / $3.75 per million (input / output),
  doubling on 2027-01-01; Pro $2.00 / $12.00. A batch entry bills half. Output includes
  thinking tokens.

### The request

One `generateContent` request per trend with a non-empty pool, `metadata.key` = `TREND_ID`:

- `systemInstruction`: the rendered `signal.attribution.job.system` prompt (see **The prompt
  migration**) with `trend_block`, `candidate_signals_block`, `similarity_threshold` = `0.35`, and
  `attribution_rubric` = the `signal.attribution.rubric` template. The two blocks are built
  exactly as `run_subagent/entry.js` builds them today.
- `contents`: one user turn: "Evaluate `<n>` candidate signals for trend `<id>` ("`<topic>`").
  Apply the attribution rubric to each candidate. Return the confirmed list as one JSON object
  (an empty array is a valid outcome)."
- `generationConfig`: `responseMimeType: "application/json"`, `responseSchema` =
  `commit_attributions`' `input_schema` copied verbatim from `run_subagent/entry.js`,
  `maxOutputTokens` = `MODEL_PARAMS.per_call_max_tokens`, `thinkingConfig: { thinkingLevel }`
  from `MODEL_PARAMS.thinking_level`, `temperature: 1.0`. No `tools`.
- The job refuses to start if `per_call_max_tokens` is below 8192, or if the rendered prompt
  still contains `commit_attributions` or `filter_candidates`.

### Selection

- **Eligible** is today's rule: a `FCT_TRENDS` row with an enrichment `TREND_VECTOR`, latest
  lifecycle status not `RETIRED` or `DORMANT` (no lifecycle row reads as `NEW`).
- **Order: least recently swept first** (CRMA-1692). A trend's last sweep is the newest
  `SUBMITTED_AT` of a `COLLECTED` row in `STG_ATTRIBUTION_BATCHES` whose `TREND_IDS` holds it.
  Never-swept trends go first; ties by `HASH(TREND_ID)`. This is last *sweep*, not last
  *attribution*: every swept trend gets one, so the starvation CRMA-1459 fixed cannot return.
- **The cap** is env `ATTRIBUTION_BATCH_CAP`, default 30, standard retries counted against it.
- **`BUDGET_EXHAUSTED`**: the tick leaves unsubmitted at least one eligible trend that was never
  swept or was last swept more than 24 h ago. Until the first cycle completes after cut-over,
  every batch reports it, because every trend starts never-swept.

### The tick

1. **Load config and prompts.** Refuse a bad prompt (see **The request**).
2. **Find the in-flight batch:** the newest `STG_ATTRIBUTION_BATCHES` row with `STATE =
   'SUBMITTED'`. None: go to step 5.
3. **Poll it**, with lifecycle's rules unchanged: pending or running under 6 h, exit 0; pending
   or running 6 h or more, cancel it, `STATE = CANCELLED`, cost row `TIMEOUT`; `FAILED` or
   `EXPIRED`, `STATE = FAILED`, cost row `ERROR`; a `SUCCEEDED` batch whose every entry has
   `error.code` 1, `STATE = CANCELLED`, cost row `TIMEOUT`; `SUCCEEDED`, step 4.
4. **Collect.** For each entry, keyed by `metadata.key`:
   - `error.code` 1: skip.
   - Any other error, or a response that is not JSON with an `attributions` array: one
     standard `generateContent` retry, rebuilt from the batch row's stored pool. A failed retry
     drops that trend's answer and logs it in `ERROR_MESSAGE`.
   - Keep only `{ signal_id, link_type }` pairs whose `signal_id` is in that trend's stored pool
     (`POOLS`) and whose `link_type` is one of `news | social | commerce | other`. Drop
     repeats. Count the dropped ids in `ERROR_MESSAGE` (CRMA-1461).
   - Insert every kept link with one statement (see **What the job writes**).
   - `STATE = COLLECTED`, then the cost row.
5. **Select** up to `cap − retries` eligible trends in sweep order, plus one more row to set
   `BUDGET_EXHAUSTED`.
6. **Prefetch, set-based:** `trend_context`, `existing_source_types` and `candidate_signals`,
   one statement each over the selected ids (see **The set-based queries**).
7. **Build and submit** one request per trend with a non-empty pool. Refuse a payload of 20 MB
   or more. `displayName` = the tick's chain id, `atr-chain-<uuid>`.
8. **Record** the `STG_ATTRIBUTION_BATCHES` row right after submit returns. Its `TREND_IDS` holds
   **every selected trend**, empty pools included, so an empty-pool trend counts as swept when
   the batch is collected. If no selected trend has a pool, the tick submits nothing and inserts
   the row as `none-<chain id>` with `STATE = COLLECTED`.

The job exits non-zero only when the tick breaks: Snowflake, the submit call, or the poll call.

### The batch tracking table

```sql
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ATTRIBUTION_BATCHES (
  BATCH_NAME       VARCHAR(128)  NOT NULL PRIMARY KEY,  -- batches/<id>, or none-<chain id>
  CHAIN_ID         VARCHAR(64)   NOT NULL,              -- atr-chain-<uuid>, also the displayName
  TREND_IDS        ARRAY         NOT NULL,              -- every selected trend, empty pools included
  POOLS            VARIANT       NOT NULL,              -- {trend_id: [candidate rows]} at submit
  BUDGET_EXHAUSTED BOOLEAN,
  SUBMITTED_AT     TIMESTAMP_NTZ NOT NULL,
  STATE            VARCHAR(16)   NOT NULL,              -- SUBMITTED | COLLECTED | FAILED | CANCELLED
  UPDATED_AT       TIMESTAMP_NTZ NOT NULL
);
```

`POOLS` holds each trend's candidate rows (id, source, timestamp, title, text, similarity). It
serves the collect filter and rebuilds a retry's request without re-reading a pool that has since
changed. At 30 trends × 20 candidates of about 600 bytes, a row is under 400 KB.

### The set-based queries

Each per-trend step becomes one statement over
`WITH ids AS (SELECT VALUE::STRING AS TREND_ID FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:1))))`.
`q_trend_context` takes the latest enrichment row per trend by `QUALIFY`; `q_existing_signal_sources`
groups by `TREND_ID, LINK_TYPE`; `q_candidate_signals` crosses each trend's latest `TREND_VECTOR`
with the 72 h signal pool, keeps `NOT EXISTS` per pair and `SIMILARITY >= 0.35`, and takes
`QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY SIMILARITY DESC) <= 20`. Output
columns stay the same, plus `TREND_ID`.

### What the job writes

- **`FCT_TREND_SIGNALS`**, one statement per collect:

  ```sql
  INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS (TREND_ID, SIGNAL_ID, LINK_KIND, LINK_TYPE)
  SELECT DISTINCT f.value:trend_id::STRING, f.value:signal_id::STRING, 'attributed', f.value:link_type::STRING
  FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f
  WHERE NOT EXISTS (SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
                    WHERE x.TREND_ID = f.value:trend_id::STRING AND x.SIGNAL_ID = f.value:signal_id::STRING)
  ```

  The `NOT EXISTS` guard is today's. It also makes a re-run collect write nothing twice, so the
  job needs no "already applied" check.
- **`STG_AGENT_RUN_COSTS`, one row per batch**: `RUN_ID` = the batch name, `WORKFLOW_NAME =
  'trend-tree-attribution'`, `MODEL`, token sums over every entry and retry, `TURN_COUNT` =
  entries, `TOOL_CALL_COUNT = 0`, `COST_USD` = the sum of per-entry costs. `STATUS` takes the
  first match: `ERROR`, `TIMEOUT`, `BUDGET_EXHAUSTED`, `OK`. Per-entry problems go in
  `ERROR_MESSAGE`, truncated to 2,000 characters. The `none-` row writes no cost row.

### The prompt migration

`sql/update_prompts_attribution_job_v1.sql` inserts `signal.attribution.job.system` v1 as a
surgical `REPLACE` over the live `signal.attribution.system` v1, one `CONTAINS` guard per
replaced string, re-runnable by `NOT EXISTS`. The replacements are the CRMA-1687 harness's
`EDITS`:

| From | To |
|---|---|
| the `═══ AVAILABLE TOOLS ═══` section, up to `═══ ATTRIBUTION RUBRIC ═══` | (removed) |
| ``Call `commit_attributions` exactly once with the confirmed list. Pass an empty array if nothing qualifies`` | ``Return one JSON object whose `attributions` array holds the confirmed { signal_id, link_type } pairs. link_type must be one of: news \| social \| commerce \| other. Return an empty array if nothing qualifies`` |
| ` — and commit those links so` | ` — so` |

`MODEL` = `JOB_MODEL`; `MODEL_PARAMS` copied with `per_call_max_tokens` = 8192. The rubric key
`signal.attribution.rubric` stays shared. The same commit adds `('signal.attribution.job.system',
1)` to both copies of the manifest in `audit-agent-p_xMC9nm3/workflow.yaml`'s `q_prompt_drift`.

### The deployable

`services/attribution/`, a copy of `services/lifecycle/`: `tick.mjs`, `config.mjs`,
`snowflake.mjs`, `Dockerfile`, `package.json` + lock, `deploy.env` (`KIND=job`,
`SERVICE=trend-tree-attribution`, `ENTRYPOINT=tick.mjs`, `MAX_RETRIES=1`, `TIMEOUT=1500`, `CPU=1`,
`MEMORY=512Mi`, `ATTRIBUTION_BATCH_CAP=30`, the same Snowflake env and secrets), `schedule.sh`
(`trend-tree-attribution-hourly`, `30 * * * *`, UTC), `alert-policy.json` (failed execution, or
no completed execution for 3 h), `README.md`. The logic lives in
`services/lib/attribution_context.mjs` (pure: queries, blocks, request, filter, cost) and
`services/lib/attribution_tick.mjs` (the state machine, I/O injected). It reuses
`services/lib/gemini_batch.mjs` unchanged.

### Cut-over

The lifecycle cut-over (CRMA-1674), with attribution's names:

0. **Before:** the code, the DDL and the prompt migration are merged and applied, and
   `services/deploy.sh attribution --no-execute` deployed the job. No `schedule.sh` has run.
1. A person deletes `lifecycle-attribution-agent-p_KwCoaap` and
   `lifecycle-attribution-subagent-p_PACe77B` in Pipedream by hand.
2. One execution with `--update-env-vars ATTRIBUTION_BATCH_CAP=10` submits a 10-trend batch. One
   more execution collects it. It must leave one `COLLECTED` batch row and one
   `STG_AGENT_RUN_COSTS` row with `STATUS` `OK` or `BUDGET_EXHAUSTED`, with links checked in
   `FCT_TREND_SIGNALS` by `LINKED_AT`. A failure here is fixed forward.
3. `services/attribution/schedule.sh` creates the hourly entry, and the alert policy is applied.
4. One commit deletes both workflow directories and their two `WORKFLOW_REGISTRY` lines in
   `audit-agent-p_xMC9nm3/fetch_pipedream_errors/entry.js`, and updates `CLAUDE.md`.

## Testing Decisions

- **Unit tests in `scripts/test_services_lib.sh`:** the pool filter (off-pool id, bad
  `link_type`, repeat), cost per model with thinking, request building, block rendering against
  a copy of `entry.js`'s output, and the tick's state machine over fakes: pending, pending past
  6 h, FAILED, all-cancelled, SUCCEEDED with a non-JSON entry, an all-empty-pool selection, and a
  collect run twice.
- **Parity check before cut-over:** for 20 eligible trends, render the system prompt from the
  set-based queries and from today's per-trend queries in the same minute. They must match
  character for character.
- **The model is gated once, offline** (CRMA-1690), not in production.

## Out of Scope

- A shadow mode or an `IS_SHADOW` column.
- A Files API (JSONL) submit path: 30 requests are about 0.5 MB.
- Changing the rubric, the 0.35 threshold, the 20-candidate limit or the 72 h lookback.
- An audit-agent check on sweep age. The cost row's `BUDGET_EXHAUSTED` and the alert policy
  cover the success test.

## Choices made while assembling this spec

1. **A new prompt key, `signal.attribution.job.system`,** not v2 of the live key, so the running
   Pipedream loop keeps its tool wording until the cut-over. This is the lifecycle choice.
2. **`POOLS` on the batch row,** so collect can drop off-pool ids and rebuild a retry without
   re-reading a pool that changed after submit.
3. **Every selected trend goes in `TREND_IDS`,** empty pools included, and an all-empty selection
   writes a `none-` row, so an empty-pool trend never stays first in line forever.
4. **No "already applied" check:** the insert's `NOT EXISTS` guard makes a re-run collect safe.
5. **Minute 30,** half an hour off the lifecycle tick.
6. **No audit-agent change** beyond the cut-over's registry lines.

## Further Notes

- This spec amends the lifecycle spec only in names, the selection rule, the cap and the
  minute. It amends CRMA-429 exactly as the lifecycle spec did (CRMA-536, CRMA-444, CRMA-535,
  CRMA-496, CRMA-497), with a 30-trend cap as the runaway guard.
