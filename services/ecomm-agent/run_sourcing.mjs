// Ecomm Agent — the sourcing run (CRMA-776, epic CRMA-772).
//
// Ported from the removed Pipedream step ecomm-agent/run_sourcing/entry.mjs
// (commit 61d0318, which carries that step's code-review fixes). The single
// mutating path: opens the sourcing run header, runs the selector (skipped
// when the retrieval pool is empty), derives the ledger write plan, completes
// the header, and writes the STG_AGENT_RUN_COSTS row — with any failure after
// 'open' still reaching a 'failed' completion AND a cost row (per the AC:
// "written on failure too").
//
// A catalog-freshness decline (ctx.catalog_fresh === false, decided upstream
// by fetch_context) never reaches PROC_SOURCING_APPLY at all — "no header
// written" IS the decline state, not a distinct status.

import { randomUUID } from "node:crypto";
import { applyFloorAndTopN, buildSourcingRunPlan, SEMANTIC_THRESHOLD } from "../lib/sourcing_run.mjs";
import { callSelector, SELECTOR_MODEL } from "./selector.mjs";
import { parseReceipt, runWithConnectRetryOnly, runWithRetry } from "./snowflake.mjs";

const CALL_OPEN = `
  CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
    'open', NULL, ?, ?, ?, ?, ?, ?, ?,
    NULL, NULL, NULL, NULL
  )
`;

const CALL_COMPLETE = `
  CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
    'complete', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    ?, ?, ?, PARSE_JSON(?)
  )
`;

const INSERT_COST_ROW = `
  INSERT INTO MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
    RUN_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, WORKFLOW_NAME,
    STARTED_AT, ENDED_AT, DURATION_MS, MODEL,
    INPUT_TOKENS, INPUT_TOKENS_CACHED, OUTPUT_TOKENS, THINKING_TOKENS,
    TOOL_CALL_COUNT, TURN_COUNT, COST_USD, STATUS, ERROR_MESSAGE
  ) VALUES (?, ?, ?, 1, 'ecomm-agent', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)
`;

async function callProcOpen(connOpts, evt) {
  const rows = await runWithConnectRetryOnly(connOpts, CALL_OPEN, [
    evt.trend_id, evt.tier, SEMANTIC_THRESHOLD, SELECTOR_MODEL, "v1", "v1", evt.agent_session_id,
  ]);
  const parsed = parseReceipt(rows);
  if (!parsed || parsed.applied !== true) {
    throw new Error(`PROC_SOURCING_APPLY open failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function callProcComplete(connOpts, sourcingRunId, plan) {
  const rows = await runWithRetry(connOpts, CALL_COMPLETE, [
    sourcingRunId, plan.outcome, plan.error_message, plan.selector_note, JSON.stringify(plan.candidates || []),
  ]);
  return parseReceipt(rows);
}

// runWithConnectRetryOnly, NOT runWithRetry: this is a bare INSERT with no
// idempotency guard (STG_AGENT_RUN_COSTS' RUN_ID PRIMARY KEY is
// informational-only in Snowflake, not enforced), so retrying after execute()
// reached the server but the response was lost — exactly the transient class
// the retry wrapper matches — would write a SECOND cost row for one run and
// double-count the spend. Same reasoning as PROC_SOURCING_APPLY('open'):
// only a connect-phase failure, which sent nothing, is safe to retry.
async function insertCostRow(connOpts, row) {
  await runWithConnectRetryOnly(connOpts, INSERT_COST_ROW, [
    row.run_id, row.agent_session_id, row.chain_id,
    row.started_at, row.ended_at, row.duration_ms, row.model,
    row.input_tokens, row.output_tokens, row.tool_call_count, row.turn_count,
    row.cost_usd, row.status, row.error_message,
  ]);
}

function costRowFrom({ evt, startedAt, endedAt, telemetry, status, errorMessage }) {
  return {
    run_id: `ecomm-cost-${randomUUID()}`,
    agent_session_id: evt.agent_session_id,
    chain_id: evt.chain_id,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    model: telemetry ? SELECTOR_MODEL : null,
    input_tokens: telemetry?.tokens?.input ?? 0,
    output_tokens: telemetry?.tokens?.output ?? 0,
    tool_call_count: telemetry?.tool_calls?.length ?? 0,
    turn_count: telemetry?.turns ?? 0,
    cost_usd: telemetry?.cost_usd ?? 0,
    status,
    error_message: errorMessage,
  };
}

// { connOpts, apiKey, evt, ctx } -> the run receipt the HTTP layer renders.
// `header_recorded` tells the caller whether the run's terminal state actually
// reached FCT_TREND_SOURCING_LEDGER: a 'failed' run whose header landed is a
// recorded outcome the next poll tick will retry (HTTP 200), whereas a run
// that could not write a header at all is an infrastructure failure the
// caller should see as a 5xx.
export async function runSourcing({ connOpts, apiKey, evt, ctx }) {
  const startedAt = new Date();

  // DECLINE — the catalog freshness gate. No header, no cost row, no LLM
  // call: "no header written at all" IS the decline state (not 'failed').
  if (!ctx.catalog_fresh) {
    console.log(`ecomm-agent run_sourcing: DECLINED trend=${evt.trend_id} reason=${ctx.decline_reason}`);
    return {
      decision: "declined",
      header_recorded: false,
      trend_id: evt.trend_id,
      tier: evt.tier,
      reason: ctx.decline_reason,
      catalog_age_days: ctx.catalog_age_days,
    };
  }

  let sourcingRunId = null;
  let selectorTelemetry = null;

  try {
    const openResult = await callProcOpen(connOpts, evt);
    sourcingRunId = openResult.sourcing_run_id;
    console.log(`ecomm-agent run_sourcing: opened sourcing_run_id=${sourcingRunId} trend=${evt.trend_id}`);

    let plan;
    if (!ctx.trend_found) {
      plan = {
        outcome: "failed",
        selector_note: null,
        error_message: `no real (non-seed) enrichment row with TREND_VECTOR found for trend_id ${evt.trend_id}`,
        candidates: [],
        warnings: [],
      };
    } else {
      const pool = applyFloorAndTopN(ctx.pool);
      if (pool.length === 0) {
        plan = buildSourcingRunPlan({ pool: [], selectorEmit: null });
      } else {
        if (!ctx.prompt || !ctx.prompt.template) {
          throw new Error("sourcing.selector prompt not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)");
        }
        const { emit, telemetry } = await callSelector({ apiKey, prompt: ctx.prompt, trend: ctx.trend, pool });
        selectorTelemetry = telemetry;
        plan = buildSourcingRunPlan({ pool, selectorEmit: emit });
      }
    }

    const completeResult = await callProcComplete(connOpts, sourcingRunId, plan);
    if (!completeResult || completeResult.applied !== true) {
      throw new Error(`PROC_SOURCING_APPLY complete failed: ${JSON.stringify(completeResult)}`);
    }

    // The run is DONE and successful as far as PROC_SOURCING_APPLY is
    // concerned (header + candidate rows are already committed). From here on,
    // a cost-row write failure must NEVER downgrade this response to "failed"
    // — that would discard a real, already-persisted matched/no_match/failed
    // outcome and misreport a successful run as broken. Isolate it in its own
    // try/catch instead of letting it fall into the outer catch below.
    const endedAt = new Date();
    let costRowError = null;

    // 'complete' applying does NOT mean the run succeeded: plan.outcome is
    // 'failed' when the selector emitted nothing usable or every pick was
    // invalid, and the budget_usd kill-switch lands here too. Recording those
    // as STATUS='OK' would make the two failure statuses the cost schema
    // exists for (see sql/stg_agent_run_costs.sql) unwritable by this service,
    // and any `WHERE STATUS='ERROR'` audit query would read the lane as clean.
    const costStatus =
      plan.outcome !== "failed"
        ? "OK"
        : selectorTelemetry?.stop_reason === "budget_exhausted"
          ? "BUDGET_EXHAUSTED"
          : "ERROR";

    try {
      await insertCostRow(
        connOpts,
        costRowFrom({
          evt,
          startedAt,
          endedAt,
          telemetry: selectorTelemetry,
          status: costStatus,
          errorMessage: plan.error_message ? String(plan.error_message).slice(0, 2000) : null,
        }),
      );
    } catch (costErr) {
      costRowError = costErr.message;
      console.log(
        `ecomm-agent run_sourcing: cost-row insert failed (the sourcing run itself still succeeded) sourcing_run_id=${sourcingRunId}: ${costErr.message}`,
      );
    }

    const selectedCount = plan.candidates.filter((c) => c.selected).length;
    console.log(
      `ecomm-agent run_sourcing: COMPLETE sourcing_run_id=${sourcingRunId} outcome=${plan.outcome} selected=${selectedCount}/${plan.candidates.length} warnings=${plan.warnings.length}`,
    );

    return {
      decision: "completed",
      header_recorded: true,
      sourcing_run_id: sourcingRunId,
      trend_id: evt.trend_id,
      tier: evt.tier,
      outcome: plan.outcome,
      selector_note: plan.selector_note,
      error_message: plan.error_message,
      candidates: plan.candidates,
      warnings: plan.warnings,
      selector_telemetry: selectorTelemetry
        ? {
            model: SELECTOR_MODEL,
            turns: selectorTelemetry.turns,
            tokens: selectorTelemetry.tokens,
            cost_usd: selectorTelemetry.cost_usd,
            stop_reason: selectorTelemetry.stop_reason,
          }
        : null,
      cost_row_error: costRowError,
    };
  } catch (err) {
    console.log(`ecomm-agent run_sourcing: ERROR trend=${evt.trend_id} sourcing_run_id=${sourcingRunId}: ${err.message}`);

    let completeResult = null;
    if (sourcingRunId) {
      try {
        completeResult = await callProcComplete(connOpts, sourcingRunId, {
          outcome: "failed",
          selector_note: null,
          error_message: err.message,
          candidates: [],
        });
      } catch (e2) {
        console.log(`ecomm-agent run_sourcing: failed-completion ALSO failed for sourcing_run_id=${sourcingRunId}: ${e2.message}`);
      }
    }

    const endedAt = new Date();
    // Captured, not merely logged: the success path reports a lost cost row to
    // the caller via cost_row_error, and the failure path must too — this is
    // exactly the run where "the required cost row never landed" most needs to
    // be visible, and returning null here would assert the opposite.
    let costRowError = null;
    try {
      await insertCostRow(
        connOpts,
        costRowFrom({
          evt,
          startedAt,
          endedAt,
          telemetry: selectorTelemetry,
          status: "ERROR",
          errorMessage: String(err.message || err).slice(0, 2000),
        }),
      );
    } catch (e3) {
      costRowError = e3.message;
      console.log(`ecomm-agent run_sourcing: cost-row insert ALSO failed: ${e3.message}`);
    }

    return {
      decision: "failed",
      header_recorded: completeResult?.applied === true,
      sourcing_run_id: sourcingRunId,
      trend_id: evt.trend_id,
      tier: evt.tier,
      outcome: "failed",
      error_message: err.message,
      candidates: [],
      warnings: [],
      complete_result: completeResult,
      cost_row_error: costRowError,
    };
  }
}
