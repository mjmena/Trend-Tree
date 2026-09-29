// Run-cost telemetry: raw provider usage -> STG_AGENT_RUN_COSTS rows (CRMA-725)
// ============================================================================
//
// Pure helper, no I/O. Canonical copy lives here in agents/lib; each
// instrumented Pipedream workflow carries a BYTE-IDENTICAL copy at
// <workflow>/write_run_cost/run_cost.mjs, imported as a sibling by that
// step's entry.mjs (the only cross-file import Pipedream's bundler allows —
// see the pipedream-synced-project skill). agents/lib/run_cost.test.mjs fails
// if any copy drifts from this file, so edit HERE and re-copy:
//
//   for f in */write_run_cost/run_cost.mjs; do cp agents/lib/run_cost.mjs "$f"; done
//
// Contract with the LLM-calling steps: each step returns `_llm_calls`, an
// array of { provider, model, usage, tool_calls? } — one entry per API call,
// `usage` being the provider's raw usage object, untouched. All token
// normalization and pricing happens here, per call, so a long-context tier
// is chosen on that call's own prompt size, not on a run total.
//
// Column semantics (shared with services/ecomm-agent, the table's other
// writer): INPUT_TOKENS is the whole prompt (cached share included),
// INPUT_TOKENS_CACHED the cached subset of it, OUTPUT_TOKENS the visible
// answer, THINKING_TOKENS the reasoning tokens billed at the output rate.
//
// Gemini thinking (CRMA-781): usageMetadata.candidatesTokenCount EXCLUDES
// thinking — prompt + candidates + thoughts == totalTokenCount on every
// measured call — so thoughtsTokenCount is counted here as THINKING_TOKENS
// and billed at the output rate. The agent loops' own in-step `cost_usd`
// (which drives their budget stop) still omits it; fixing that is CRMA-781's
// scope, not this helper's, so COST_USD here will read higher than those
// in-step figures.

// $ per 1M tokens, list prices. `long_context` switches the whole call to
// the higher tier when that call's prompt exceeds `threshold` tokens.
// Not modelled (not token-priced): Gemini Google-Search grounding fees,
// OpenAI web_search and xAI web/x search tool-call fees, and Anthropic
// cache-write premiums (no caller here uses prompt caching).
export const RATES_PER_M = {
  // Same sub-200k rates every Gemini 3.1 Pro loop in this repo uses; the
  // long-context tier matches services/prediction's PRO_RATES_PER_M_LONG_CONTEXT.
  "gemini-3.1-pro-preview": {
    input: 2.0, cached_input: 0.2, output: 12.0,
    long_context: { threshold: 200_000, input: 4.0, cached_input: 0.4, output: 18.0 },
  },
  "gemini-2.5-flash": { input: 0.3, cached_input: 0.03, output: 2.5 },
  // Same rates as agents/lib/anthropic_loop.mjs.
  "claude-sonnet-4-6": { input: 3.0, cached_input: 0.3, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, cached_input: 0.1, output: 5.0 },
  "gpt-5-mini": { input: 0.25, cached_input: 0.025, output: 2.0 },
  "grok-4": {
    input: 3.0, cached_input: 0.75, output: 15.0,
    long_context: { threshold: 128_000, input: 6.0, cached_input: 1.5, output: 30.0 },
  },
};

// Exact key first, then the longest key the model id starts with, so dated
// or aliased ids ("gpt-5-mini-2025-08-07", "claude-haiku-4-5-20251001",
// "grok-4-latest") resolve without listing every snapshot.
export function ratesFor(model) {
  if (!model) return null;
  if (RATES_PER_M[model]) return RATES_PER_M[model];
  let best = null;
  for (const key of Object.keys(RATES_PER_M)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? RATES_PER_M[best] : null;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Raw provider usage -> { input_tokens, cached_input_tokens, output_tokens, thinking_tokens }.
export function normalizeUsage(provider, usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  switch (provider) {
    case "gemini":
      return {
        // toolUsePromptTokenCount (grounding / tool results fed back) is prompt-side.
        input_tokens: n(u.promptTokenCount) + n(u.toolUsePromptTokenCount),
        cached_input_tokens: n(u.cachedContentTokenCount),
        output_tokens: n(u.candidatesTokenCount),
        thinking_tokens: n(u.thoughtsTokenCount),
      };
    case "anthropic":
      // input_tokens excludes cache reads/writes; output_tokens already
      // includes extended-thinking tokens and the API does not split them.
      return {
        input_tokens: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
        cached_input_tokens: n(u.cache_read_input_tokens),
        output_tokens: n(u.output_tokens),
        thinking_tokens: 0,
      };
    case "openai":
    case "xai": {
      // /v1/responses shape. OpenAI's output_tokens INCLUDES reasoning; do not
      // assume xAI's does — total_tokens is the arbiter: whatever the total
      // carries beyond input + output is reasoning billed on top.
      const input = n(u.input_tokens);
      const out = n(u.output_tokens);
      const reasoning = n(u.output_tokens_details?.reasoning_tokens);
      const beyond = n(u.total_tokens) - input - out;
      const reasoningOnTop = beyond > 0;
      return {
        input_tokens: input,
        cached_input_tokens: n(u.input_tokens_details?.cached_tokens),
        output_tokens: reasoningOnTop ? out : Math.max(0, out - reasoning),
        thinking_tokens: reasoningOnTop ? beyond : Math.min(reasoning, out),
      };
    }
    default:
      return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
  }
}

// One call's cost in USD, or null when the model has no known price.
export function callCostUsd(model, t) {
  const base = ratesFor(model);
  if (!base) return null;
  const r = base.long_context && t.input_tokens > base.long_context.threshold ? base.long_context : base;
  const cached = Math.min(t.cached_input_tokens, t.input_tokens);
  return (
    ((t.input_tokens - cached) * r.input +
      cached * r.cached_input +
      (t.output_tokens + t.thinking_tokens) * r.output) /
    1_000_000
  );
}

// Flatten step returns into one call list. Accepts arrays of call records or
// step $return_values carrying `_llm_calls`; ignores anything else.
export function collectCalls(sources) {
  const out = [];
  for (const s of sources || []) {
    const list = Array.isArray(s) ? s : Array.isArray(s?._llm_calls) ? s._llm_calls : [];
    for (const c of list) if (c && typeof c === "object" && c.model) out.push(c);
  }
  return out;
}

// STATUS column: 'OK' | 'TIMEOUT' | 'BUDGET_EXHAUSTED' | 'ERROR'. First error
// wins; otherwise a loop that stopped on its budget is BUDGET_EXHAUSTED.
export function deriveStatus(stepResults) {
  let budget = false;
  for (const r of stepResults || []) {
    if (!r || typeof r !== "object") continue;
    if (r.error) return { status: "ERROR", error_message: String(r.error) };
    if (r.stop_reason === "budget_exhausted") budget = true;
  }
  return { status: budget ? "BUDGET_EXHAUSTED" : "OK", error_message: null };
}

const cap = (s, len) => (s == null || s === "" ? null : String(s).slice(0, len));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// One row per model used in the run (a single-model run is one row). A run
// that made no LLM call still gets one zero row with MODEL NULL, the same
// shape services/ecomm-agent writes for its no-LLM runs.
export function buildRunCostRows({
  workflow_name, run_id, agent_session_id = null, chain_id = null, iteration = 1,
  started_at, ended_at, calls = [], status = "OK", error_message = null,
}) {
  const startMs = Date.parse(started_at);
  const endMs = Date.parse(ended_at);
  const common = {
    agent_session_id: cap(agent_session_id, 64),
    chain_id: cap(chain_id, 64),
    iteration: Number.isFinite(Number(iteration)) ? Number(iteration) : 1,
    workflow_name: cap(workflow_name, 64),
    started_at,
    ended_at,
    duration_ms: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
    status: cap(status, 32) || "OK",
    error_message: cap(error_message, 2000),
  };

  const byModel = new Map();
  for (const c of calls) {
    const t = normalizeUsage(c.provider, c.usage);
    const cost = callCostUsd(c.model, t);
    const g = byModel.get(c.model) || {
      model: c.model, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
      thinking_tokens: 0, tool_call_count: 0, turn_count: 0, cost_usd: 0,
    };
    g.input_tokens += t.input_tokens;
    g.cached_input_tokens += t.cached_input_tokens;
    g.output_tokens += t.output_tokens;
    g.thinking_tokens += t.thinking_tokens;
    g.tool_call_count += n(c.tool_calls);
    g.turn_count += 1;
    g.cost_usd = g.cost_usd == null || cost == null ? null : g.cost_usd + cost;
    byModel.set(c.model, g);
  }

  const groups = [...byModel.values()];
  if (groups.length === 0) {
    return [{
      run_id: cap(run_id, 64), ...common, model: null,
      input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
      tool_call_count: 0, turn_count: 0, cost_usd: 0,
    }];
  }
  return groups.map((g, i) => ({
    run_id: cap(groups.length === 1 ? run_id : `${run_id}-${i + 1}`, 64),
    ...common,
    ...g,
    model: cap(g.model, 64),
    cost_usd: g.cost_usd == null ? null : round6(g.cost_usd),
  }));
}

// Bind: one JSON array string of buildRunCostRows() output. Written as a bare
// INSERT with no retry by callers — RUN_ID's PRIMARY KEY is not enforced in
// Snowflake, so a retry after a lost response would double-count spend
// (same reasoning as services/ecomm-agent/run_sourcing.mjs insertCostRow).
export const RUN_COST_INSERT_SQL = `
INSERT INTO MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
  RUN_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, WORKFLOW_NAME,
  STARTED_AT, ENDED_AT, DURATION_MS, MODEL,
  INPUT_TOKENS, INPUT_TOKENS_CACHED, OUTPUT_TOKENS, THINKING_TOKENS,
  TOOL_CALL_COUNT, TURN_COUNT, COST_USD, STATUS, ERROR_MESSAGE
)
SELECT
  r.value:run_id::STRING, r.value:agent_session_id::STRING, r.value:chain_id::STRING,
  r.value:iteration::NUMBER, r.value:workflow_name::STRING,
  TRY_TO_TIMESTAMP_NTZ(r.value:started_at::STRING), TRY_TO_TIMESTAMP_NTZ(r.value:ended_at::STRING),
  r.value:duration_ms::NUMBER, r.value:model::STRING,
  r.value:input_tokens::NUMBER, r.value:cached_input_tokens::NUMBER,
  r.value:output_tokens::NUMBER, r.value:thinking_tokens::NUMBER,
  r.value:tool_call_count::NUMBER, r.value:turn_count::NUMBER,
  r.value:cost_usd::FLOAT, r.value:status::STRING, r.value:error_message::STRING
FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) r
`;
