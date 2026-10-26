// One tick: collect the finished in-flight batch, then submit the due trends.
// I/O is injected so the tick runs against fakes in tests.

import { randomUUID } from "node:crypto";
import {
  CONTEXT_FIELDS, JOB_MODEL, JOB_SYSTEM_PROMPT_KEY, PROMPTS_SQL, SET_QUERIES,
  buildBatchRequest, buildDecision, buildTrendContext, entryCost, groupByTrend,
  loadPrompts, mustGet, renderSystemPrompt,
} from "./lifecycle_context.mjs";

const BATCHES = "MCC_RAW.MARKETING_DEV.STG_LIFECYCLE_BATCHES";

const Q_IN_FLIGHT = `SELECT BATCH_NAME, CHAIN_ID, HEAT_BASES, BUDGET_EXHAUSTED,
  DATEDIFF(second, SUBMITTED_AT, CURRENT_TIMESTAMP()) AS AGE_S FROM ${BATCHES}
WHERE STATE = 'SUBMITTED'
ORDER BY SUBMITTED_AT DESC
LIMIT 1`;

// SUBMITTED_AT and EVALUATED_AT both come from CURRENT_TIMESTAMP() in this
// session, so the comparison stays in one time zone.
const INSERT_BATCH = `INSERT INTO ${BATCHES} (BATCH_NAME, CHAIN_ID, TREND_IDS, HEAT_BASES, BUDGET_EXHAUSTED, SUBMITTED_AT, STATE, UPDATED_AT)
SELECT ?, ?, PARSE_JSON(?), PARSE_JSON(?), ?, CURRENT_TIMESTAMP(), 'SUBMITTED', CURRENT_TIMESTAMP()`;

const UPDATE_STATE = `UPDATE ${BATCHES} SET STATE = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE BATCH_NAME = ?`;

// Trends of this batch already applied: a crash after the proc call must not
// apply them twice, or one batch would count as both retirement cycles.
const Q_ALREADY_APPLIED = `SELECT DISTINCT l.TREND_ID
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
JOIN ${BATCHES} b ON b.BATCH_NAME = ? AND ARRAY_CONTAINS(l.TREND_ID::VARIANT, b.TREND_IDS)
WHERE l.EVALUATED_AT > b.SUBMITTED_AT`;

const CALL_APPLY = `CALL MCC_RAW.MARKETING_DEV.PROC_LIFECYCLE_APPLY(PARSE_JSON(?)::ARRAY, ?, TRUE)`;

// NOT EXISTS: RUN_ID's primary key is not enforced.
const INSERT_COST = `INSERT INTO MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
  RUN_ID, CHAIN_ID, ITERATION, WORKFLOW_NAME, STARTED_AT, ENDED_AT, DURATION_MS, MODEL,
  INPUT_TOKENS, INPUT_TOKENS_CACHED, OUTPUT_TOKENS, THINKING_TOKENS,
  TOOL_CALL_COUNT, TURN_COUNT, COST_USD, STATUS, ERROR_MESSAGE
)
SELECT b.BATCH_NAME, b.CHAIN_ID, 1, 'trend-tree-lifecycle', b.SUBMITTED_AT, CURRENT_TIMESTAMP(),
  DATEDIFF(millisecond, b.SUBMITTED_AT, CURRENT_TIMESTAMP()), ?, ?, 0, ?, ?, 0, ?, ?, ?, ?
FROM ${BATCHES} b
WHERE b.BATCH_NAME = ?
  AND NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS c WHERE c.RUN_ID = b.BATCH_NAME)`;

// Most overdue first.
const dueSql = (limit) => `WITH latest_lifecycle AS (
  SELECT TREND_ID,
         NEW_STATUS                AS LIFECYCLE_STATUS,
         NEW_HEAT                  AS HEAT_INDEX,
         NEW_HEAT_SMOOTHED         AS HEAT_INDEX_SMOOTHED,
         NEXT_EVAL_AT
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  ) WHERE rn = 1
)
SELECT t.TREND_ID, t.TREND_TOPIC,
       COALESCE(lc.LIFECYCLE_STATUS, 'NEW') AS LIFECYCLE_STATUS,
       COALESCE(lc.HEAT_INDEX_SMOOTHED, lc.HEAT_INDEX, 0) AS HEAT,
       t.PROMOTED_AT, lc.NEXT_EVAL_AT AS NEXT_LIFECYCLE_EVAL_AT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
LEFT JOIN latest_lifecycle lc ON lc.TREND_ID = t.TREND_ID
WHERE COALESCE(lc.LIFECYCLE_STATUS, 'NEW') != 'RETIRED'
  AND COALESCE(lc.NEXT_EVAL_AT, DATEADD(hour, 24, t.PROMOTED_AT)) <= CURRENT_TIMESTAMP()
ORDER BY COALESCE(lc.NEXT_EVAL_AT, DATEADD(hour, 24, t.PROMOTED_AT)) ASC
LIMIT ${limit}`;

const GRPC_CANCELLED = 1;
const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const TIMEOUT_SECONDS = 6 * 3600;
const MIN_OUTPUT_TOKENS = 8192;
const TOOL_WORDS = /propose_lifecycle_decision|query_trend_|query_signal_|query_lifecycle_/;

export async function runTick({ query, gemini, cap = 200, now = () => new Date() }) {
  const prompts = await query(PROMPTS_SQL);
  refuseBadPrompt(prompts);
  const summary = {};
  let retries = 0;

  const [inFlight] = await query(Q_IN_FLIGHT);
  if (inFlight) {
    const name = inFlight.BATCH_NAME;
    const batch = await gemini.getBatch(name);
    if (batch.state === "BATCH_STATE_PENDING" || batch.state === "BATCH_STATE_RUNNING") {
      if (Number(inFlight.AGE_S) < TIMEOUT_SECONDS) return { waiting: name, state: batch.state };
      await gemini.cancelBatch(name);
      await close({ query, batchName: name, state: "CANCELLED", status: "TIMEOUT" });
      summary.cancelled = name;
    } else if (batch.state === "BATCH_STATE_SUCCEEDED" && batch.entries.length
      && batch.entries.every((e) => e.error?.code === GRPC_CANCELLED)) {
      // We cancelled it on timeout and crashed before recording that.
      await close({ query, batchName: name, state: "CANCELLED", status: "TIMEOUT" });
      summary.cancelled = name;
    } else if (batch.state === "BATCH_STATE_SUCCEEDED") {
      const heatBases = typeof inFlight.HEAT_BASES === "string" ? JSON.parse(inFlight.HEAT_BASES) : (inFlight.HEAT_BASES || {});
      summary.collected = await collect({
        query, gemini, prompts, batchName: name, heatBases, entries: batch.entries, at: now(),
        status: inFlight.BUDGET_EXHAUSTED ? "BUDGET_EXHAUSTED" : "OK",
      });
      retries = summary.collected.retries;
    } else {
      await close({ query, batchName: name, state: "FAILED", status: "ERROR", error: batch.state });
      summary.failed = name;
    }
  }

  summary.submitted = await submit({ query, gemini, prompts, limit: cap - retries });
  return summary;
}

function refuseBadPrompt(prompts) {
  const { params } = mustGet(loadPrompts(prompts), JOB_SYSTEM_PROMPT_KEY);
  // Negated so a missing value refuses too.
  if (!(params.per_call_max_tokens >= MIN_OUTPUT_TOKENS)) {
    throw new Error(`lifecycle: per_call_max_tokens is ${params.per_call_max_tokens}, below ${MIN_OUTPUT_TOKENS}`);
  }
  const tool = renderSystemPrompt(prompts, {}, JOB_SYSTEM_PROMPT_KEY).match(TOOL_WORDS);
  if (tool) throw new Error(`lifecycle: the rendered prompt still names the tool ${tool[0]}`);
}

// A batch that ends without a collect: no tokens are known, so the cost row is zero.
// State first: a crash between the two loses a cost row instead of re-closing the batch.
async function close({ query, batchName, state, status, error = null }) {
  await query(UPDATE_STATE, [state, batchName]);
  await query(INSERT_COST, [JOB_MODEL, 0, 0, 0, 0, 0, status, error, batchName]);
}

async function collect({ query, gemini, prompts, batchName, heatBases, entries, at, status }) {
  const applied = new Set((await query(Q_ALREADY_APPLIED, [batchName])).map((r) => r.TREND_ID));
  const decisions = [];
  const errors = [];
  const toRetry = [];
  const usage = { prompt: 0, candidates: 0, thoughts: 0, cost: 0 };
  const decide = (key, response, batch) => {
    const u = response?.usageMetadata || {};
    usage.prompt += u.promptTokenCount || 0;
    usage.candidates += u.candidatesTokenCount || 0;
    usage.thoughts += u.thoughtsTokenCount || 0;
    usage.cost += entryCost(u, { batch, at });
    return buildDecision({
      trendId: key, heatBase: heatBases[key], batchName, sessionId: `lcy-sess-${randomUUID()}`, response, batch, at,
    });
  };

  for (const e of entries) {
    const key = e.metadata?.key;
    if (e.error?.code === GRPC_CANCELLED || applied.has(key)) continue;
    if (typeof heatBases[key] !== "number") {
      errors.push(`${key}: no heat_base on the batch row`);
      continue;
    }
    const decision = e.error ? null : decide(key, e.response, true);
    if (decision) decisions.push(decision);
    else toRetry.push({ key, why: e.error ? `error ${e.error.code} ${e.error.message || ""}`.trim() : "answer is not JSON" });
  }

  if (toRetry.length) {
    const { requests } = await buildRequests({ query, prompts, ids: toRetry.map((r) => r.key) });
    for (const [i, { key, why }] of toRetry.entries()) {
      let failure = "answer is not JSON";
      try {
        const decision = decide(key, await gemini.generateContent({ model: JOB_MODEL, request: requests[i].request }), false);
        if (decision) { decisions.push(decision); continue; }
      } catch (err) {
        failure = err.message;
      }
      errors.push(`${key}: ${why}, and the retry: ${failure}`);
    }
  }

  let receipt = null;
  if (decisions.length) {
    const rows = await query(CALL_APPLY, [JSON.stringify(decisions), batchName]);
    receipt = rows?.[0]?.PROC_LIFECYCLE_APPLY ?? null;
  }
  // State first, as in close().
  await query(UPDATE_STATE, ["COLLECTED", batchName]);
  await query(INSERT_COST, [
    JOB_MODEL, usage.prompt, usage.candidates, usage.thoughts, entries.length,
    Math.round(usage.cost * 1e6) / 1e6, status, errors.length ? errors.join("; ").slice(0, 2000) : null, batchName,
  ]);
  return {
    batch: batchName, entries: entries.length, applied: decisions.length, skipped: applied.size,
    retries: toRetry.length, errors: errors.length, receipt,
  };
}

async function buildRequests({ query, prompts, ids }) {
  const names = Object.keys(SET_QUERIES);
  const results = await Promise.all(names.map((q) => query(SET_QUERIES[q], [JSON.stringify(ids)])));
  const grouped = names.map((q, k) => groupByTrend(results[k], CONTEXT_FIELDS[q].key));
  const params = mustGet(loadPrompts(prompts), JOB_SYSTEM_PROMPT_KEY).params;

  const heatBases = {};
  const requests = ids.map((id) => {
    const input = { trend_id: id };
    names.forEach((q, k) => { input[CONTEXT_FIELDS[q].field] = grouped[k].get(id) || []; });
    const ctx = buildTrendContext(input);
    heatBases[id] = ctx.heat_base;
    return buildBatchRequest({
      trendId: id,
      status: ctx.metrics.lifecycle_status,
      systemPrompt: renderSystemPrompt(prompts, ctx.blocks, JOB_SYSTEM_PROMPT_KEY),
      params,
    });
  });
  return { requests, heatBases };
}

async function submit({ query, gemini, prompts, limit }) {
  if (limit <= 0) return null;
  // One row past the limit tells whether the cap cut the due set.
  const due = (await query(dueSql(limit + 1))).map((r) => r.TREND_ID);
  const ids = due.slice(0, limit);
  if (!ids.length) return null;

  const { requests, heatBases } = await buildRequests({ query, prompts, ids });
  const bytes = Buffer.byteLength(JSON.stringify(requests));
  if (bytes >= INLINE_LIMIT_BYTES) throw new Error(`lifecycle: batch payload is ${bytes} bytes, over the 20 MB inline limit`);

  const chainId = `lcy-chain-${randomUUID()}`;
  const { name } = await gemini.submitBatch({ model: JOB_MODEL, displayName: chainId, requests });
  const budgetExhausted = due.length > limit;
  await query(INSERT_BATCH, [name, chainId, JSON.stringify(ids), JSON.stringify(heatBases), budgetExhausted]);
  return { batch: name, chain_id: chainId, trends: ids.length, budget_exhausted: budgetExhausted };
}
