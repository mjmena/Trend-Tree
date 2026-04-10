# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A GitHub-synced Pipedream project. Each top-level directory is one Pipedream workflow. Currently the only workflow is `llm-enrichment-p_YyC86Zo`. Pipedream watches this repo and redeploys workflows when commits land on `production`. Editing a step file here, committing, and pushing is the correct way to change workflow behavior — do **not** edit in the Pipedream UI if you can avoid it, because the next sync will overwrite manual changes.

- Pipedream workspace (`org_id`): `o_qOIvyEa` (mcclatchy)
- Project: `proj_x9sLmqO` ("Trend Tree")
- Snowflake connected account used for all queries: `apn_yghdQYJ` (`CRMBOT_SERVICE_USER`)
- VPC network required to reach Snowflake: `net_5Lnie3` (Pipedream side); the `CRMBOT_SERVICE_USER` + this network's egress IPs are allowlisted on the Snowflake side

## The LLM Enrichment workflow

- Workflow id: `p_YyC86Zo`, HTTP trigger id `hi_vmHK662`, endpoint `https://eod25mq0qt8tk4q.m.pipedream.net`
- Input contract: `POST { "trend_id": "<uuid>" }` — nothing else. Every other piece of data is read from Snowflake using the `trend_id`.
- Output contract: synchronous JSON via `$.respond()` in the final step — the response body contains `enrich_context`, all four specialist outputs, the Claude synthesis, models used, token totals, and cost estimate. (Requires the trigger's "Return a custom response" toggle to be **on**; this toggle is not exposed in the Pipedream REST API and can only be set in the UI.)
- Read-only on Snowflake. This workflow does not write `DIM_TREND_ENRICHMENT`, `FCT_TREND_ENRICHMENT_HISTORY`, or update `STG_ENRICHMENT_QUEUE` — that's out of scope. See "Where this sits in the bigger picture" below.

### Step chain

```
POST /  (hi_vmHK662)
  ├─ query_metrics        snowflake-execute-sql-query@0.2.3  → FCT_TREND_METRICS row
  ├─ query_queue          snowflake-execute-sql-query@0.2.3  → latest STG_ENRICHMENT_QUEUE row (for ENRICHMENT_TYPE)
  ├─ query_signals        snowflake-execute-sql-query@0.2.3  → top 10 STG_TREND_SIGNALS by pagerank
  ├─ query_sources        snowflake-execute-sql-query@0.2.3  → all FCT_TREND_SOURCE_METRICS rows
  ├─ build_llm_context    custom code  → assembles enrich_context (no DB access)
  ├─ enrich_llm_gemini    custom code  → Gemini 2.5 Flash  (validation + categorization)
  ├─ enrich_llm_grok      custom code  → Grok 3 Mini Fast  (cultural context)
  ├─ enrich_llm_chatgpt   custom code  → GPT-4o-mini       (content strategy + STEPPS)
  ├─ enrich_llm_claude    custom code  → Claude Sonnet 4.6 (synthesizer)
  └─ return_llm_output    custom code  → $.respond() with full payload
```

### Enrichment-type gating (important)

All four LLM steps early-return `null` unless `enrich_context.enrichment_type === "FULL"`. The type comes from `STG_ENRICHMENT_QUEUE.ENRICHMENT_TYPE` (`FULL` | `SOURCES_ONLY` | `REFRESH`), falling back to `"FULL"` if there is no queue row. A `SOURCES_ONLY` run still succeeds HTTP-200 with a valid `enrich_context`, zero tokens, and all four LLM outputs set to `null` — this is correct behavior, not a bug.

### Claude validity gate

`enrich_llm_claude` has a cost-saving gate: if Gemini says `is_valid_trend=false` with `confidence >= 0.8` **and** `source_coverage <= 2`, it skips the Claude API call entirely and returns a minimal response with `_gated: true`. `return_llm_output` surfaces this as `gated: true` in the top-level response body.

## Where this sits in the bigger picture

This workflow is step 3 of a planned 4-step orchestrator:

1. SQL trigger / dispatcher (Snowflake-side task populates `STG_ENRICHMENT_QUEUE`)
2. Real sources workflow (with callback) — writes `FCT_TREND_SOURCE_METRICS`
3. **LLM workflow (this one, with callback)** — reads source metrics, produces LLM profile
4. Write-to-Snowflake workflow — persists `DIM_TREND_ENRICHMENT` + `FCT_TREND_ENRICHMENT_HISTORY`, marks queue `COMPLETED`

The legacy monolithic version of this pipeline still lives at `/home/marty/dev/trends-sql/pipedream/enrichment/` (copy-pasted into Pipedream manually, polling trigger, all steps in one workflow). **Do not modify those files** — they are still running in production as the current enrichment path. This repo is the replacement; the cutover happens when the orchestrator exists.

Related repos on this machine:
- `/home/marty/dev/trends-sql` — Snowflake DDL (`sql/`), SQL procedures (`PROC_*`), tasks (`TASK_*`), tables, views, docs (`schema.md`, `docs/enrichment-flow.md`), and the current manual Pipedream step files under `pipedream/enrichment/`. This is the authoritative source for the data model and the prompt/schema shapes the LLM steps use.
- `/home/marty/dev/CRM-Proof-Pipeline` — other GitHub-synced Pipedream workflows for the same workspace; useful as a reference for working patterns (see "Pipedream gotchas" below).

## Pipedream gotchas (learned the hard way)

These are non-obvious and will waste time if forgotten:

1. **Do not use `this.snowflake.executeQuery` in a custom code step.** It looks like it should work (the pattern exists in `trends-sql/pipedream/enrichment/enrich_trend.mjs`) but fails in GitHub-synced workflows with a generic `"Error contacting database"` from Pipedream's SQL proxy. The only pattern that works in this workspace is the registry action `snowflake-execute-sql-query@0.2.3`. If you need N Snowflake reads, declare N action steps and have one downstream custom step read all their `$return_value`s. See the `query_*` steps in `workflow.yaml` for the shape.

2. **Custom code steps must use `defineComponent({ ... })`.** Plain `export default { name, props, run }` style (what the `trends-sql` manual workflow uses) silently breaks wiring in GitHub-synced workflows. Always wrap with `export default defineComponent({ ... })`.

3. **`network: net_5Lnie3` is required** in the workflow's `settings:` block for any Snowflake-touching workflow. Without it, the SQL proxy fails the TCP connection ~500ms in because the egress IP isn't allowlisted. All working Snowflake workflows in `CRM-Proof-Pipeline` set this.

4. **`authProvisionId` fields are owned by Pipedream, not you.** When you first commit a new step that declares an app prop, leave the `authProvisionId` out of `workflow.yaml` entirely. On first sync the workflow shows up unconfigured in the UI; the user connects the account, and the next sync writes the `authProvisionId` back into `workflow.yaml` — which you then pull. Do not hand-author these IDs.

5. **Settings-only commits may not trigger a fresh deploy.** Code changes reliably kick off a rebuild; pure `workflow.yaml` settings changes sometimes don't. If a settings change doesn't seem to take effect, call `PUT /v1/workflows/{id}` with `{"org_id":"o_qOIvyEa","active":true}` to force a redeploy cycle.

6. **HTTP trigger `custom_response` is write-once at creation time.** If `$.respond()` calls are no-ops and the endpoint returns the default `<p><b>Success!</b></p>` HTML, it's because the HTTP trigger's `custom_response` flag is `false`. The internal prop name is `responseType: "customResponse"` (vs `"staticResponse"`). The only reliable way to get it set is to create the workflow from the **HTTP Template** in the Pipedream UI — the template has `responseType: customResponse` baked in, so the new workflow's trigger comes up with `custom_response: true` from the start. `PUT /v1/workflows/{id}` with a `triggers` array containing this prop returns 200 but silently ignores the update. `responseType` in `workflow.yaml` also does nothing — existing working examples (`email-test-api`, `braze-render` in `/home/marty/dev/CRM-Proof-Pipeline/`) have trigger blocks of just `- id: hi_xxx` with no props, and their `custom_response` state lives in Pipedream's trigger record, not the YAML. To flip it on an existing workflow: click the trigger card in the UI → toggle "Return a custom response" → deploy.

7. **GitHub sync is one-way for workflow lifecycle.** You cannot create a new workflow by committing a new directory to the repo — Pipedream silently ignores it. Workflows must be created **on the Pipedream side** first (UI → "New workflow" or "Use Template"), after which sync writes a `name-p_XXXXXXX/` directory into the repo via a `dev-mmena-XXXXXX` branch → merge-to-production flow. From then on, editing the synced files and pushing works in both directions. The corollary is that `POST /v1/workflows` against a GitHub-synced project (e.g. `proj_x9sLmqO`) returns 404 `record not found`, while the same call against a non-synced project (e.g. `proj_JPsbE19` MCC Commissions) returns 200 and creates the workflow. The `tch_WafZaL` template_id shown in the Pipedream UI's "Instantiate via API" dialog cannot be resolved by user API keys either. There is also no `DELETE /v1/workflows/{id}` — deactivate via `PUT` with `{"active": false}` and delete in the UI.

8. **Practical workflow for adding a new workflow to Trend-Tree:** (1) in Pipedream UI, click **New** in the Trend Tree project, pick **HTTP Template** so `custom_response` is pre-set; (2) wait ~30-60s for sync to write the new directory; (3) `git pull`; (4) rename the directory + update `settings.name` in `workflow.yaml` if you want a meaningful name; (5) add step directories + `entry.js` files, wire props in `workflow.yaml`; (6) `git push`.

## Testing a workflow run

Before testing, pick a `trend_id` that has source metrics. The LLM workflow needs `FCT_TREND_SOURCE_METRICS` rows to feed the prompts, and respects `STG_ENRICHMENT_QUEUE.ENRICHMENT_TYPE` for whether the LLM chain runs at all.

```sql
-- Find a FULL-type trend with good source coverage
SELECT m.TREND_ID, m.TREND_TOPIC, q.ENRICHMENT_TYPE, COUNT(s.SOURCE_NAME) AS SOURCES
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
LEFT JOIN MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE q ON m.TREND_ID = q.TREND_ID
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS s ON m.TREND_ID = s.TREND_ID
WHERE s.HEADLINE_METRIC > 0 AND m.VELOCITY_DIRECTION != 'SUPERSEDED'
  AND (q.ENRICHMENT_TYPE = 'FULL' OR q.ENRICHMENT_TYPE IS NULL)
GROUP BY 1, 2, 3 HAVING COUNT(s.SOURCE_NAME) >= 4
ORDER BY m.TREND_HEAT_INDEX DESC LIMIT 5;
```

Then fire the workflow:

```sh
curl -sS -X POST https://eod25mq0qt8tk4q.m.pipedream.net \
  -H 'Content-Type: application/json' \
  -d '{"trend_id":"<uuid>"}' --max-time 180 | jq
```

- A FULL run takes **~100-120 s** wall-clock (Claude synthesis is most of it) and returns ~35–40KB of JSON.
- A SOURCES_ONLY run returns in ~5-8 s with all four LLM outputs `null`.
- If the response is HTML (`<p><b>Success!</b></p>`), the trigger's custom_response toggle is off — see gotcha #6.

### Verifying runs without the Pipedream UI

Pipedream's REST API does **not** expose per-step return values or console output for successful runs. Workarounds:

- **Errors**: `GET /v1/workflows/p_YyC86Zo/$errors/event_summaries?org_id=o_qOIvyEa&limit=5&expand=event` — returns cell id, message, and stack for any failed run. URL-encode `$` as `%24`.
- **Snowflake query history**: query `INFORMATION_SCHEMA.QUERY_HISTORY` filtered by user `CRMBOT_SERVICE_USER` to confirm the four `query_*` steps actually executed and what they returned.
- **Trigger events**: `GET /v1/sources/hi_vmHK662/event_summaries?org_id=o_qOIvyEa&limit=5&expand=event` — confirms the HTTP POST was received.

## Cost baseline (mid-2026 pricing)

A full FULL-type run on a 4-source-coverage trend costs ~**$0.06** (~11k tokens total). Claude Sonnet is ~75% of that. `return_llm_output` computes this from `_token_usage` on each step and surfaces `llm_total_tokens` + `llm_cost_estimate` in the response. The `COST_PER_M` rate table in `return_llm_output/entry.js` must stay in sync with the one in `trends-sql/pipedream/enrichment/enrich_write_snowflake.mjs`.
