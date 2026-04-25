// Distillation Lead — run_lead_agent
//
// Orchestrator agent. Sees:
//   - The raw signal window since the cursor (q_signals_window)
//   - The SQL clustering's view of the same window (q_louvain_candidates)
//   - Top active trends for dedup (q_neighbors)
//
// Produces a 3-way bucketing (OVERLAP / AGENT_ONLY / LOUVAIN_ONLY),
// dispatches subagents in parallel via the dispatch_subagent tool (HTTP
// fanout to distillation-subagent-p_jmCjj3J), consolidates verdicts,
// and emits accepted candidates via propose_trend_candidate.
//
// The downstream commit_candidates step bulk-inserts candidates_json into
// STG_TREND_CANDIDATES_AGENT (Phase 1 shadow table — does NOT replace the
// live STG_TREND_CANDIDATES yet).
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports (./lib/*, sibling .js, sibling
// .mjs) all fail at deploy time. Canonical source for the helpers lives at
// /home/marty/dev/Trend-Tree/agents/lib/*.mjs — keep edits in sync.
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// fanoutSubagents — Promise.all helper for parallel subagent HTTP calls
// ─────────────────────────────────────────────────────────────────────

async function fanoutSubagents({
  url,
  dispatches,
  concurrency = 10,
  perCallTimeoutMs = 240_000,
}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return {
      error: `subagent endpoint not configured (got '${url}'). Set DISTILLATION_SUBAGENT_URL env var.`,
      results: [],
    };
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
          results[idx] = {
            hypothesis: body.hypothesis,
            bucket: body.bucket,
            error: `HTTP ${resp.status}: ${text.slice(0, 240)}`,
            duration_ms: Date.now() - started,
          };
        } else {
          results[idx] = {
            hypothesis: body.hypothesis,
            bucket: body.bucket,
            duration_ms: Date.now() - started,
            ...parsed,
          };
        }
      } catch (e) {
        results[idx] = {
          hypothesis: body.hypothesis,
          bucket: body.bucket,
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

  const summary = {
    dispatched: dispatches.length,
    succeeded: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    by_verdict: {},
  };
  for (const r of results) {
    const v = r?.verdict || (r?.error ? "ERROR" : "UNKNOWN");
    summary.by_verdict[v] = (summary.by_verdict[v] || 0) + 1;
  }
  return { results, summary };
}

// ─────────────────────────────────────────────────────────────────────
// Tool catalog — schemas + dispatchers
// ─────────────────────────────────────────────────────────────────────

const QUERY_SCHEMAS = {
  query_signals_window: {
    name: "query_signals_window",
    description:
      "Filter the pre-fetched signal window (recent unclustered/clustered signals from STG_EXTERNAL_SIGNALS) by source, domain, time window, or full-text match against title/body. Returns up to `limit` signal records with id, title, source, domain, detected_at, and a snippet. Use this to scan the firehose, find specific patterns, or look up a specific signal by id. Note: this tool reads from a context-provided pool, not live Snowflake.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Optional source filter: gdelt | bluesky | tiktok | reddit | google_trends | wikimedia | amazon | pinterest. Omit to span all sources." },
        domain_contains: { type: "string", description: "Optional substring match against signal domain (e.g. 'reddit.com', 'wsj')." },
        text_contains: { type: "string", description: "Optional case-insensitive substring match against signal title and body." },
        signal_ids: { type: "array", items: { type: "string" }, description: "Optional list of signal UUIDs to look up directly." },
        limit: { type: "integer", description: "Max signals to return (default 25, hard cap 100)." },
      },
    },
  },
  query_louvain_candidates: {
    name: "query_louvain_candidates",
    description:
      "Return the SQL clustering's view of the same signal window, as a list of candidate clusters. Each cluster comes with cluster_id, centroid_topic, signal_ids, signal_count, distinct_source_count, and top_domains. Use this to (a) cross-reference your raw-signal hypotheses against the embedding math, (b) discover Louvain-only clusters you missed in your scan, and (c) inspect Louvain clusters that look too broad for splitting.",
    input_schema: {
      type: "object",
      properties: {
        min_signal_count: { type: "integer", description: "Filter to clusters with at least this many signals (default 3)." },
        contains_signal_id: { type: "string", description: "Optional: return only the cluster containing this signal id." },
      },
    },
  },
  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description:
      "Find the k existing trends closest to a candidate topic or signal cluster. Returns trend_id, trend_topic, total_cluster_size, velocity_direction, trend_heat_index, and similarity_score. Use this BEFORE writing a new candidate to check whether the pattern is actually a duplicate or significant overlap of an existing trend. Operates against a pre-fetched pool of recent active trends.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Free-text topic description to match against. Required if signal_ids is omitted." },
        signal_ids: { type: "array", items: { type: "string" }, description: "Alternative to topic: pass signal ids and the tool computes a centroid from them." },
        k: { type: "integer", description: "Number of neighbors to return (default 5, max 20)." },
        min_similarity: { type: "number", description: "Optional cutoff (0.0-1.0)." },
      },
    },
  },
  query_trend_metrics: {
    name: "query_trend_metrics",
    description:
      "Look up full metadata for one or more existing trend ids: TREND_TOPIC, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION, TREND_HEAT_INDEX. Use after query_trend_neighbors returns a near-match.",
    input_schema: {
      type: "object",
      properties: {
        trend_ids: { type: "array", items: { type: "string" }, description: "One or more existing trend UUIDs." },
      },
      required: ["trend_ids"],
    },
  },
  validate_dedupe_pair: {
    name: "validate_dedupe_pair",
    description:
      "Compute token-overlap (Phase 1) between a proposed candidate and an existing trend. Returns numeric scores only — does NOT make a merge/separate decision; that's your call.",
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
    description:
      "Resolve a URL to its canonical form via HEAD request. Returns canonical_url, status, content_type. Use to dedupe signals via syndication paths. Times out at 5s per URL.",
    input_schema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" }, description: "Up to 10 URLs." } },
      required: ["urls"],
    },
  },
};

const INGEST_SCHEMAS = {
  ingest_search_bluesky: {
    name: "ingest_search_bluesky",
    description: "Search Bluesky (ATProto searchPosts). Returns up to `limit` posts. ~6-8s. Writes results to STG_EXTERNAL_SIGNALS tagged with current agent_session_id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search; use specific multi-word phrases." },
        limit: { type: "integer" },
        sort: { type: "string", enum: ["latest", "top"] },
      },
      required: ["query"],
    },
  },
  ingest_search_gdelt: {
    name: "ingest_search_gdelt",
    description: "Search GDELT global news index. Returns up to ~150 articles. ~20-30s due to rate limits. Writes to STG_EXTERNAL_SIGNALS tagged with current agent_session_id.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        window_days: { type: "integer" },
        mode: { type: "string", enum: ["ArtList", "ArtRecent"] },
      },
      required: ["topic"],
    },
  },
  ingest_search_google_trends: {
    name: "ingest_search_google_trends",
    description: "Look up Google Trends interest + related queries. ~30-50s due to rate limits. Use sparingly.",
    input_schema: {
      type: "object",
      properties: { keyword: { type: "string" }, geo: { type: "string" }, timeframe: { type: "string" } },
      required: ["keyword"],
    },
  },
  ingest_grok_live_search: {
    name: "ingest_grok_live_search",
    description: "Grok 3 live web/X search. Fastest (~3-5s). Use as FIRST corroboration before GDELT/Google Trends.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, mode: { type: "string", enum: ["web", "x", "both"] } },
      required: ["query"],
    },
  },
};

const LEAD_ONLY_SCHEMAS = {
  dispatch_subagent: {
    name: "dispatch_subagent",
    description:
      "Send one or more hypotheses to the distillation subagent for deep investigation. Each dispatch is a candidate trend with bucket label (OVERLAP | AGENT_ONLY | LOUVAIN_ONLY). Subagents run in parallel (concurrency 10) and each returns a verdict + refined candidates.",
    input_schema: {
      type: "object",
      properties: {
        dispatches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hypothesis: { type: "string" },
              signal_ids: { type: "array", items: { type: "string" } },
              bucket: { type: "string", enum: ["OVERLAP", "AGENT_ONLY", "LOUVAIN_ONLY"] },
              budget_tokens: { type: "integer" },
            },
            required: ["hypothesis", "signal_ids", "bucket"],
          },
        },
      },
      required: ["dispatches"],
    },
  },
  propose_trend_candidate: {
    name: "propose_trend_candidate",
    description:
      "Add a candidate trend to the run's output. Call once per accepted candidate AFTER validating specificity and dedup. Be opinionated: only propose if it passes the noun-verb specificity rubric.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Specific noun-verb behavior, ≤80 chars." },
        supporting_signal_ids: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        specificity_score: { type: "number" },
        bucket: { type: "string", enum: ["OVERLAP", "AGENT_ONLY", "LOUVAIN_ONLY"] },
        verdict: { type: "string", enum: ["REAL_TREND", "DUPLICATE_OF"] },
        dedup_of_trend_id: { type: "string" },
        source_breakdown: { type: "object" },
        evidence_added: { type: "array" },
        reasoning: { type: "string", description: "≤500 char rationale." },
      },
      required: ["topic", "supporting_signal_ids", "confidence", "specificity_score", "bucket", "verdict", "reasoning"],
    },
  },
};

const META_SCHEMAS = {
  discover_external_tools: {
    name: "discover_external_tools",
    description:
      "Surface schemas of additional tools you can call. Use when you need external evidence and the tool isn't in your toolbox.",
    input_schema: {
      type: "object",
      properties: {
        need: { type: "string", enum: ["social", "web", "search", "cultural", "competitive", "all"] },
      },
      required: ["need"],
    },
  },
};

const EAGER_TOOL_NAMES = [
  "query_signals_window",
  "query_louvain_candidates",
  "query_trend_neighbors",
  "query_trend_metrics",
  "validate_dedupe_pair",
  "validate_url_canonical",
  "discover_external_tools",
];
const LEAD_TOOL_NAMES = [
  ...EAGER_TOOL_NAMES,
  "dispatch_subagent",
  "propose_trend_candidate",
];

const DEFERRED_BY_NEED = {
  social: ["ingest_search_bluesky"],
  web: ["ingest_grok_live_search", "ingest_search_google_trends"],
  search: ["ingest_search_gdelt", "ingest_grok_live_search", "ingest_search_google_trends"],
  cultural: ["ingest_search_bluesky", "ingest_grok_live_search"],
  competitive: ["ingest_grok_live_search", "ingest_search_gdelt"],
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

// In-process tool implementations

function tokenize(s) {
  return new Set(
    String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3),
  );
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
  const { source, domain_contains, text_contains, signal_ids, limit = 25 } = input || {};
  const cap = Math.min(Number(limit) || 25, 100);
  const ids = signal_ids ? new Set(signal_ids) : null;
  const txt = text_contains ? text_contains.toLowerCase() : null;
  const out = [];
  for (const s of pool) {
    if (out.length >= cap) break;
    if (ids && !ids.has(s.signal_id)) continue;
    if (source && s.source_name !== source) continue;
    if (domain_contains && !(s.domain || "").toLowerCase().includes(domain_contains.toLowerCase())) continue;
    if (txt) {
      const hay = `${s.title || ""} ${s.body || ""}`.toLowerCase();
      if (!hay.includes(txt)) continue;
    }
    out.push({
      signal_id: s.signal_id, title: s.title, source: s.source_name, domain: s.domain,
      detected_at: s.detected_at, snippet: (s.body || s.title || "").slice(0, 240), url: s.url,
    });
  }
  return { signals: out, total_in_pool: pool.length, returned: out.length };
}

function lookupLouvain(input, ctx) {
  const pool = ctx.louvain_pool || [];
  const { min_signal_count = 3, contains_signal_id } = input || {};
  const out = [];
  for (const c of pool) {
    if ((c.signal_count || (c.signal_ids || []).length) < min_signal_count) continue;
    if (contains_signal_id && !(c.signal_ids || []).includes(contains_signal_id)) continue;
    out.push({
      cluster_id: c.cluster_id, centroid_topic: c.centroid_topic, signal_ids: c.signal_ids,
      signal_count: c.signal_count || (c.signal_ids || []).length,
      distinct_source_count: c.distinct_source_count, top_domains: c.top_domains,
    });
  }
  return { clusters: out, total_in_pool: pool.length };
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
    note: "Embedding cosine not computed in Phase 1; use jaccard + your own judgment.",
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
  return {
    tools: wanted.map((n) => ALL_SCHEMAS[n]),
    note: `Loaded ${wanted.length} tool(s) for need='${need}'.`,
  };
}

async function postJson(url, body, { timeoutMs = 90_000 } = {}) {
  if (!url || /PLACEHOLDER/i.test(url)) return { error: `tool endpoint not configured (got '${url}')` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${text.slice(0, 400)}` };
    return parsed ?? { _raw: text };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function ingestBluesky(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_bluesky, {
    query: input.query, limit: input.limit ?? 25, sort: input.sort ?? "latest",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}
async function ingestGdelt(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_gdelt, {
    topic: input.topic, window_days: input.window_days ?? 7, mode: input.mode ?? "ArtList",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 60_000 });
}
async function ingestGoogleTrends(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_google_trends, {
    keyword: input.keyword, geo: input.geo ?? "US", timeframe: input.timeframe ?? "now 7-d",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 90_000 });
}
async function ingestGrokLive(input, ctx) {
  return postJson(ctx.endpoints?.ingest_grok_live_search, {
    query: input.query, mode: input.mode ?? "both",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
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
    concurrency: 10, perCallTimeoutMs: 240_000,
  });
}

function proposeTrendCandidate(input, ctx) {
  ctx.proposed_candidates = ctx.proposed_candidates || [];
  ctx.proposed_candidates.push({
    ...input, candidate_id: cryptoRandomId(),
    chain_id: ctx.chain_id, iteration: ctx.iteration, agent_session_id: ctx.agent_session_id,
  });
  return {
    accepted: true, accepted_count: ctx.proposed_candidates.length,
    candidate_id: ctx.proposed_candidates[ctx.proposed_candidates.length - 1].candidate_id,
  };
}

const DISPATCHERS = {
  query_signals_window: (input, ctx) => lookupSignals(input, ctx),
  query_louvain_candidates: (input, ctx) => lookupLouvain(input, ctx),
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
// Anthropic agent loop runtime (Sonnet 4.6 + interleaved thinking)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";
const BETA_HEADERS = "interleaved-thinking-2025-05-14";

const LOOP_DEFAULTS = {
  max_iterations: 12,
  budget_usd: 5.0,
  per_call_max_tokens: 8192,
  thinking_budget_tokens: 4000,
  temperature: 1.0,
  request_timeout_ms: 180_000,
};

async function runAgentLoop({
  anthropic, tool_names, system, user_message, context,
  max_iterations = LOOP_DEFAULTS.max_iterations,
  budget_usd = LOOP_DEFAULTS.budget_usd,
  per_call_max_tokens = LOOP_DEFAULTS.per_call_max_tokens,
  thinking_budget_tokens = LOOP_DEFAULTS.thinking_budget_tokens,
}) {
  if (!anthropic?.$auth?.api_key) throw new Error("anthropic app prop missing $auth.api_key");
  if (!Array.isArray(tool_names) || tool_names.length === 0) throw new Error("tool_names is required");

  const tools = getToolSchemas(tool_names);
  const messages = [{
    role: "user",
    content: typeof user_message === "string" ? [{ type: "text", text: user_message }] : user_message,
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
      model: MODEL, max_tokens: per_call_max_tokens, system, messages, tools,
      tool_choice: { type: "auto" }, temperature: LOOP_DEFAULTS.temperature,
      thinking: { type: "enabled", budget_tokens: thinking_budget_tokens },
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LOOP_DEFAULTS.request_timeout_ms);
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropic.$auth.api_key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": BETA_HEADERS,
        },
        body: JSON.stringify(reqBody),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      stop_reason = "fetch_error";
      reasoning_trace.push({ turn, kind: "error", error: e.message });
      break;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      stop_reason = `http_${resp.status}`;
      reasoning_trace.push({ turn, kind: "error", error: errText.slice(0, 1000) });
      break;
    }

    const data = await resp.json();
    const usage = data.usage || {};
    const tin = usage.input_tokens || 0;
    const tout = usage.output_tokens || 0;
    tokens.input += tin;
    tokens.output += tout;
    tokens.total = tokens.input + tokens.output;
    cost_usd += (tin / 1_000_000) * RATES_PER_M.input + (tout / 1_000_000) * RATES_PER_M.output;

    const content = Array.isArray(data.content) ? data.content : [];
    for (const block of content) {
      if (block.type === "thinking") {
        reasoning_trace.push({ turn, kind: "thinking", text: block.thinking, signature: block.signature });
      } else if (block.type === "text") {
        reasoning_trace.push({ turn, kind: "text", text: block.text });
        final_text = block.text;
      } else if (block.type === "tool_use") {
        reasoning_trace.push({ turn, kind: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    messages.push({ role: "assistant", content });

    if (data.stop_reason === "tool_use") {
      const toolUses = content.filter((b) => b.type === "tool_use");
      const toolResults = [];
      const dispatched = await Promise.all(toolUses.map(async (tu) => {
        const started = Date.now();
        const out = await dispatchTool(tu.name, tu.input, context);
        const duration_ms = Date.now() - started;
        tool_calls.push({ turn, name: tu.name, input: tu.input, output: out, duration_ms });
        return { id: tu.id, name: tu.name, output: out };
      }));
      for (const d of dispatched) {
        toolResults.push({
          type: "tool_result", tool_use_id: d.id,
          content: typeof d.output === "string" ? d.output : JSON.stringify(d.output),
          is_error: !!(d.output && d.output.error),
        });
        reasoning_trace.push({ turn, kind: "tool_result", id: d.id, name: d.name, output_preview: previewOutput(d.output) });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    stop_reason = data.stop_reason || "end_turn";
    break;
  }

  if (turn >= max_iterations && stop_reason === "max_iterations") {
    reasoning_trace.push({ turn, kind: "stop", reason: "max_iterations" });
  }

  return {
    stop_reason, turns: turn, tokens,
    cost_usd: Math.round(cost_usd * 10000) / 10000,
    reasoning_trace, tool_calls, final_text, model: MODEL,
  };
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
// Step entrypoint
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the lead orchestrator of a consumer-trends distillation pipeline. Every 1-2 hours you wake up to the firehose: thousands of fresh signals from headlines, Bluesky, GDELT, Google Trends, and more. Your job is to distill SPECIFIC, ACTIONABLE consumer trends from this firehose. You have a SQL Louvain clustering's output as one input among many — you can override it.

═══════════════════════════════════════════════════════════════════════
SPECIFICITY RUBRIC — the single most important rule
═══════════════════════════════════════════════════════════════════════
A trend is a SPECIFIC consumer behavior, product use case, aesthetic, or
cultural pattern that brands could meaningfully act on within 30-180 days.
A trend has a noun phrase you can put on a slide and a verb a consumer is doing.

GOOD examples — the bar:
  • "Cottage cheese as high-protein snack replacement (women 25-45)"
  • "Mouth taping for sleep optimization"
  • "Mob wife aesthetic — fur, gold, dramatic lip (winter 2026 revival)"
  • "Pickleball-specific apparel emerging beyond core-player niche"
  • "Fiber-maxxing — adding psyllium/chia to everything"
  • "Sleepy girl mocktail (tart cherry + magnesium)"

BAD examples — REJECT these:
  • "Wellness" / "Health & wellness" — category, not behavior
  • "AI productivity tools" — category
  • "Beauty trends" — category
  • "Sustainable fashion" — category
  • "Mental health awareness" — discourse, not behavior
  • "Politics" / "Elections" / "[Celebrity] news cycle" — news, not durable

═══════════════════════════════════════════════════════════════════════
YOUR PROCESS
═══════════════════════════════════════════════════════════════════════
1. CALL query_signals_window with no filter (or a broad sample) to inspect the
   recent signals. Look for noun-verb consumer behaviors that recur or that 3+
   independent signals point to. Form 20-80 candidate hypotheses.

2. CALL query_louvain_candidates to see what the SQL clustering thinks. Each
   cluster has a centroid_topic + signal_ids + signal_count + top_domains.

3. RECONCILE into three buckets:
   - OVERLAP: Your hypothesis maps onto a Louvain cluster. Mark for validation.
   - AGENT_ONLY: Your hypothesis has no Louvain match. These are the
     emergent-signal candidates Louvain missed (your scan caught a pattern
     with too little volume for community detection).
   - LOUVAIN_ONLY: A Louvain cluster you didn't independently propose.
     Usually these are category-level conflations the math made.

4. DISPATCH SUBAGENTS in parallel via dispatch_subagent. One dispatch per
   hypothesis, with the bucket label and supporting signal_ids. Subagents
   gather extra evidence (ingest tools), validate specificity, and return
   verdicts + refined candidates. Concurrency cap is 10 in flight.

5. CONSOLIDATE results. Subagents have already proposed candidates into the
   shared accumulator via propose_trend_candidate. You can also propose
   directly if you want to add or override (e.g. when subagents return
   conflicting verdicts you want to settle).

6. END your turn with a brief text block summarizing: signals seen, hypotheses
   formed, dispatches sent, accepted candidates by bucket.

═══════════════════════════════════════════════════════════════════════
GUARDRAILS
═══════════════════════════════════════════════════════════════════════
- Don't propose categories. The dashboard already has tags for that.
- Don't propose duplicates of existing trends — call query_trend_neighbors first.
- Be opinionated about specificity. Reject more than you accept.
- Phase 1 EXPLICITLY values recall on weak emergent signals — when an
  AGENT_ONLY hypothesis has 3-5 independent specific signals, dispatch a
  subagent to corroborate rather than dismiss it.
- Budget: keep total LLM spend under $5/run. Subagents cost ~$0.20 each;
  prefer 30-60 dispatches max.`;

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    event: { type: "any" },
    cursor_rows: { type: "any", optional: true },
    signal_rows: { type: "any", optional: true },
    louvain_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const dryRun = evt.dry_run === true;
    const started = Date.now();

    const signal_pool = (Array.isArray(this.signal_rows) ? this.signal_rows : []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      title: r.SIGNAL_TITLE,
      body: r.SIGNAL_TEXT,
      detected_at: r.SIGNAL_TIMESTAMP,
      domain: tryParseMetadataDomain(r.METADATA),
      url: tryParseMetadataUrl(r.METADATA),
    }));
    const louvain_pool = (Array.isArray(this.louvain_rows) ? this.louvain_rows : []).map((r) => ({
      cluster_id: r.CLUSTER_ID,
      centroid_topic: r.CENTROID_TOPIC,
      signal_count: r.SIGNAL_COUNT,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      heat_index: r.TREND_HEAT_INDEX,
      detected_at: r.DETECTED_AT,
      signal_ids: r.SIGNAL_IDS || [],
      top_domains: r.TOP_DOMAINS || [],
    }));
    const trend_neighbor_pool = (Array.isArray(this.neighbor_rows) ? this.neighbor_rows : []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      total_cluster_size: r.TOTAL_CLUSTER_SIZE,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      trend_heat_index: r.TREND_HEAT_INDEX,
      last_update_at: r.LAST_UPDATE_AT,
    }));

    const max_signal_ts = signal_pool.reduce((acc, s) => {
      const t = s.detected_at;
      return !acc || (t && t > acc) ? t : acc;
    }, null);

    const context = {
      signal_pool, louvain_pool, trend_neighbor_pool,
      proposed_candidates: [],
      agent_session_id: evt.agent_session_id,
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      endpoints: {
        // Defaults are the live trigger endpoints; env vars win for staging/canary.
        distillation_subagent: process.env.DISTILLATION_SUBAGENT_URL || "https://eo5h5le4j2qu3tm.m.pipedream.net",
        ingest_search_bluesky: process.env.INGEST_SEARCH_BLUESKY_URL || "https://eoydyalz1dslfre.m.pipedream.net",
        ingest_search_gdelt: process.env.INGEST_SEARCH_GDELT_URL || "https://eoovhehfk229jrg.m.pipedream.net",
        ingest_search_google_trends: process.env.INGEST_SEARCH_GOOGLE_TRENDS_URL || "https://eov9u8rngcgi2z6.m.pipedream.net",
        ingest_grok_live_search: process.env.INGEST_GROK_LIVE_SEARCH_URL || "https://eovzc5ljf76h3h6.m.pipedream.net",
      },
    };

    const userMsg = `Window starts at ${this.cursor_rows?.[0]?.WINDOW_START_TS || "(none)"}.
Pre-fetched pools available to your tools:
  - signal_pool: ${signal_pool.length} raw signals from STG_EXTERNAL_SIGNALS (agent-fetched evidence excluded)
  - louvain_pool: ${louvain_pool.length} clusters from FCT_TREND_METRICS in this window
  - trend_neighbor_pool: ${trend_neighbor_pool.length} active trends (last 30d) for dedup

Subagent endpoint: ${context.endpoints.distillation_subagent ? "configured" : "NOT CONFIGURED — dispatch_subagent will return errors"}

Begin your scan. Be opinionated about specificity.`;

    if (dryRun) {
      console.log("dry_run=true: skipping LLM");
      return emptyResult({ chain_id: evt.chain_id, max_signal_ts, started, signals_seen: signal_pool.length, skipped: "dry_run" });
    }

    let result;
    try {
      result = await runAgentLoop({
        anthropic: this.anthropic,
        tool_names: LEAD_TOOL_NAMES,
        system: SYSTEM_PROMPT,
        user_message: userMsg,
        context,
        max_iterations: 15,
        budget_usd: evt.budget_remaining_usd ?? evt.budget_usd ?? 5.0,
        per_call_max_tokens: evt.per_call_max_tokens || 8192,
        thinking_budget_tokens: evt.thinking_budget_tokens || 5000,
      });
    } catch (e) {
      console.log(`lead loop error: ${e.message}`);
      return emptyResult({
        chain_id: evt.chain_id, max_signal_ts, started,
        signals_seen: signal_pool.length, skipped: "error", error: e.message,
      });
    }

    const candidates = (context.proposed_candidates || []).map((c) => ({
      ...c, reasoning_trace: capTrace(c.reasoning_trace, 30_000),
    }));
    const candidates_json = JSON.stringify(candidates);

    const duration_ms = Date.now() - started;
    console.log(
      `lead done: candidates=${candidates.length} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms`,
    );
    $.export(
      "$summary",
      `${candidates.length} candidates, ${result.turns} turns, $${result.cost_usd.toFixed(2)}, ${Math.round(duration_ms / 1000)}s`,
    );

    return {
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      iteration: evt.iteration,
      candidates, candidates_json,
      candidates_count: candidates.length,
      signals_seen: signal_pool.length,
      louvain_seen: louvain_pool.length,
      max_signal_ts, run_duration_ms: duration_ms,
      cost_usd: result.cost_usd, tokens: result.tokens,
      turns: result.turns, stop_reason: result.stop_reason,
      final_text: result.final_text,
      reasoning_trace_size: result.reasoning_trace.length,
      tool_call_count: result.tool_calls.length,
    };
  },
});

function emptyResult({ chain_id, max_signal_ts, started, signals_seen, skipped, error }) {
  return {
    chain_id,
    candidates: [], candidates_json: "[]", candidates_count: 0,
    signals_seen: signals_seen || 0, louvain_seen: 0,
    max_signal_ts, run_duration_ms: Date.now() - started,
    cost_usd: 0, tokens: { input: 0, output: 0, total: 0 },
    turns: 0, stop_reason: skipped, error: error || null,
  };
}

function capTrace(trace, maxBytes) {
  if (!Array.isArray(trace)) return trace;
  const json = JSON.stringify(trace);
  if (json.length <= maxBytes) return trace;
  const compact = trace.map((entry) =>
    entry.kind === "thinking"
      ? { turn: entry.turn, kind: "thinking", text: (entry.text || "").slice(0, 400) + "…" }
      : entry,
  );
  const compactJson = JSON.stringify(compact);
  if (compactJson.length <= maxBytes) return compact;
  return compact.slice(-Math.floor(maxBytes / 200));
}

function tryParseMetadataDomain(md) {
  try {
    const m = typeof md === "string" ? JSON.parse(md) : md;
    return m?.domain || (m?.url ? new URL(m.url).hostname : null);
  } catch { return null; }
}
function tryParseMetadataUrl(md) {
  try {
    const m = typeof md === "string" ? JSON.parse(md) : md;
    return m?.url || m?.uri || m?.embedded_url || null;
  } catch { return null; }
}
