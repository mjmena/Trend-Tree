// One tick of the lifecycle job: collect the in-flight Gemini batch if it has
// finished, then submit the due trends as the next one. I/O is injected:
// `query(sql, binds)` runs one Snowflake statement, `gemini` is the client
// from gemini_batch.mjs.

import { randomUUID } from "node:crypto";
import {
  CONTEXT_FIELDS, JOB_MODEL, JOB_SYSTEM_PROMPT_KEY, PROMPTS_SQL, SET_QUERIES,
  buildBatchRequest, buildDecision, buildTrendContext, entryCost, groupByTrend,
  loadPrompts, mustGet, renderSystemPrompt,
} from "./lifecycle_context.mjs";

const BATCHES = "MCC_RAW.MARKETING_DEV.STG_LIFECYCLE_BATCHES";

const Q_IN_FLIGHT = `SELECT BATCH_NAME, CHAIN_ID FROM ${BATCHES}
WHERE STATE = 'SUBMITTED'
ORDER BY SUBMITTED_AT DESC
LIMIT 1`;

// SUBMITTED_AT and EVALUATED_AT both come from CURRENT_TIMESTAMP() in this
// session, so the comparison stays in one time zone.
const INSERT_BATCH = `INSERT INTO ${BATCHES} (BATCH_NAME, CHAIN_ID, TREND_IDS, SUBMITTED_AT, STATE, UPDATED_AT)
SELECT ?, ?, PARSE_JSON(?), CURRENT_TIMESTAMP(), 'SUBMITTED', CURRENT_TIMESTAMP()`;

const UPDATE_STATE = `UPDATE ${BATCHES} SET STATE = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE BATCH_NAME = ?`;

// Trends of this batch already applied: a crash after the proc call must not
// apply them twice, or one batch would count as both retirement cycles.
const Q_ALREADY_APPLIED = `SELECT DISTINCT l.TREND_ID
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
JOIN ${BATCHES} b ON b.BATCH_NAME = ? AND ARRAY_CONTAINS(l.TREND_ID::VARIANT, b.TREND_IDS)
WHERE l.EVALUATED_AT > b.SUBMITTED_AT`;

const CALL_APPLY = `CALL MCC_RAW.MARKETING_DEV.PROC_LIFECYCLE_APPLY(PARSE_JSON(?)::ARRAY, ?, TRUE)`;

// NOT EXISTS: RUN_ID's primary key is not enforced, and a re-collect reaches here again.
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

// lifecycle-agent-p_JZCz73w's q_select_due_trends, most overdue first.
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

const CANCELLED = 1;
const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;

export async function runTick({ query, gemini, cap = 200, now = () => new Date() }) {
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`lifecycle: cap must be a whole number, got ${cap}`);
  const prompts = await query(PROMPTS_SQL);
  const summary = {};

  const [inFlight] = await query(Q_IN_FLIGHT);
  if (inFlight) {
    const batch = await gemini.getBatch(inFlight.BATCH_NAME);
    if (batch.state === "BATCH_STATE_PENDING" || batch.state === "BATCH_STATE_RUNNING") {
      return { waiting: inFlight.BATCH_NAME, state: batch.state };
    }
    if (batch.state !== "BATCH_STATE_SUCCEEDED") {
      throw new Error(`lifecycle: ${inFlight.BATCH_NAME} is ${batch.state}, which this job does not handle yet`);
    }
    summary.collected = await collect({ query, batchName: inFlight.BATCH_NAME, entries: batch.entries, at: now() });
  }

  summary.submitted = await submit({ query, gemini, prompts, cap });
  return summary;
}

async function collect({ query, batchName, entries, at }) {
  const applied = new Set((await query(Q_ALREADY_APPLIED, [batchName])).map((r) => r.TREND_ID));
  const decisions = [];
  const errors = [];
  const usage = { prompt: 0, candidates: 0, thoughts: 0, cost: 0 };
  for (const e of entries) {
    const key = e.metadata?.key;
    if (e.error) {
      if (e.error.code !== CANCELLED) errors.push(`${key}: error ${e.error.code} ${e.error.message || ""}`.trim());
      continue;
    }
    const u = e.response?.usageMetadata || {};
    usage.prompt += u.promptTokenCount || 0;
    usage.candidates += u.candidatesTokenCount || 0;
    usage.thoughts += u.thoughtsTokenCount || 0;
    usage.cost += entryCost(u, { batch: true, at });
    if (applied.has(key)) continue;
    const decision = buildDecision({
      trendId: key, heatBase: e.metadata.heat_base, batchName, sessionId: `lcy-sess-${randomUUID()}`, response: e.response, at,
    });
    if (decision) decisions.push(decision);
    else errors.push(`${key}: answer is not JSON`);
  }

  let receipt = null;
  if (decisions.length) {
    const rows = await query(CALL_APPLY, [JSON.stringify(decisions), batchName]);
    receipt = rows?.[0]?.PROC_LIFECYCLE_APPLY ?? null;
  }
  await query(INSERT_COST, [
    JOB_MODEL, usage.prompt, usage.candidates, usage.thoughts, entries.length,
    Math.round(usage.cost * 1e6) / 1e6, "OK", errors.length ? errors.join("; ").slice(0, 2000) : null, batchName,
  ]);
  await query(UPDATE_STATE, ["COLLECTED", batchName]);
  return { batch: batchName, entries: entries.length, applied: decisions.length, skipped: applied.size, errors: errors.length, receipt };
}

async function submit({ query, gemini, prompts, cap }) {
  if (cap === 0) return null;
  const ids = (await query(dueSql(cap))).map((r) => r.TREND_ID);
  if (!ids.length) return null;

  const names = Object.keys(SET_QUERIES);
  const results = await Promise.all(names.map((q) => query(SET_QUERIES[q], [JSON.stringify(ids)])));
  const grouped = names.map((q, k) => groupByTrend(results[k], CONTEXT_FIELDS[q].key));
  const params = mustGet(loadPrompts(prompts), JOB_SYSTEM_PROMPT_KEY).params;

  const requests = ids.map((id) => {
    const input = { trend_id: id };
    names.forEach((q, k) => { input[CONTEXT_FIELDS[q].field] = grouped[k].get(id) || []; });
    const ctx = buildTrendContext(input);
    return buildBatchRequest({
      trendId: id,
      status: ctx.metrics.lifecycle_status,
      heatBase: ctx.heat_base,
      systemPrompt: renderSystemPrompt(prompts, ctx.blocks, JOB_SYSTEM_PROMPT_KEY),
      params,
    });
  });
  const bytes = Buffer.byteLength(JSON.stringify(requests));
  if (bytes >= INLINE_LIMIT_BYTES) throw new Error(`lifecycle: batch payload is ${bytes} bytes, over the 20 MB inline limit`);

  const chainId = `lcy-chain-${randomUUID()}`;
  const { name } = await gemini.submitBatch({ model: JOB_MODEL, displayName: chainId, requests });
  await query(INSERT_BATCH, [name, chainId, JSON.stringify(ids)]);
  return { batch: name, chain_id: chainId, trends: ids.length };
}
