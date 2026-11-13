// One attribution tick: collect the finished in-flight batch into
// FCT_TREND_SIGNALS, then submit the next trends. I/O is injected for tests.

import { randomUUID } from "node:crypto";
import {
  JOB_MODEL, JOB_SYSTEM_PROMPT_KEY, PROMPTS_SQL, SET_QUERIES,
  buildBatchRequest, buildBlocks, entryCost, filterAttributions,
  parseAttributions, renderSystemPrompt, selectSql, toPool,
} from "./attribution_context.mjs";
import { groupByTrend, loadPrompts, mustGet } from "./lifecycle_context.mjs";

const BATCHES = "MCC_RAW.MARKETING_DEV.STG_ATTRIBUTION_BATCHES";

const Q_IN_FLIGHT = `SELECT BATCH_NAME, CHAIN_ID, POOLS, BUDGET_EXHAUSTED,
  DATEDIFF(second, SUBMITTED_AT, CURRENT_TIMESTAMP()) AS AGE_S FROM ${BATCHES}
WHERE STATE = 'SUBMITTED'
ORDER BY SUBMITTED_AT DESC
LIMIT 1`;

const INSERT_BATCH = `INSERT INTO ${BATCHES} (BATCH_NAME, CHAIN_ID, TREND_IDS, POOLS, BUDGET_EXHAUSTED, SUBMITTED_AT, STATE, UPDATED_AT)
SELECT ?, ?, PARSE_JSON(?), PARSE_JSON(?), ?, CURRENT_TIMESTAMP(), ?, CURRENT_TIMESTAMP()`;

const UPDATE_STATE = `UPDATE ${BATCHES} SET STATE = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE BATCH_NAME = ?`;

// NOT EXISTS is the Pipedream step's guard. It also makes a re-run collect write nothing twice.
const INSERT_LINKS = `INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS (TREND_ID, SIGNAL_ID, LINK_KIND, LINK_TYPE)
SELECT DISTINCT f.value:trend_id::STRING, f.value:signal_id::STRING, 'attributed', f.value:link_type::STRING
FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f
WHERE NOT EXISTS (
  SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
  WHERE x.TREND_ID = f.value:trend_id::STRING AND x.SIGNAL_ID = f.value:signal_id::STRING
)`;

// NOT EXISTS: RUN_ID's primary key is not enforced.
const INSERT_COST = `INSERT INTO MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
  RUN_ID, CHAIN_ID, ITERATION, WORKFLOW_NAME, STARTED_AT, ENDED_AT, DURATION_MS, MODEL,
  INPUT_TOKENS, INPUT_TOKENS_CACHED, OUTPUT_TOKENS, THINKING_TOKENS,
  TOOL_CALL_COUNT, TURN_COUNT, COST_USD, STATUS, ERROR_MESSAGE
)
SELECT b.BATCH_NAME, b.CHAIN_ID, 1, 'trend-tree-attribution', b.SUBMITTED_AT, CURRENT_TIMESTAMP(),
  DATEDIFF(millisecond, b.SUBMITTED_AT, CURRENT_TIMESTAMP()), ?, ?, 0, ?, ?, 0, ?, ?, ?, ?
FROM ${BATCHES} b
WHERE b.BATCH_NAME = ?
  AND NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS c WHERE c.RUN_ID = b.BATCH_NAME)`;

const GRPC_CANCELLED = 1;
const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const TIMEOUT_SECONDS = 6 * 3600;
const MIN_OUTPUT_TOKENS = 8192;
const TOOL_WORDS = /commit_attributions|filter_candidates/;

export async function runTick({ query, gemini, cap = 30, now = () => new Date() }) {
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
      const pools = typeof inFlight.POOLS === "string" ? JSON.parse(inFlight.POOLS) : (inFlight.POOLS || {});
      summary.collected = await collect({
        query, gemini, prompts, batchName: name, pools, entries: batch.entries, at: now(),
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
    throw new Error(`attribution: per_call_max_tokens is ${params.per_call_max_tokens}, below ${MIN_OUTPUT_TOKENS}`);
  }
  if (!params.thinking_level) throw new Error("attribution: MODEL_PARAMS has no thinking_level");
  const tool = renderSystemPrompt(prompts, {}).match(TOOL_WORDS);
  if (tool) throw new Error(`attribution: the rendered prompt still names the tool ${tool[0]}`);
}

// A batch that ends without a collect: no tokens are known, so the cost row is zero.
// State first: a crash between the two loses a cost row instead of re-closing the batch.
async function close({ query, batchName, state, status, error = null }) {
  await query(UPDATE_STATE, [state, batchName]);
  await query(INSERT_COST, [JOB_MODEL, 0, 0, 0, 0, 0, status, error, batchName]);
}

async function collect({ query, gemini, prompts, batchName, pools, entries, at, status }) {
  const links = [];
  const errors = [];
  const toRetry = [];
  let dropped = 0;
  const usage = { prompt: 0, candidates: 0, thoughts: 0, cost: 0 };
  const absorbEntry = (key, response, batch) => {
    const u = response?.usageMetadata || {};
    usage.prompt += u.promptTokenCount || 0;
    usage.candidates += u.candidatesTokenCount || 0;
    usage.thoughts += u.thoughtsTokenCount || 0;
    usage.cost += entryCost(u, { model: JOB_MODEL, batch, at });
    const list = parseAttributions(response);
    if (!list) return false;
    const f = filterAttributions(list, pools[key] || []);
    dropped += f.dropped;
    for (const a of f.kept) links.push({ trend_id: key, ...a });
    return true;
  };

  for (const e of entries) {
    const key = e.metadata?.key;
    if (e.error?.code === GRPC_CANCELLED) continue;
    if (!pools[key]) {
      errors.push(`${key}: no pool on the batch row`);
      continue;
    }
    if (e.error || !absorbEntry(key, e.response, true)) {
      toRetry.push({ key, why: e.error ? `error ${e.error.code} ${e.error.message || ""}`.trim() : "answer is not JSON" });
    }
  }

  if (toRetry.length) {
    const { requests } = await buildRequests({ query, prompts, ids: toRetry.map((r) => r.key), pools });
    for (const { key, why } of toRetry) {
      let failure = "answer is not JSON";
      try {
        if (absorbEntry(key, await gemini.generateContent({ model: JOB_MODEL, request: requests.get(key).request }), false)) continue;
      } catch (err) {
        failure = err.message;
      }
      errors.push(`${key}: ${why}, and the retry: ${failure}`);
    }
  }
  const answered = new Set(entries.map((e) => e.metadata?.key));
  const missing = Object.keys(pools).filter((k) => pools[k].length && !answered.has(k));
  if (missing.length) errors.push(`no batch entry for ${missing.join(", ")}`);
  if (dropped) errors.push(`${dropped} attribution(s) dropped: signal not in the pool, bad link_type, or repeated`);

  if (links.length) await query(INSERT_LINKS, [JSON.stringify(links)]);
  // State first, as in close().
  await query(UPDATE_STATE, ["COLLECTED", batchName]);
  await query(INSERT_COST, [
    JOB_MODEL, usage.prompt, usage.candidates, usage.thoughts, entries.length,
    Math.round(usage.cost * 1e6) / 1e6, status, errors.length ? errors.join("; ").slice(0, 2000) : null, batchName,
  ]);
  return { batch: batchName, entries: entries.length, links: links.length, dropped, retries: toRetry.length, errors: errors.length };
}

// One request per id that has a non-empty pool, keyed by id. A given pool is
// reused (a retry); otherwise the pool is read now (a submit).
async function buildRequests({ query, prompts, ids, pools = null }) {
  const names = pools ? ["trend_context", "existing_source_types"] : Object.keys(SET_QUERIES);
  const results = await Promise.all(names.map((q) => query(SET_QUERIES[q], [JSON.stringify(ids)])));
  const byName = Object.fromEntries(names.map((q, k) => [q, groupByTrend(results[k])]));
  const params = mustGet(loadPrompts(prompts), JOB_SYSTEM_PROMPT_KEY).params;

  const outPools = {};
  const requests = new Map();
  for (const id of ids) {
    const contextRow = byName.trend_context.get(id)?.[0];
    const pool = pools ? pools[id] || [] : toPool(byName.candidate_signals.get(id));
    outPools[id] = pool;
    if (!contextRow || !pool.length) continue;
    const systemPrompt = renderSystemPrompt(prompts, buildBlocks(contextRow, byName.existing_source_types.get(id), pool));
    requests.set(id, buildBatchRequest({ trendId: id, topic: contextRow.TREND_TOPIC, poolSize: pool.length, systemPrompt, params }));
  }
  return { requests, pools: outPools };
}

async function submit({ query, gemini, prompts, limit }) {
  if (limit <= 0) return null;
  const rows = await query(selectSql(limit + 1));
  const ids = rows.slice(0, limit).map((r) => r.TREND_ID);
  if (!ids.length) return null;
  // The cap left out a trend that was never swept or not swept for 24 h.
  const budgetExhausted = rows.slice(limit).some((r) => r.OVERDUE === true);

  const { requests, pools } = await buildRequests({ query, prompts, ids });
  const chainId = `atr-chain-${randomUUID()}`;
  const body = [...requests.values()];
  let name = `none-${chainId}`;
  let state = "COLLECTED";
  if (body.length) {
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes >= INLINE_LIMIT_BYTES) throw new Error(`attribution: batch payload is ${bytes} bytes, over the 20 MB inline limit`);
    ({ name } = await gemini.submitBatch({ model: JOB_MODEL, displayName: chainId, requests: body }));
    state = "SUBMITTED";
  }
  // Every selected id goes in TREND_IDS, so an empty-pool trend counts as swept.
  await query(INSERT_BATCH, [name, chainId, JSON.stringify(ids), JSON.stringify(pools), budgetExhausted, state]);
  return { batch: name, chain_id: chainId, trends: ids.length, requests: body.length, budget_exhausted: budgetExhausted };
}
