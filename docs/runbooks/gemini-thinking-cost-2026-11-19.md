# Gemini thinking-token accounting correction (CRMA-781)

The remaining Gemini loops bill answer plus thinking tokens as output. The fix
covers enrichment, promotion, the distillation subagent, the cluster agent, audit,
and both shared JavaScript loop implementations. Lifecycle and attribution were
already corrected; their retired Pipedream implementations and the unused old
distillation lead are absent from current production. Discovery is unchanged.

`tokens.output` includes thinking. `tokens.thinking` is the thinking subset,
not an extra charge to add to output. `tokens.total` accumulates Gemini's
`totalTokenCount` (falling back to input plus billed output when absent), so it
can be reconciled independently against the billed components. The enrichment
response preserves this object under `llm_token_usage.agent`, which the write
workflow persists under `PAYLOAD:llm_token_usage:agent`.

The ecomm cost row records the subset in the existing `THINKING_TOKENS` column;
its `OUTPUT_TOKENS` contains the full billed output. Do not add those two columns
when recomputing ecomm spend. Other producers of `STG_AGENT_RUN_COSTS` can use
different token conventions; use the producer's contract, not a fleet-wide sum.

## Comparing costs across the release

The November 2026 release creates an accounting step change at each workflow's
actual redeploy time. Higher recorded costs and earlier budget stops are expected
because thinking was previously omitted. Historical rows cannot be corrected:
the omitted token counts were not stored. Compare workloads within a consistent
accounting period. The audit agent receives this guidance both in its prefetched
cost block and from `query_cost_breakdown`.

CRMA-725's proposed fleet rollup is still in open
[PR #139](https://github.com/mjmena/Trend-Tree/pull/139); it is not part of this
release. Any future rollup must retain this boundary and each producer's token
convention.

## Rates and release gates

[Google's pricing](https://ai.google.dev/gemini-api/docs/pricing), checked
2026-11-19, bills thinking at the output rate. The existing Pro loops use
$2 input / $12 output per million for their sub-200k prompt tier. The ecomm
selector's stale estimate is corrected to Flash's published $0.75 / $3.75,
switching to $1.50 / $7.50 on 2027-01-01 UTC, matching the prediction adapter.
This change does not add long-context tier selection to the Pro loops.

Pipedream deploys the five workflow edits asynchronously after merge. Check the
changed step hashes via `GET /v1/workflows/{id}`, then allow propagation before
verifying a new run. Ecomm requires a separate Cloud Run release with
`services/deploy.sh ecomm-agent`; merge alone does not update that service.
Keep CRMA-781 open until the deployed artifacts and ledger evidence are verified.

## Ledger reconciliation

Choose a newly persisted enrichment row after confirming its redeploy. Read the
ledger itself, not only the workflow response. The name-reviewer charge is
separate from the Gemini charge and must be included in the ledger total.

```sql
SELECT TREND_ID, WRITTEN_AT, LLM_COST_ESTIMATE,
       PAYLOAD:llm_token_usage:agent AS GEMINI_USAGE,
       PAYLOAD:llm_token_usage:reviewer AS REVIEWER_USAGE,
       PAYLOAD:llm_token_usage:agent:total::NUMBER
         - PAYLOAD:llm_token_usage:agent:input::NUMBER
         - PAYLOAD:llm_token_usage:agent:output::NUMBER AS TOKEN_DELTA,
       ROUND((PAYLOAD:llm_token_usage:agent:input::NUMBER * 2
            + PAYLOAD:llm_token_usage:agent:output::NUMBER * 12) / 1000000, 4)
         AS GEMINI_COST
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE PAYLOAD:llm_token_usage:agent:thinking IS NOT NULL
ORDER BY WRITTEN_AT DESC LIMIT 5;
```

Expected: `TOKEN_DELTA = 0`, positive thinking on a thinking run, and the stored
cost equals the rounded Gemini cost plus the separately rounded reviewer cost.
For ecomm after its Cloud Run release, reconcile `COST_USD` against
`INPUT_TOKENS * input_rate + OUTPUT_TOKENS * output_rate` divided by one million,
rounded to four decimals, and confirm `THINKING_TOKENS` is populated.

Offline regression: `node --test agents/lib/gemini_loop.test.mjs` exercises all
seven real loops, including accumulated usage, missing fields and the budget
stop. `services/ecomm-agent/selector_cost.test.mjs` verifies the rates and the
actual Snowflake INSERT bindings through `runSourcing` with stubbed external I/O.
