// Lifecycle Subagent — run_subagent
//
// Single Gemini 3.1 Pro agent loop. Purely evaluative — no live HTTP tools.
// Reads pre-fetched Snowflake context (trend metrics, source metrics,
// lifecycle history, narrative history, recent signals via flatten-join,
// gtrends history, vector neighbors), computes heat_base in SQL-equivalent
// JS, then runs an agent loop with three in-process query tools and one
// terminal tool (propose_lifecycle_decision).
//
// Output: { lifecycle_decision, heat_base, tokens, cost_usd, ...telemetry }
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports fail at deploy. Cross-workflow
// shared libs don't bundle either, so any parallel agent (promotion,
// distillation, enrichment) carries its own copy of this loop.
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// prompt_loader (canonical: agents/lib/prompt_loader.mjs)
// ─────────────────────────────────────────────────────────────────────

function loadPrompts(rows) {
  const out = {};
  for (const r of rows || []) {
    let params = {};
    try { params = typeof r.MODEL_PARAMS === "string" ? JSON.parse(r.MODEL_PARAMS) : (r.MODEL_PARAMS || {}); } catch { params = {}; }
    out[r.PROMPT_KEY] = { template: r.TEMPLATE, version: r.VERSION, model: r.MODEL, params };
  }
  return out;
}

function render(template, vars) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function mustGet(loaded, key) {
  const p = loaded[key];
  if (!p) throw new Error(`prompt ${key} not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)`);
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// Tool schemas — lifecycle has only in-process query tools + terminal
// ─────────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = {
  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description:
      "Filter the prefetched neighbor pool. Use to check if any near-similarity trend has flipped status recently (might inform RESURGENT vs DORMANT for this one). Returns trend_id, trend_topic, lifecycle_status, heat, similarity, plus the neighbor's name/category if enriched. Operates on the prefetched 30-trend pool — no live SQL.",
    input_schema: {
      type: "object",
      properties: {
        min_similarity: { type: "number", description: "Optional cosine cutoff 0.0-1.0 (default 0.0)." },
        limit: { type: "integer", description: "Max neighbors to return (default 5, max 30)." },
      },
    },
  },
  query_signal_velocity: {
    name: "query_signal_velocity",
    description:
      "Count signals in time windows. Returns counts for last 24h, last 7d, last 14d, plus per-source breakdown. Operates on the prefetched recent_signals pool (last 14d, top 30 by timestamp).",
    input_schema: {
      type: "object",
      properties: {
        per_source: { type: "boolean", description: "If true, include per-source counts (default false)." },
      },
    },
  },
  query_lifecycle_history: {
    name: "query_lifecycle_history",
    description:
      "Page through prior lifecycle decisions for this trend. Use especially to check if the most recent prior decision proposed RETIRE (drives the two-cycle confirm). Operates on the prefetched 5-row history.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max rows to return (default 5)." },
      },
    },
  },
  propose_lifecycle_decision: {
    name: "propose_lifecycle_decision",
    description:
      "Emit the final lifecycle decision for this trend. Call exactly ONCE near the end of the loop. The commit step persists this. If you don't call it, nothing gets written and the trend's NEXT_LIFECYCLE_EVAL_AT does not advance. Note: this tool no longer accepts description_update — narrative changes are owned by enrichment. To trigger a narrative refresh, set request_re_enrichment=true and the commit step will fire a re-enrichment.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["NEW", "GROWING", "STABLE", "DECLINING", "DORMANT", "RESURGENT", "RETIRED"],
          description: "The lifecycle state to commit. RETIRED requires two-cycle confirm — see system prompt.",
        },
        heat_modifier_pct: {
          type: "number",
          description: "Modifier in [-20, 20]; clamped at commit. Use sparingly — see decision rubric.",
        },
        heat_modifier_reason: { type: "string" },
        // Optional via absence from `required`. We previously had
        // `nullable: true` here (commit 9ffc7b7) but Gemini's protobuf
        // schema parser tightened on 2026-04-28 evening — it now rejects
        // `nullable: true` alongside `type: "string"` with a 400 at this
        // exact path: "Unknown name 'type' at properties[3].value".
        // Pure optionality (omit the field when not RETIRED) is enough.
        retirement_reason: { type: "string", description: "Required if status='RETIRED'." },
        next_eval_in_hours: { type: "number", description: "Commit clamps to [1, 168]." },
        request_re_enrichment: {
          type: "boolean",
          description: "True if narrative is stale enough to warrant a fresh enrichment run. Owned by enrichment workflow.",
        },
        re_enrichment_reason: {
          type: "string",
          description: "Why narrative refresh is warranted (e.g., 'new gdelt source type appeared, narrative still social-only').",
        },
        reasoning: { type: "string", description: "≤500 chars defending the decision." },
      },
      required: ["status", "heat_modifier_pct", "next_eval_in_hours", "reasoning"],
    },
  },
};

const ALL_TOOL_NAMES = ["query_trend_neighbors", "query_signal_velocity", "query_lifecycle_history", "propose_lifecycle_decision"];

function getToolSchemas(names) {
  return names.map((n) => {
    const s = TOOL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return s;
  });
}

// ─────────────────────────────────────────────────────────────────────
// In-process tool dispatchers (operate on prefetched context only)
// ─────────────────────────────────────────────────────────────────────

function lookupTrendNeighbors(input, ctx) {
  const pool = ctx.neighbor_pool || [];
  const { min_similarity = 0, limit = 5 } = input || {};
  const cap = Math.min(Number(limit) || 5, 30);
  const filtered = pool
    .filter((n) => Number(n.similarity || 0) >= min_similarity)
    .slice(0, cap);
  return { neighbors: filtered, total_in_pool: pool.length };
}

function querySignalVelocity(input, ctx) {
  const signals = ctx.recent_signals || [];
  const now = Date.now();
  const WINDOWS = { last_24h: 24 * 3600 * 1000, last_7d: 7 * 24 * 3600 * 1000, last_14d: 14 * 24 * 3600 * 1000 };
  const counts = {};
  for (const [k, ms] of Object.entries(WINDOWS)) {
    counts[k] = signals.filter((s) => {
      const ts = s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0;
      return ts > 0 && (now - ts) <= ms;
    }).length;
  }
  const out = { counts, total_in_pool: signals.length };
  if (input?.per_source) {
    const bySource = {};
    for (const s of signals) {
      const src = s.source_name || "unknown";
      bySource[src] = (bySource[src] || 0) + 1;
    }
    out.per_source = bySource;
  }
  return out;
}

function queryLifecycleHistory(input, ctx) {
  const history = ctx.lifecycle_history || [];
  const cap = Math.min(Number(input?.limit) || 5, 20);
  return { history: history.slice(0, cap), total_in_pool: history.length };
}

function proposeLifecycleDecision(input, ctx) {
  // Single-shot accumulator — last call wins.
  ctx.proposed_decision = { ...input, emitted_at: new Date().toISOString() };
  return {
    accepted: true,
    note: "Lifecycle decision captured. Commit step will persist; sweeper applies based on write_live + two-cycle retire guard.",
  };
}

const DISPATCHERS = {
  query_trend_neighbors: (input, ctx) => lookupTrendNeighbors(input, ctx),
  query_signal_velocity: (input, ctx) => querySignalVelocity(input, ctx),
  query_lifecycle_history: (input, ctx) => queryLifecycleHistory(input, ctx),
  propose_lifecycle_decision: (input, ctx) => proposeLifecycleDecision(input, ctx),
};

async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try {
    return await fn(input || {}, ctx || {});
  } catch (e) {
    return { error: `tool '${name}' threw: ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Heat-base SQL-equivalent computation
// ─────────────────────────────────────────────────────────────────────

function shannonEntropyNormalized(counts) {
  const vals = Object.values(counts).filter((v) => v > 0);
  if (vals.length <= 1) return 0;
  const total = vals.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const v of vals) {
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(vals.length);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function computeHeatBase({ metrics, signal_domain_counts, recent_signals, gtrends_history }) {
  const now = Date.now();

  // recency_factor: half-life 120h — a signal from a week ago still scores ~25%
  const lastSignalTs = recent_signals[0]?.signal_timestamp
    ? new Date(recent_signals[0].signal_timestamp).getTime()
    : metrics?.last_update_at ? new Date(metrics.last_update_at).getTime() : now;
  const hoursSince = Math.max(0, (now - lastSignalTs) / (3600 * 1000));
  const recency_factor = Math.exp(-hoursSince / 120);

  // velocity_factor: 7-day merged count, sigmoid centered at 2 signals/week.
  // Floor (0 signals): sigmoid(-0.67) ≈ 0.34 → 8.5 pts.
  // Neutral (2 signals): sigmoid(0) = 0.5 → 12.5 pts.
  const sevenD = 7 * 24 * 3600 * 1000;
  const last7dCount = recent_signals.filter((s) => {
    const ts = s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0;
    return ts > 0 && (now - ts) <= sevenD;
  }).length;
  const velocity_factor = sigmoid((last7dCount - 2) / 3);

  // breadth_factor: log-publishers × shannon entropy across distinct attached
  // publisher domains. Anchored so 10 publishers (even distribution) = 1.0.
  // 1 publisher → 0; 2 → ~0.16; 5 → ~0.62; 10+ → 1.0. Penalizes both narrowness
  // AND lopsided distributions (e.g., 8/10 signals from one publisher).
  // Publisher extraction mirrors sql/dt_trend_dashboard.sql's signal_domains
  // CTE — keep them in sync.
  const distinct = Object.values(signal_domain_counts).filter(v => v > 0).length;
  const log_score = distinct === 0
    ? 0
    : Math.min(1, Math.max(0, Math.log2(distinct) - 0.5) / (Math.log2(10) - 0.5));
  const entropy = shannonEntropyNormalized(signal_domain_counts);
  const breadth_factor = log_score * entropy;

  // external_factor: latest gtrends INTEREST_AVG_PCT normalized to [0,1].
  // Avg, not peak: GT normalizes single-keyword timeseries so peak is
  // always 100 when any data exists — peak/100 collapses to a binary
  // {0,1} signal. Avg captures sustained interest vs single spike, which
  // is what the formula assumed peak would be.
  // Default 0 when no gtrends data — validation strength means "earned
  // evidence," not "assumed."
  const latestGt = gtrends_history[0];
  const external_factor = latestGt && Number.isFinite(Number(latestGt.interest_avg_pct))
    ? Math.min(1, Math.max(0, Number(latestGt.interest_avg_pct) / 100))
    : 0;

  // confidence: from FCT_TRENDS.CONFIDENCE (0-1)
  const confidence = Number(metrics?.confidence || 0.5);

  const heat_base =
    20 * recency_factor +
    25 * velocity_factor +
    25 * breadth_factor +
    20 * external_factor +
    10 * confidence;

  return {
    heat_base: Math.round(heat_base * 10) / 10,
    components: {
      recency_factor: Math.round(recency_factor * 1000) / 1000,
      velocity_factor: Math.round(velocity_factor * 1000) / 1000,
      breadth_factor: Math.round(breadth_factor * 1000) / 1000,
      external_factor: Math.round(external_factor * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Gemini 3.1 Pro agent loop runtime
// Reference: discovery-p_5VCPP3N/discover_gemini/entry.js (single-shot
// generateContent). This extends the same auth + URL pattern with a
// function-calling tool loop and round-tripped thought signatures.
// ─────────────────────────────────────────────────────────────────────

const MODEL = "gemini-3.1-pro-preview";
const RATES_PER_M = { input: 2.0, output: 12.0 };  // sub-200k context tier

const LOOP_DEFAULTS = {
  max_iterations: 8,
  budget_usd: 0.06,
  per_call_max_tokens: 3072,
  thinking_level: "medium",
  temperature: 1.0,
  request_timeout_ms: 540_000,
  max_retries_5xx: 1,
};

// Translate the shared TOOL_SCHEMAS (Anthropic-shaped: input_schema) into
// Gemini's functionDeclarations shape (parameters). The JSON Schema body
// itself is compatible — only the wrapper field name differs.
function toFunctionDeclarations(toolNames) {
  return toolNames.map((n) => {
    const s = TOOL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return { name: s.name, description: s.description, parameters: s.input_schema };
  });
}

async function runAgentLoop({
  google_gemini, tool_names, system, user_message, context,
  max_iterations = LOOP_DEFAULTS.max_iterations,
  budget_usd = LOOP_DEFAULTS.budget_usd,
  per_call_max_tokens = LOOP_DEFAULTS.per_call_max_tokens,
  thinking_level = LOOP_DEFAULTS.thinking_level,
}) {
  if (!google_gemini?.$auth?.api_key) throw new Error("google_gemini app prop missing $auth.api_key");
  const apiKey = google_gemini.$auth.api_key;

  const tools = [{ functionDeclarations: toFunctionDeclarations(tool_names) }];
  const contents = [{
    role: "user",
    parts: typeof user_message === "string" ? [{ text: user_message }] : user_message,
  }];

  const tokens = { input: 0, output: 0, total: 0 };
  const reasoning_trace = [];
  const tool_calls = [];
  let cost_usd = 0;
  let final_text = "";
  let stop_reason = "max_iterations";
  let turn = 0;

  while (turn < max_iterations) {
    turn += 1;
    if (cost_usd >= budget_usd) {
      stop_reason = "budget_exhausted";
      reasoning_trace.push({ turn, kind: "stop", reason: stop_reason, cost_usd });
      break;
    }

    const reqBody = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools,
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: {
        temperature: LOOP_DEFAULTS.temperature,
        maxOutputTokens: per_call_max_tokens,
        thinkingConfig: { thinkingLevel: thinking_level },
      },
    };

    let resp;
    let attempt = 0;
    while (true) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), LOOP_DEFAULTS.request_timeout_ms);
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody),
            signal: ctrl.signal,
          },
        );
        clearTimeout(timer);
      } catch (e) {
        throw new Error(`Gemini fetch failed (turn ${turn}): ${e.message}`);
      }
      if (resp.ok) break;
      if (resp.status >= 500 && resp.status < 600 && attempt < LOOP_DEFAULTS.max_retries_5xx) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const errText = await resp.text();
      throw new Error(`Gemini HTTP ${resp.status} (turn ${turn}, attempt ${attempt + 1}): ${errText.slice(0, 600)}`);
    }

    const data = await resp.json();
    const usage = data.usageMetadata || {};
    const tin = usage.promptTokenCount || 0;
    // candidatesTokenCount on AI Studio's Gemini API already includes
    // thinking tokens — do NOT add thoughtsTokenCount on top.
    const tout = usage.candidatesTokenCount || 0;
    tokens.input += tin;
    tokens.output += tout;
    tokens.total = tokens.input + tokens.output;
    cost_usd += (tin / 1_000_000) * RATES_PER_M.input + (tout / 1_000_000) * RATES_PER_M.output;

    const candidate = (data.candidates || [])[0] || {};
    const parts = (candidate.content && candidate.content.parts) || [];

    const functionCallParts = [];
    for (const p of parts) {
      if (p.functionCall) {
        functionCallParts.push(p);
        reasoning_trace.push({
          turn, kind: "tool_use",
          name: p.functionCall.name,
          input: p.functionCall.args || {},
          has_signature: Boolean(p.thoughtSignature),
        });
      } else if (p.thought === true) {
        reasoning_trace.push({ turn, kind: "thinking", text: p.text || "" });
      } else if (typeof p.text === "string") {
        reasoning_trace.push({ turn, kind: "text", text: p.text });
        final_text = p.text;
      }
    }

    // Push the assistant turn back VERBATIM. Gemini 3 enforces strict
    // validation on thoughtSignature round-trip for function calling —
    // reconstructing the parts array would drop signatures and cause 400.
    contents.push({ role: "model", parts });

    if (functionCallParts.length === 0) {
      stop_reason = candidate.finishReason || "STOP";
      break;
    }

    // Sequential dispatch (not Promise.all): Gemini matches functionResponse
    // parts to functionCall parts by name, with positional fallback when the
    // same name is called twice in one turn. Preserving order is cheap insurance.
    const responseParts = [];
    for (const fcp of functionCallParts) {
      const fc = fcp.functionCall;
      const started = Date.now();
      const out = await dispatchTool(fc.name, fc.args || {}, context);
      const duration_ms = Date.now() - started;
      tool_calls.push({ turn, name: fc.name, input: fc.args || {}, output: out, duration_ms });
      responseParts.push({
        functionResponse: {
          name: fc.name,
          // Gemini requires `response` to be an object.
          response: out && typeof out === "object" ? out : { result: out },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return {
    stop_reason, turns: turn, tokens,
    cost_usd: Math.round(cost_usd * 10000) / 10000,
    reasoning_trace, tool_calls, final_text, model: MODEL,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Step entrypoint
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_KEY = "lifecycle.subagent.system";
const RUBRIC_PROMPT_KEY = "lifecycle.subagent.decision_rubric";

function parseVariant(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

function fmtJson(obj) {
  return JSON.stringify(obj, null, 2);
}

export default defineComponent({
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    event: { type: "any" },
    metrics_rows: { type: "any" },
    signal_domain_rows: { type: "any", optional: true },
    lifecycle_history_rows: { type: "any", optional: true },
    recent_signal_rows: { type: "any", optional: true },
    candidate_signal_rows: { type: "any", optional: true },
    gtrends_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
    prompts_rows: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const trend_id = ev.trend_id;
    const started = Date.now();

    const metricsRow = (this.metrics_rows || [])[0];
    if (!metricsRow) {
      throw new Error(`lifecycle: no FCT_TRENDS row for trend_id ${trend_id}`);
    }

    // Normalize prefetched data into context shape
    const metrics = {
      trend_id: metricsRow.TREND_ID,
      trend_topic: metricsRow.TREND_TOPIC,
      lifecycle_status: metricsRow.LIFECYCLE_STATUS,
      total_cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
      distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
      confidence: metricsRow.CONFIDENCE,
      specificity_score: metricsRow.SPECIFICITY_SCORE,
      trend_heat_index: metricsRow.TREND_HEAT_INDEX,
      trend_heat_index_smoothed: metricsRow.TREND_HEAT_INDEX_SMOOTHED,
      promoted_at: metricsRow.PROMOTED_AT,
      last_update_at: metricsRow.LAST_UPDATE_AT,
      last_lifecycle_eval_at: metricsRow.LAST_LIFECYCLE_EVAL_AT,
      trend_name_b2b: metricsRow.TREND_NAME_B2B,
      trend_name_b2c: metricsRow.TREND_NAME_B2C,
      category: metricsRow.CATEGORY,
      subcategory: metricsRow.SUBCATEGORY,
      summary_short: metricsRow.SUMMARY_SHORT,
      summary_long: metricsRow.SUMMARY_LONG,
      vibe_shift: metricsRow.VIBE_SHIFT,
      enriched_at: metricsRow.ENRICHED_AT,
      enrichment_version: metricsRow.ENRICHMENT_VERSION,
    };

    // Per-domain signal counts attached to this trend (from q_signal_domains).
    // Drives breadth_factor via Shannon entropy in computeHeatBase. Counts come
    // from FCT_TREND_SIGNALS (both 'supporting' and 'attributed' LINK_KINDs)
    // with each signal mapped to a canonical publisher domain.
    const signal_domain_counts = Object.fromEntries(
      (this.signal_domain_rows || [])
        .filter((r) => r.DOMAIN && Number(r.SIGNAL_COUNT) > 0)
        .map((r) => [r.DOMAIN, Number(r.SIGNAL_COUNT)])
    );

    const lifecycle_history = (this.lifecycle_history_rows || []).map((r) => ({
      evaluated_at: r.EVALUATED_AT,
      prior_status: r.PRIOR_STATUS,
      new_status: r.NEW_STATUS,
      prior_heat: r.PRIOR_HEAT,
      new_heat: r.NEW_HEAT,
      heat_modifier_pct: r.HEAT_MODIFIER_PCT,
      reasoning: r.REASONING,
      retirement_proposal: parseVariant(r.RETIREMENT_PROPOSAL),
      requested_re_enrichment: r.REQUESTED_RE_ENRICHMENT,
    }));

    const recent_signals = (this.recent_signal_rows || []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      signal_timestamp: r.SIGNAL_TIMESTAMP,
      signal_title: r.SIGNAL_TITLE,
      signal_text: r.SIGNAL_TEXT,
    }));

    const candidate_signals = (this.candidate_signal_rows || []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      signal_timestamp: r.SIGNAL_TIMESTAMP,
      signal_title: r.SIGNAL_TITLE,
      signal_text: r.SIGNAL_TEXT,
      similarity: Number(r.SIMILARITY || 0),
    }));

    const gtrends_history = (this.gtrends_rows || []).map((r) => ({
      pulled_at: r.PULLED_AT,
      interest_peak_pct: r.INTEREST_PEAK_PCT,
      interest_avg_pct: r.INTEREST_AVG_PCT,
      related_queries: parseVariant(r.RELATED_QUERIES),
    }));

    const neighbor_pool = (this.neighbor_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      lifecycle_status: r.LIFECYCLE_STATUS,
      heat: r.HEAT,
      last_update_at: r.LAST_UPDATE_AT,
      trend_name_b2c: r.TREND_NAME_B2C,
      category: r.CATEGORY,
      subcategory: r.SUBCATEGORY,
      summary_short: r.SUMMARY_SHORT,
      similarity: Number(r.SIMILARITY || 0),
    }));

    // Merge promotion-time signals with vector-similar recent signals so
    // recency + velocity reflect ongoing topic activity, not just the frozen
    // promotion-time link set. Dedup by signal_id; sort newest-first so
    // computeHeatBase sees the most recent signal at index 0.
    const signalById = new Map();
    for (const s of [...recent_signals, ...candidate_signals]) {
      if (!signalById.has(s.signal_id)) signalById.set(s.signal_id, s);
    }
    const merged_signals = [...signalById.values()].sort((a, b) => {
      const ta = a.signal_timestamp ? new Date(a.signal_timestamp).getTime() : 0;
      const tb = b.signal_timestamp ? new Date(b.signal_timestamp).getTime() : 0;
      return tb - ta;
    });

    // Compute heat baseline
    const { heat_base, components } = computeHeatBase({
      metrics, signal_domain_counts, recent_signals: merged_signals, gtrends_history,
    });

    // Velocity + trajectory metrics for the agent's heat context block.
    const _now = Date.now();
    const _7d = 7 * 24 * 3600 * 1000;
    const _24h = 24 * 3600 * 1000;
    const last7dSignals = merged_signals.filter(s => {
      const ts = s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0;
      return ts > 0 && (_now - ts) <= _7d;
    });
    const last24hCount = merged_signals.filter(s => {
      const ts = s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0;
      return ts > 0 && (_now - ts) <= _24h;
    }).length;
    const dailyVelocityAvg = (last7dSignals.length / 7).toFixed(1);
    // lifecycle_history is sorted newest-first by the SQL query
    const priorHeat = lifecycle_history.length ? Number(lifecycle_history[0].new_heat) : null;
    const heatDelta = priorHeat !== null ? (heat_base - priorHeat).toFixed(1) : null;
    const heatTrajectory = lifecycle_history.length
      ? lifecycle_history.slice(0, 5).map(h => `${h.evaluated_at}: ${h.new_heat}`).join(" → ")
      : null;

    const context = {
      neighbor_pool,
      recent_signals: merged_signals,
      lifecycle_history,
      proposed_decision: null,
      agent_session_id: ev.agent_session_id,
      chain_id: ev.chain_id,
    };

    // Build context blocks for the system prompt
    const trend_state_block = `TREND_ID: ${metrics.trend_id}
TREND_TOPIC: ${metrics.trend_topic}
TREND_NAME_B2B / B2C: ${metrics.trend_name_b2b || "(unenriched)"} / ${metrics.trend_name_b2c || "(unenriched)"}
CATEGORY: ${metrics.category || "?"} / ${metrics.subcategory || "?"}
CURRENT LIFECYCLE_STATUS: ${metrics.lifecycle_status}
CURRENT HEAT (smoothed): ${metrics.trend_heat_index_smoothed ?? metrics.trend_heat_index}
CURRENT HEAT (raw): ${metrics.trend_heat_index}
PROMOTED_AT: ${metrics.promoted_at}
LAST_UPDATE_AT: ${metrics.last_update_at}
LAST_LIFECYCLE_EVAL_AT: ${metrics.last_lifecycle_eval_at || "(never)"}`;

    const metrics_block = `Cluster size: ${metrics.total_cluster_size}
Distinct source count: ${metrics.distinct_source_count}
Confidence: ${metrics.confidence}
Specificity score: ${metrics.specificity_score}`;

    const lifecycle_history_block = lifecycle_history.length
      ? lifecycle_history.map((h, i) =>
          `${i + 1}. ${h.evaluated_at} — ${h.prior_status} → ${h.new_status} | heat ${h.prior_heat} → ${h.new_heat} ` +
          `${h.retirement_proposal ? "[RETIREMENT_PROPOSED] " : ""}` +
          `reason: ${(h.reasoning || "").slice(0, 200)}`
        ).join("\n")
      : "(no prior lifecycle evaluations)";

    const recent_signals_block = recent_signals.length
      ? recent_signals.slice(0, 20).map((s, i) =>
          `${i + 1}. [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
        ).join("\n")
      : "(no signals in last 14d)";

    const gtrends_block = gtrends_history.length
      ? gtrends_history.slice(0, 10).map((g) =>
          `${g.pulled_at}: peak=${g.interest_peak_pct}, avg=${g.interest_avg_pct}`
        ).join("\n")
      : "(no GTrends data yet — gtrends-poller may not have run for this trend)";

    const neighbor_block = neighbor_pool.length
      ? neighbor_pool.slice(0, 10).map((n, i) =>
          `${i + 1}. sim=${n.similarity.toFixed(2)} | ${n.lifecycle_status} | "${n.trend_name_b2c || n.trend_topic}" (heat ${n.heat})`
        ).join("\n")
      : "(no neighbors in pool)";

    const candidate_signals_block = candidate_signals.length
      ? candidate_signals.map((s, i) =>
          `${i + 1}. sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
        ).join("\n")
      : "(no vector-similar signals in last 7d)";

    const heat_baseline_block = `heat_base = ${heat_base}
components: ${fmtJson(components)}
formula: 20*recency + 25*velocity + 25*breadth + 20*external + 10*confidence
heat_delta (vs prior eval): ${heatDelta !== null ? heatDelta : "(first eval)"}
heat_trajectory (recent evals, newest first): ${heatTrajectory || "(first eval)"}
signals last 7d: ${last7dSignals.length} (avg ${dailyVelocityAvg}/day)
signals last 24h: ${last24hCount}
Your modifier window: [-20, 20] %`;

    // Load + render prompts
    const loaded = loadPrompts(this.prompts_rows);
    const systemPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
    const rubric = mustGet(loaded, RUBRIC_PROMPT_KEY);

    const renderedSystem = render(systemPrompt.template, {
      decision_rubric: rubric.template,
      trend_state_block,
      metrics_block,
      lifecycle_history_block,
      recent_signals_block,
      candidate_signals_block,
      gtrends_block,
      neighbor_block,
      heat_baseline_block,
    });

    const userMessage = `Evaluate trend ${trend_id}. Current status is ${metrics.lifecycle_status}. ` +
      `Use the prefetched context to decide the new status, heat modifier, and any description update. ` +
      `Call propose_lifecycle_decision exactly once with your final answer.`;

    console.log(
      `lcy-sub: trend=${trend_id} status=${metrics.lifecycle_status} heat_base=${heat_base} ` +
      `prompt=${SYSTEM_PROMPT_KEY} v${systemPrompt.version}`
    );

    if (ev.dry_run) {
      console.log("lcy-sub: dry_run=true — skipping LLM");
      $.export("$summary", `${trend_id}: dry_run`);
      return {
        lifecycle_decision: null,
        heat_base,
        heat_components: components,
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
        turns: 0,
        stop_reason: "dry_run",
        skipped: "dry_run",
      };
    }

    let result;
    try {
      result = await runAgentLoop({
        google_gemini: this.google_gemini,
        tool_names: ALL_TOOL_NAMES,
        system: renderedSystem,
        user_message: userMessage,
        context,
        max_iterations: ev.max_iterations || systemPrompt.params.max_iterations || LOOP_DEFAULTS.max_iterations,
        budget_usd: ev.budget_usd || systemPrompt.params.budget_usd || LOOP_DEFAULTS.budget_usd,
        per_call_max_tokens: systemPrompt.params.per_call_max_tokens || LOOP_DEFAULTS.per_call_max_tokens,
        thinking_level: systemPrompt.params.thinking_level || LOOP_DEFAULTS.thinking_level,
      });
    } catch (e) {
      console.log(`lcy-sub loop error: ${e.message}`);
      throw e;
    }

    const duration_ms = Date.now() - started;
    const lifecycle_decision = context.proposed_decision;

    if (!lifecycle_decision) {
      console.log(`lcy-sub: agent did NOT call propose_lifecycle_decision (stop=${result.stop_reason}, turns=${result.turns})`);
    }

    console.log(
      `lcy-sub done: trend=${trend_id} status_proposed=${lifecycle_decision?.status || "(none)"} ` +
      `turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms`
    );
    $.export(
      "$summary",
      `${result.turns} turns, $${result.cost_usd.toFixed(3)}, ${Math.round(duration_ms / 1000)}s` +
      `${lifecycle_decision ? " → " + lifecycle_decision.status : " — no decision"}`
    );

    // Build the decisions array PROC_LIFECYCLE_APPLY consumes.
    // Empty array if the agent didn't call propose_lifecycle_decision.
    const decisions_json = lifecycle_decision
      ? JSON.stringify([{
          trend_id,
          agent_session_id: ev.agent_session_id,
          chain_id: ev.chain_id,
          heat_base,
          lifecycle_decision,
          llm_token_usage: result.tokens,
          llm_cost_estimate: result.cost_usd,
          agent_telemetry: {
            model: result.model,
            turns: result.turns,
            stop_reason: result.stop_reason,
            tool_call_count: result.tool_calls.length,
          },
        }])
      : "[]";

    return {
      lifecycle_decision,
      heat_base,
      heat_components: components,
      decisions_json,
      trend_id,
      chain_id: ev.chain_id,
      agent_session_id: ev.agent_session_id,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      turns: result.turns,
      stop_reason: result.stop_reason,
      reasoning_trace_size: result.reasoning_trace.length,
      tool_call_count: result.tool_calls.length,
      duration_ms,
      model: result.model,
    };
  },
});
