// Distillation Cluster Agent — run_lead_agent
//
// Gemini 3.1 Pro orchestrator. Receives pre-clustered signal IDs + full
// signal rows + neighbor trends. Scans signals, forms hypotheses, fans out
// to the unified subagent (p_jmCjj3J) via dispatch_subagent, and emits
// accepted candidates. Source-agnostic: doesn't know whether signals came
// from the main 24h pool or the 48h revisit pool.
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file. Canonical source: /home/marty/dev/Trend-Tree/agents/lib/*.mjs
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// prompt_loader
// ─────────────────────────────────────────────────────────────────────

function loadPrompts(rows) {
  const out = {};
  for (const r of (rows || [])) {
    const key = r.PROMPT_KEY;
    if (!key) continue;
    let params = r.MODEL_PARAMS;
    if (typeof params === "string") {
      try { params = JSON.parse(params); } catch { params = {}; }
    }
    if (!params || typeof params !== "object") params = {};
    out[key] = { template: r.TEMPLATE || "", model: r.MODEL || "", params, version: r.VERSION };
  }
  return out;
}

function render(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars?.[key];
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
}

function mustGet(loaded, key) {
  const p = loaded?.[key];
  if (!p || !p.template) {
    throw new Error(`Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT has IS_ACTIVE=TRUE for this key.`);
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// fanoutSubagents
// ─────────────────────────────────────────────────────────────────────

async function fanoutSubagents({ url, dispatches, concurrency = 10, perCallTimeoutMs = 240_000 }) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return { error: `subagent endpoint not configured (got '${url}')`, results: [] };
  }
  if (!Array.isArray(dispatches) || dispatches.length === 0) {
    return { results: [], note: "no dispatches" };
  }

  const results = new Array(dispatches.length);
  let cursor = 0;

  async function worker() {
    while (cursor < dispatches.length) {
      const idx = cursor++;
      const body = dispatches[idx];
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), perCallTimeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await resp.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (!resp.ok) {
          results[idx] = { hypothesis: body.hypothesis, bucket: body.bucket, error: `HTTP ${resp.status}: ${text.slice(0, 240)}`, duration_ms: Date.now() - started };
        } else {
          results[idx] = { hypothesis: body.hypothesis, bucket: body.bucket, duration_ms: Date.now() - started, ...parsed };
        }
      } catch (e) {
        results[idx] = {
          hypothesis: body.hypothesis, bucket: body.bucket,
          error: e.name === "AbortError" ? `timeout after ${perCallTimeoutMs}ms` : e.message,
          duration_ms: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, dispatches.length) }, () => worker());
  await Promise.all(workers);

  const summary = { dispatched: dispatches.length, succeeded: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, by_verdict: {} };
  for (const r of results) {
    const v = r?.verdict || (r?.error ? "ERROR" : "UNKNOWN");
    summary.by_verdict[v] = (summary.by_verdict[v] || 0) + 1;
  }
  return { results, summary };
}

// ─────────────────────────────────────────────────────────────────────
// Tool catalog
// ─────────────────────────────────────────────────────────────────────

const QUERY_SCHEMAS = {
  query_signals_window: {
    name: "query_signals_window",
    description: "Filter the pre-fetched signal pool by source, domain, time window, full-text match, or cluster_id. Returns up to `limit` signal records with id, title, source, domain, detected_at, cluster_id, and a snippet.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string" },
        domain_contains: { type: "string" },
        text_contains: { type: "string" },
        signal_ids: { type: "array", items: { type: "string" } },
        cluster_id: { type: "integer" },
        limit: { type: "integer" },
      },
    },
  },
  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description: "Find the k existing trends closest to a candidate topic or signal cluster. Returns trend_id, trend_topic, total_cluster_size, velocity_direction, trend_heat_index, and similarity_score. Use BEFORE proposing to check for duplicates.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        signal_ids: { type: "array", items: { type: "string" } },
        k: { type: "integer" },
        min_similarity: { type: "number" },
      },
    },
  },
  query_trend_metrics: {
    name: "query_trend_metrics",
    description: "Look up full metadata for one or more existing trend ids.",
    input_schema: {
      type: "object",
      properties: { trend_ids: { type: "array", items: { type: "string" } } },
      required: ["trend_ids"],
    },
  },
  validate_dedupe_pair: {
    name: "validate_dedupe_pair",
    description: "Token-overlap between a proposed candidate and an existing trend. Numeric scores only.",
    input_schema: {
      type: "object",
      properties: {
        candidate_topic: { type: "string" },
        candidate_signal_ids: { type: "array", items: { type: "string" } },
        existing_trend_id: { type: "string" },
      },
      required: ["candidate_topic", "existing_trend_id"],
    },
  },
  validate_url_canonical: {
    name: "validate_url_canonical",
    description: "Resolve a URL to canonical form via HEAD. Times out at 5s.",
    input_schema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" } } },
      required: ["urls"],
    },
  },
};

const INGEST_SCHEMAS = {
  ingest_search_bluesky: {
    name: "ingest_search_bluesky",
    description: "Search Bluesky (ATProto searchPosts). Returns up to `limit` posts. ~6-8s. Writes results to STG_EXTERNAL_SIGNALS tagged with current agent_session_id.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" }, sort: { type: "string", enum: ["latest", "top"] } }, required: ["query"] },
  },
  ingest_search_gdelt: {
    name: "ingest_search_gdelt",
    description: "Search GDELT global news index. Returns up to ~150 articles. ~20-30s. Writes to STG_EXTERNAL_SIGNALS.",
    input_schema: { type: "object", properties: { topic: { type: "string" }, window_days: { type: "integer" }, mode: { type: "string", enum: ["ArtList", "ArtRecent"] } }, required: ["topic"] },
  },
  ingest_search_google_trends: {
    name: "ingest_search_google_trends",
    description: "Look up Google Trends interest + related queries. ~30-50s. Use sparingly.",
    input_schema: { type: "object", properties: { keyword: { type: "string" }, geo: { type: "string" }, timeframe: { type: "string" } }, required: ["keyword"] },
  },
  ingest_grok_live_search: {
    name: "ingest_grok_live_search",
    description: "Search X (Twitter) for live posts about a query via Grok x_search. Returns a digest summary + 3-8 cited X posts (x.com/<handle>/status + one-sentence context). The X/social corroboration tool. For web/news use GDELT; for demand use Google Trends.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

const LEAD_ONLY_SCHEMAS = {
  dispatch_subagent: {
    name: "dispatch_subagent",
    description: "Send one or more hypotheses to the distillation subagent for deep investigation. Each dispatch is a candidate trend with hypothesis text + supporting signal_ids. Subagents run in parallel and each returns a verdict + refined candidates.",
    input_schema: {
      type: "object",
      properties: {
        dispatches: {
          type: "array",
          items: {
            type: "object",
            properties: { hypothesis: { type: "string" }, signal_ids: { type: "array", items: { type: "string" } }, budget_tokens: { type: "integer" } },
            required: ["hypothesis", "signal_ids"],
          },
        },
      },
      required: ["dispatches"],
    },
  },
  propose_trend_candidate: {
    name: "propose_trend_candidate",
    description: "Add a candidate trend to the run's output. Call once per accepted candidate AFTER validating specificity and dedup. Be opinionated.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        // NOTE: no atomic candidate `query` here. This cluster-agent does NOT
        // write STG_TREND_CANDIDATES — the active authoring path is the lead
        // distillation-p_mkCBBqb + subagent distillation-subagent-p_jmCjj3J,
        // which carry the ADR-0004 candidate query. (Slice-1/#59 originally
        // added the field here by mistake; removed so it can't mislead.)
        supporting_signal_ids: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        specificity_score: { type: "number" },
        verdict: { type: "string", enum: ["REAL_TREND", "DUPLICATE_OF"] },
        dedup_of_trend_id: { type: "string" },
        source_breakdown: { type: "object" },
        evidence_added: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" },
      },
      required: ["topic", "supporting_signal_ids", "confidence", "specificity_score", "verdict", "reasoning"],
    },
  },
};

const META_SCHEMAS = {
  discover_external_tools: {
    name: "discover_external_tools",
    description: "Surface schemas of additional tools. Use when you need external evidence.",
    input_schema: { type: "object", properties: { need: { type: "string", enum: ["social", "web", "search", "cultural", "competitive", "all"] } }, required: ["need"] },
  },
};

const EAGER_TOOL_NAMES = ["query_signals_window", "query_trend_neighbors", "query_trend_metrics", "validate_dedupe_pair", "validate_url_canonical", "discover_external_tools"];
const LEAD_TOOL_NAMES = [...EAGER_TOOL_NAMES, "dispatch_subagent", "propose_trend_candidate"];

const DEFERRED_BY_NEED = {
  social: ["ingest_search_bluesky", "ingest_grok_live_search"],
  web: ["ingest_search_google_trends", "ingest_search_gdelt"],
  search: ["ingest_search_gdelt", "ingest_search_google_trends"],
  cultural: ["ingest_search_bluesky", "ingest_grok_live_search"],
  competitive: ["ingest_search_gdelt", "ingest_search_google_trends"],
  all: ["ingest_search_bluesky", "ingest_search_gdelt", "ingest_search_google_trends", "ingest_grok_live_search"],
};

const ALL_SCHEMAS = { ...QUERY_SCHEMAS, ...INGEST_SCHEMAS, ...LEAD_ONLY_SCHEMAS, ...META_SCHEMAS };

function getToolSchemas(names) {
  return names.map((n) => {
    const s = ALL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return s;
  });
}

// ─────────────────────────────────────────────────────────────────────
// In-process tool implementations
// ─────────────────────────────────────────────────────────────────────

function tokenize(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3));
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function cryptoRandomId() {
  return "cand-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function lookupSignals(input, ctx) {
  const pool = ctx.signal_pool || [];
  const { source, domain_contains, text_contains, signal_ids, cluster_id, limit = 25 } = input || {};
  const cap = Math.min(Number(limit) || 25, 100);
  const ids = signal_ids ? new Set(signal_ids) : null;
  const txt = text_contains ? text_contains.toLowerCase() : null;
  const filterClusterId = (cluster_id === 0 || Number.isFinite(cluster_id)) ? Number(cluster_id) : null;
  const out = [];
  for (const s of pool) {
    if (out.length >= cap) break;
    if (ids && !ids.has(s.signal_id)) continue;
    if (source && s.source_name !== source) continue;
    if (filterClusterId !== null && s.cluster_id !== filterClusterId) continue;
    if (domain_contains && !(s.domain || "").toLowerCase().includes(domain_contains.toLowerCase())) continue;
    if (txt) {
      const hay = `${s.title || ""} ${s.body || ""}`.toLowerCase();
      if (!hay.includes(txt)) continue;
    }
    out.push({ signal_id: s.signal_id, title: s.title, source: s.source_name, domain: s.domain, detected_at: s.detected_at, snippet: (s.body || s.title || "").slice(0, 240), url: s.url, cluster_id: s.cluster_id ?? null });
  }
  return { signals: out, total_in_pool: pool.length, returned: out.length };
}

function lookupTrendNeighbors(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const { topic, signal_ids, k = 5, min_similarity = 0 } = input || {};
  const cap = Math.min(Number(k) || 5, 20);
  if (!topic && !(signal_ids && signal_ids.length)) return { error: "must provide topic or signal_ids" };
  const queryTokens = tokenize(topic || (signal_ids || []).join(" "));
  const scored = pool.map((t) => ({
    trend_id: t.trend_id, trend_topic: t.trend_topic,
    total_cluster_size: t.total_cluster_size, velocity_direction: t.velocity_direction,
    trend_heat_index: t.trend_heat_index,
    similarity_score: jaccard(queryTokens, tokenize(t.trend_topic)),
  }));
  scored.sort((a, b) => b.similarity_score - a.similarity_score);
  return { neighbors: scored.filter((s) => s.similarity_score >= min_similarity).slice(0, cap) };
}

function lookupTrendMetrics(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const want = new Set(input.trend_ids || []);
  return { metrics: pool.filter((t) => want.has(t.trend_id)) };
}

function validateDedupePair(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const trend = pool.find((t) => t.trend_id === input.existing_trend_id);
  if (!trend) return { error: `trend ${input.existing_trend_id} not in pre-fetched neighbor pool` };
  const a = tokenize(input.candidate_topic || "");
  const b = tokenize(trend.trend_topic || "");
  return {
    token_overlap_jaccard: jaccard(a, b),
    candidate_token_count: a.size, existing_token_count: b.size,
    existing_topic: trend.trend_topic,
    note: "Use jaccard + judgment for dedup decision.",
  };
}

async function validateUrlCanonical(input) {
  const urls = (input.urls || []).slice(0, 10);
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      clearTimeout(timer);
      return { input_url: u, canonical_url: resp.url, status: resp.status, content_type: resp.headers.get("content-type") || null };
    } catch (e) {
      return { input_url: u, error: e.message };
    }
  }));
  return { results };
}

function discoverExternalTools(input) {
  const need = (input.need || "all").toLowerCase();
  const wanted = DEFERRED_BY_NEED[need] || DEFERRED_BY_NEED.all;
  return { tools: wanted.map((n) => ALL_SCHEMAS[n]), note: `Loaded ${wanted.length} tool(s) for need='${need}'.` };
}

async function postJson(url, body, { timeoutMs = 90_000 } = {}) {
  if (!url || /PLACEHOLDER/i.test(url)) return { error: `tool endpoint not configured (got '${url}')` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${text.slice(0, 400)}` };
    return parsed ?? { _raw: text };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function ingestBluesky(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_bluesky, { query: input.query, limit: input.limit ?? 25, sort: input.sort ?? "latest", agent_session_id: ctx.agent_session_id }, { timeoutMs: 30_000 });
}
async function ingestGdelt(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_gdelt, { topic: input.topic, window_days: input.window_days ?? 7, mode: input.mode ?? "ArtList", agent_session_id: ctx.agent_session_id }, { timeoutMs: 60_000 });
}
async function ingestGoogleTrends(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_google_trends, { keyword: input.keyword, geo: input.geo ?? "US", timeframe: input.timeframe ?? "now 7-d", agent_session_id: ctx.agent_session_id }, { timeoutMs: 90_000 });
}
async function ingestGrokLive(input, ctx) {
  return postJson(ctx.endpoints?.ingest_grok_live_search, { query: input.query, mode: input.mode ?? "both", agent_session_id: ctx.agent_session_id }, { timeoutMs: 30_000 });
}

async function dispatchSubagent(input, ctx) {
  const dispatches = (input.dispatches || []).slice(0, 20);
  if (dispatches.length === 0) return { results: [], note: "no dispatches" };
  return fanoutSubagents({
    url: ctx.endpoints?.distillation_subagent,
    dispatches: dispatches.map((d) => ({
      hypothesis: d.hypothesis, signal_ids: d.signal_ids, bucket: d.bucket,
      budget_tokens: d.budget_tokens ?? 30000,
      agent_session_id: ctx.agent_session_id, chain_id: ctx.chain_id,
    })),
    concurrency: 10, perCallTimeoutMs: 120_000,
  });
}

function proposeTrendCandidate(input, ctx) {
  ctx.proposed_candidates = ctx.proposed_candidates || [];
  ctx.proposed_candidates.push({
    ...input, candidate_id: cryptoRandomId(),
    chain_id: ctx.chain_id, iteration: ctx.iteration, agent_session_id: ctx.agent_session_id,
  });
  return { accepted: true, accepted_count: ctx.proposed_candidates.length, candidate_id: ctx.proposed_candidates[ctx.proposed_candidates.length - 1].candidate_id };
}

const DISPATCHERS = {
  query_signals_window: (input, ctx) => lookupSignals(input, ctx),
  query_trend_neighbors: (input, ctx) => lookupTrendNeighbors(input, ctx),
  query_trend_metrics: (input, ctx) => lookupTrendMetrics(input, ctx),
  validate_dedupe_pair: (input, ctx) => validateDedupePair(input, ctx),
  validate_url_canonical: (input) => validateUrlCanonical(input),
  discover_external_tools: (input) => discoverExternalTools(input),
  ingest_search_bluesky: (input, ctx) => ingestBluesky(input, ctx),
  ingest_search_gdelt: (input, ctx) => ingestGdelt(input, ctx),
  ingest_search_google_trends: (input, ctx) => ingestGoogleTrends(input, ctx),
  ingest_grok_live_search: (input, ctx) => ingestGrokLive(input, ctx),
  dispatch_subagent: (input, ctx) => dispatchSubagent(input, ctx),
  propose_trend_candidate: (input, ctx) => proposeTrendCandidate(input, ctx),
};

async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try { return await fn(input || {}, ctx || {}); }
  catch (e) { return { error: `tool '${name}' threw: ${e.message}` }; }
}

// ─────────────────────────────────────────────────────────────────────
// Gemini 3.1 Pro agent loop
// ─────────────────────────────────────────────────────────────────────

const MODEL = "gemini-3.1-pro-preview";
const RATES_PER_M = { input: 2.0, output: 12.0 };

const LOOP_DEFAULTS = {
  max_iterations: 12, budget_usd: 5.0,
  per_call_max_tokens: 8192, thinking_level: "medium",
  temperature: 1.0, request_timeout_ms: 180_000,
};

function toFunctionDeclarations(toolNames) {
  return toolNames.map((n) => {
    const s = ALL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return { name: s.name, description: s.description, parameters: s.input_schema };
  });
}

async function runAgentLoop({ google_gemini, tool_names, system, user_message, context, max_iterations = LOOP_DEFAULTS.max_iterations, budget_usd = LOOP_DEFAULTS.budget_usd, per_call_max_tokens = LOOP_DEFAULTS.per_call_max_tokens, thinking_level = LOOP_DEFAULTS.thinking_level }) {
  if (!google_gemini?.$auth?.api_key) throw new Error("google_gemini app prop missing $auth.api_key");
  if (!Array.isArray(tool_names) || tool_names.length === 0) throw new Error("tool_names is required");
  const apiKey = google_gemini.$auth.api_key;

  const tools = [{ functionDeclarations: toFunctionDeclarations(tool_names) }];
  const contents = [{ role: "user", parts: typeof user_message === "string" ? [{ text: user_message }] : user_message }];

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
      generationConfig: { temperature: LOOP_DEFAULTS.temperature, maxOutputTokens: per_call_max_tokens, thinkingConfig: { thinkingLevel: thinking_level } },
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LOOP_DEFAULTS.request_timeout_ms);
      resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      throw new Error(`Gemini fetch failed (turn ${turn}): ${e.message}`);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini HTTP ${resp.status} (turn ${turn}): ${errText.slice(0, 600)}`);
    }

    const data = await resp.json();
    const usage = data.usageMetadata || {};
    const tin = usage.promptTokenCount || 0;
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
        reasoning_trace.push({ turn, kind: "tool_use", name: p.functionCall.name, input: p.functionCall.args || {}, has_signature: Boolean(p.thoughtSignature) });
      } else if (p.thought === true) {
        reasoning_trace.push({ turn, kind: "thinking", text: p.text || "" });
      } else if (typeof p.text === "string") {
        reasoning_trace.push({ turn, kind: "text", text: p.text });
        final_text = p.text;
      }
    }

    contents.push({ role: "model", parts });

    if (functionCallParts.length === 0) {
      stop_reason = candidate.finishReason || "STOP";
      break;
    }

    const responseParts = [];
    for (const fcp of functionCallParts) {
      const fc = fcp.functionCall;
      const started = Date.now();
      const out = await dispatchTool(fc.name, fc.args || {}, context);
      const duration_ms = Date.now() - started;
      tool_calls.push({ turn, name: fc.name, input: fc.args || {}, output: out, duration_ms });
      reasoning_trace.push({ turn, kind: "tool_result", name: fc.name, output_preview: previewOutput(out) });
      responseParts.push({ functionResponse: { name: fc.name, response: out && typeof out === "object" ? out : { result: out } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (turn >= max_iterations && stop_reason === "max_iterations") {
    reasoning_trace.push({ turn, kind: "stop", reason: "max_iterations" });
  }

  return { stop_reason, turns: turn, tokens, cost_usd: Math.round(cost_usd * 10000) / 10000, reasoning_trace, tool_calls, final_text, model: MODEL };
}

function previewOutput(out) {
  if (!out || typeof out !== "object") return String(out).slice(0, 240);
  const keys = Object.keys(out);
  const summary = {};
  for (const k of keys.slice(0, 8)) {
    const v = out[k];
    if (Array.isArray(v)) summary[k] = `[array, len=${v.length}]`;
    else if (typeof v === "string" && v.length > 200) summary[k] = v.slice(0, 200) + "…";
    else if (typeof v === "object" && v !== null) summary[k] = `{object, keys=${Object.keys(v).length}}`;
    else summary[k] = v;
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────────────
// Cluster helpers
// ─────────────────────────────────────────────────────────────────────

function parseClusterRows(input) {
  if (!input) return [];
  if (Array.isArray(input) && input.length > 0 && typeof input[0] === "object" && "cluster_id" in input[0]) return input;
  if (typeof input === "string") {
    try { const p = JSON.parse(input); if (Array.isArray(p)) return p; } catch {}
  }
  return [];
}

function buildClusterSummary(assignments, infoById) {
  if (!Array.isArray(assignments) || assignments.length === 0) return [];
  const info = infoById instanceof Map ? infoById : new Map();
  const byCluster = new Map();
  for (const a of assignments) {
    const cid = a.cluster_id;
    if (!byCluster.has(cid)) byCluster.set(cid, []);
    byCluster.get(cid).push(a);
  }
  const out = [];
  for (const [cluster_id, members] of byCluster.entries()) {
    members.sort((x, y) => (y.similarity_to_seed || 0) - (x.similarity_to_seed || 0));
    const sources = {};
    for (const m of members) {
      const src = info.get(m.signal_id)?.source_name || "unknown";
      sources[src] = (sources[src] || 0) + 1;
    }
    const source_breakdown = Object.entries(sources).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}*${n}`).join(", ");
    const sample_titles = members.slice(0, 3).map((m) => (info.get(m.signal_id)?.title || "").slice(0, 100));
    out.push({ cluster_id, size: members.length, source_breakdown, sample_titles });
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Step entrypoint
// ─────────────────────────────────────────────────────────────────────

const PROMPT_KEY = "distillation.lead.system";

export default defineComponent({
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    event: { type: "any" },
    signal_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
    cluster_rows: { type: "any", optional: true },
    prompts_rows: { type: "any", label: "DIM_LLM_PROMPT rows" },
    examples_rows: { type: "any", label: "V_VALUABLE_TREND_EXAMPLES rows", optional: true },
    subagent_url: { type: "string", label: "Distillation subagent endpoint" },
    bluesky_url: { type: "string", label: "Search Bluesky tool endpoint", optional: true },
    gdelt_url: { type: "string", label: "Search GDELT tool endpoint", optional: true },
    gtrends_url: { type: "string", label: "Search Google Trends tool endpoint", optional: true },
    grok_url: { type: "string", label: "Grok Live Search tool endpoint", optional: true },
  },
  async run({ steps, $ }) {
    // Read bulk inputs directly from prior steps' $return_value rather than via
    // props: at a 1600-signal pool the event bundle (cluster_rows + signal_ids),
    // signal_rows, and cluster_rows each exceed Pipedream's ~512KB prop cap.
    // Mirrors the steps.$return_value pattern used elsewhere (e.g.
    // upsert_signals). Props remain as optional fallbacks for back-compat.
    const hr = steps?.handle_request?.$return_value || {};
    const evt = this.event || hr;
    const dryRun = evt.dry_run === true;
    const started = Date.now();

    const cluster_assignments = parseClusterRows(this.cluster_rows ?? hr.cluster_rows);
    const cluster_lookup = new Map(cluster_assignments.map((c) => [c.signal_id, c]));

    const signalRows = (Array.isArray(this.signal_rows) && this.signal_rows.length)
      ? this.signal_rows
      : (steps?.q_fetch_signals?.$return_value || []);
    const signal_pool = (Array.isArray(signalRows) ? signalRows : []).map((r) => {
      const c = cluster_lookup.get(r.SIGNAL_ID);
      return {
        signal_id: r.SIGNAL_ID, source_name: r.SOURCE_NAME, title: r.SIGNAL_TITLE,
        body: r.SIGNAL_TEXT, detected_at: r.SIGNAL_TIMESTAMP,
        // domain/url now arrive as scalar columns (MD_DOMAIN/MD_URL) from
        // q_fetch_signals — no full METADATA VARIANT shipped. Fall back to the
        // url's hostname when MD_DOMAIN is absent (mirrors the old parser).
        domain: r.MD_DOMAIN || hostnameOf(r.MD_URL), url: r.MD_URL || null,
        cluster_id: c ? c.cluster_id : null,
      };
    });

    // cluster_rows is slimmed (id/cluster_id/similarity only) — look up
    // title/source for the digest from signal_pool by signal_id.
    const infoById = new Map(signal_pool.map((s) => [s.signal_id, s]));
    const cluster_summary = buildClusterSummary(cluster_assignments, infoById);

    // DT_TREND_DASHBOARD columns (post-2026-04-28 refactor):
    //   TREND_NAME (was TREND_TOPIC), HEAT_INDEX (was TREND_HEAT_INDEX),
    //   LAST_LIFECYCLE_EVAL_AT (was LAST_UPDATE_AT)
    const trend_neighbor_pool = (Array.isArray(this.neighbor_rows) ? this.neighbor_rows : []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_NAME,
      total_cluster_size: r.TOTAL_CLUSTER_SIZE,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      trend_heat_index: r.HEAT_INDEX,
      last_update_at: r.LAST_LIFECYCLE_EVAL_AT,
    }));

    const max_signal_ts = signal_pool.reduce((acc, s) => {
      const t = s.detected_at;
      return !acc || (t && t > acc) ? t : acc;
    }, null);

    const context = {
      signal_pool, trend_neighbor_pool,
      proposed_candidates: [],
      agent_session_id: evt.agent_session_id,
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      endpoints: {
        distillation_subagent: this.subagent_url,
        ingest_search_bluesky: this.bluesky_url,
        ingest_search_gdelt: this.gdelt_url,
        ingest_search_google_trends: this.gtrends_url,
        ingest_grok_live_search: this.grok_url,
      },
    };

    const clusterBlock = cluster_summary.length > 0
      ? `Pre-clustered into ${cluster_summary.length} Louvain communities (soft hint — feel free to merge across communities or split within):\n` +
        cluster_summary.map((c) =>
          `  community ${c.cluster_id}: ${c.size} signals, sources [${c.source_breakdown}], e.g. ${c.sample_titles.map((t) => JSON.stringify(t)).join(" / ")}`
        ).join("\n") + "\n\n"
      : "";

    const userMsg = clusterBlock +
      `Pre-fetched pools available to your tools:
  - signal_pool: ${signal_pool.length} signals from STG_EXTERNAL_SIGNALS
  - trend_neighbor_pool: ${trend_neighbor_pool.length} active trends (last 30d) for dedup

Subagent endpoint: ${context.endpoints.distillation_subagent ? "configured" : "NOT CONFIGURED — dispatch_subagent will return errors"}

Begin your scan. Be opinionated about specificity.`;

    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    const valuable_examples = (Array.isArray(this.examples_rows) ? this.examples_rows : [])
      .map((r, i) => {
        const b2b = r.TREND_NAME_B2B || "";
        const b2c = r.TREND_NAME_B2C || "";
        const cat = `${r.CATEGORY || "?"}/${r.SUBCATEGORY || "?"}`;
        const summary = (r.SUMMARY_SHORT || "").replace(/\s+/g, " ").trim().slice(0, 240);
        return `${i + 1}. "${b2b}" / "${b2c}" — ${cat}: ${summary}`;
      })
      .join("\n") || "(no examples available)";

    const renderedSystem = render(prompt.template, { valuable_examples });
    console.log(`Lead system prompt: ${PROMPT_KEY} v${prompt.version} (${this.examples_rows?.length ?? 0} few-shot examples)`);

    if (dryRun) {
      console.log("dry_run=true: skipping LLM");
      return emptyResult({ chain_id: evt.chain_id, max_signal_ts: null, started, signals_seen: signal_pool.length, skipped: "dry_run" });
    }

    let result;
    try {
      result = await runAgentLoop({
        google_gemini: this.google_gemini,
        tool_names: LEAD_TOOL_NAMES,
        system: renderedSystem,
        user_message: userMsg,
        context,
        max_iterations: prompt.params.max_iterations ?? 15,
        budget_usd: evt.budget_usd ?? prompt.params.budget_usd ?? 5.0,
        per_call_max_tokens: evt.per_call_max_tokens || prompt.params.per_call_max_tokens || 8192,
        thinking_level: evt.thinking_level || prompt.params.thinking_level || "medium",
      });
    } catch (e) {
      console.log(`lead loop error: ${e.message}`);
      return emptyResult({ chain_id: evt.chain_id, max_signal_ts, started, signals_seen: signal_pool.length, skipped: "error", error: e.message });
    }

    const candidates = (context.proposed_candidates || []).map((c) => ({
      ...c, reasoning_trace: capTrace(c.reasoning_trace, 30_000),
    }));
    const candidates_json = JSON.stringify(candidates);

    const duration_ms = Date.now() - started;
    console.log(`lead done: candidates=${candidates.length} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms`);
    $.export("$summary", `${candidates.length} candidates, ${result.turns} turns, $${result.cost_usd.toFixed(2)}, ${Math.round(duration_ms / 1000)}s`);

    return {
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      iteration: evt.iteration,
      candidates, candidates_json,
      candidates_count: candidates.length,
      signals_seen: signal_pool.length,
      max_signal_ts, run_duration_ms: duration_ms,
      cost_usd: result.cost_usd, tokens: result.tokens,
      turns: result.turns, stop_reason: result.stop_reason,
      final_text: result.final_text,
      reasoning_trace: capTrace(result.reasoning_trace, 30_000),
      tool_calls_summary: (result.tool_calls || []).map((c) => ({
        turn: c.turn, name: c.name, duration_ms: c.duration_ms,
        input_preview: previewOutput(c.input), output_preview: previewOutput(c.output),
      })),
    };
  },
});

function emptyResult({ chain_id, max_signal_ts, started, signals_seen, skipped, error }) {
  return {
    chain_id,
    candidates: [], candidates_json: "[]", candidates_count: 0,
    signals_seen: signals_seen || 0,
    max_signal_ts, run_duration_ms: Date.now() - started,
    cost_usd: 0, tokens: { input: 0, output: 0, total: 0 },
    turns: 0, stop_reason: skipped, error: error || null,
  };
}

function capTrace(trace, maxBytes) {
  if (!Array.isArray(trace)) return trace;
  const json = JSON.stringify(trace);
  if (json.length <= maxBytes) return trace;
  const compact = trace.map((entry) => entry.kind === "thinking" ? { turn: entry.turn, kind: "thinking", text: (entry.text || "").slice(0, 400) + "…" } : entry);
  const compactJson = JSON.stringify(compact);
  if (compactJson.length <= maxBytes) return compact;
  return compact.slice(-Math.floor(maxBytes / 200));
}

// Domain/url are now extracted as scalar columns (MD_DOMAIN/MD_URL) in
// q_fetch_signals, so the full METADATA VARIANT no longer ships. This is the
// only residual parse: derive a hostname when MD_DOMAIN is null.
function hostnameOf(url) {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}
