// Enrichment Agent — run_enrichment_agent
//
// Single Sonnet 4.6 agent loop that replaces the legacy three-LLM
// cascade (gemini.categorize + grok.cultural + claude.synthesize).
// Reads pre-fetched Snowflake context (one trend's metrics, signals,
// source metrics, neighbors) and produces a single enrichment record
// via the propose_enrichment tool. Live ingest tools (Bluesky / GDELT /
// Google Trends / Grok live search) are available for cultural
// grounding — required by the prompt for whimsical naming.
//
// Output: an object with `enrichment_output` (the agent's record),
// `tokens`, `cost_usd`, `turns`, `stop_reason`, and the standard
// telemetry fields. The downstream `respond` step folds in the name
// reviewer pass before $.respond().
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports (./lib/*, sibling .mjs) all
// fail at deploy time. Canonical source lives at
// /home/marty/dev/Trend-Tree/agents/lib/*.mjs — keep edits in sync.
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
// Tool schemas (subset of agents/lib/tool_catalog.mjs scoped to enrichment)
// ─────────────────────────────────────────────────────────────────────

const QUERY_SCHEMAS = {
  query_trend_neighbors: {
    name: "query_trend_neighbors",
    description:
      "Find trends near (in topic-overlap) the trend currently being enriched. Use BEFORE finalizing category/subcategory to sanity-check that you're not categorizing this trend differently from highly-similar neighbors without specific reason. Returns trend_id, trend_topic, total_cluster_size, velocity_direction, trend_heat_index, similarity_score, plus the neighbor's existing category + subcategory + b2c name when available. Operates on a pre-fetched pool of recent active trends; uses Jaccard token overlap for similarity (Phase 1 — no live embeddings).",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Free-text topic to match against (use the trend's noun-verb description)." },
        k: { type: "integer", description: "Number of neighbors to return (default 5, max 15)." },
        min_similarity: { type: "number", description: "Optional Jaccard cutoff 0.0-1.0 (default 0.0)." },
      },
      required: ["topic"],
    },
  },
  query_trend_metrics: {
    name: "query_trend_metrics",
    description:
      "Look up full metadata for one or more existing trend ids returned by query_trend_neighbors. Returns TREND_TOPIC, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION, TREND_HEAT_INDEX, LAST_UPDATE_AT, plus existing CATEGORY/SUBCATEGORY/SUMMARY_SHORT/TREND_NAME_B2C if enriched.",
    input_schema: {
      type: "object",
      properties: {
        trend_ids: { type: "array", items: { type: "string" }, description: "One or more trend UUIDs from query_trend_neighbors." },
      },
      required: ["trend_ids"],
    },
  },
  query_trend_source_metrics: {
    name: "query_trend_source_metrics",
    description:
      "Look up FCT_TREND_SOURCE_METRICS rows for the trend currently being enriched. Returns one entry per source (gdelt, wikimedia, bluesky, google_trends, amazon, pinterest, tiktok) with headline_metric, headline_metric_name, and the full metrics VARIANT. Reads from a context-provided pool — pre-fetched, not live SQL.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Optional source filter (e.g. 'gdelt')." },
        min_headline_metric: { type: "number", description: "Optional: only return sources with headline_metric >= this value." },
      },
    },
  },
  validate_url_canonical: {
    name: "validate_url_canonical",
    description:
      "Resolve a URL to its canonical form via HEAD request + redirect chase. Returns canonical_url, status, content_type. Use to verify ANY URL before citing it in social_proof, voice_of_customer, or social_narrative — drop URLs that 404 or redirect to login/captcha walls. Times out at 5s per URL.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "One or more URLs to verify (max 10 per call)." },
      },
      required: ["urls"],
    },
  },
};

const INGEST_SCHEMAS = {
  ingest_search_bluesky: {
    name: "ingest_search_bluesky",
    description:
      "Search Bluesky (ATProto) for posts matching a query. Returns up to `limit` posts with author handle, text snippet, like + repost counts, embedded URL, created_at. Latency ~6-8s. PRIMARY tool for voice_of_customer quotes and live cultural language for naming.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Specific multi-word phrase, not a single broad word." },
        limit: { type: "integer", description: "Max posts (default 25, max 100)." },
        sort: { type: "string", enum: ["latest", "top"], description: "Default 'latest'." },
      },
      required: ["query"],
    },
  },
  ingest_search_gdelt: {
    name: "ingest_search_gdelt",
    description:
      "Search GDELT global news index for articles matching a topic. Returns up to ~150 articles with title, domain, url, published_at, language, tone. Latency ~20-30s due to GDELT rate limits. Use for hard-news corroboration of social_proof items.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "GDELT-syntax query (quotes, OR, NEAR/N supported)." },
        window_days: { type: "integer", description: "Days back from today (default 7, max 30)." },
        mode: { type: "string", enum: ["ArtList", "ArtRecent"], description: "Default ArtList (relevance-ranked)." },
      },
      required: ["topic"],
    },
  },
  ingest_search_google_trends: {
    name: "ingest_search_google_trends",
    description:
      "Look up Google Trends interest + related queries for a keyword. Latency ~30-50s (rate-limited). Use sparingly. Useful for confirming search-volume momentum.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        geo: { type: "string", description: "ISO country code (default 'US')." },
        timeframe: { type: "string", description: "Default 'now 7-d'." },
      },
      required: ["keyword"],
    },
  },
  ingest_grok_live_search: {
    name: "ingest_grok_live_search",
    description:
      "Ask Grok 3 to search the live web + X for what's currently being said. Returns {summary, citations: [{url, title, snippet}]}. Fastest of the ingest tools (~3-5s). Call FIRST for cultural grounding before naming.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["web", "x", "both"], description: "Default 'both'." },
      },
      required: ["query"],
    },
  },
};

const ENRICHMENT_SCHEMAS = {
  propose_enrichment: {
    name: "propose_enrichment",
    description:
      "Emit the final enrichment record for this trend. Call this exactly ONCE near the end of the loop after gathering evidence, drafting candidate names with self-critique, validating cited URLs, and finalizing the trend profile. The tool's input schema is the canonical DIM_TREND_ENRICHMENT shape — populate every field that applies. Calling this is what causes the workflow to persist anything; if you don't call it, nothing is written.",
    input_schema: {
      type: "object",
      properties: {
        trend_name_b2b: { type: "string", description: "2-5 words, professional/industry register, evocative not generic. AVOID 'ritual', 'daily', 'moment', 'movement', 'era', 'vibe', 'wave', 'trend' unless paired with something specific and unexpected." },
        trend_name_b2c: { type: "string", description: "2-5 words, consumer-facing, distinctive, has texture. Same anti-cliché rule applies." },
        summary_short: { type: "string", description: "1-2 sentences, action-oriented." },
        summary_long: { type: "string", description: "1 paragraph (≤500 chars), action-oriented." },
        category: { type: "string", enum: ["wellness", "food_beverage", "beauty", "fitness", "fashion", "home_living", "sustainability", "consumer_tech", "personal_care", "social_lifestyle", "entertainment", "travel", "parenting", "other"] },
        subcategory: { type: "string", description: "Lowercase snake_case." },
        category_confidence: { type: "number", description: "0.0-1.0; set <0.6 if you genuinely couldn't fit a category." },
        voice_of_customer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              quote: { type: "string" },
              source_url: { type: "string", description: "Required." },
              platform: { type: "string" },
            },
            required: ["quote", "source_url"],
          },
          description: "3-8 quotes; each MUST have source_url.",
        },
        vibe_shift: { type: "string" },
        social_narrative: {
          type: "array",
          items: {
            type: "object",
            properties: {
              point: { type: "string" },
              evidence_url: { type: "string" },
            },
            required: ["point"],
          },
          description: "3-5 narrative points explaining why this is happening now.",
        },
        cultural_drivers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              driver: { type: "string" },
              influence_level: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["driver", "influence_level"],
          },
        },
        seasonal_relevance: {
          type: "object",
          properties: {
            is_seasonal: { type: "boolean" },
            peak_months: { type: "array", items: { type: "string" } },
          },
          required: ["is_seasonal"],
        },
        geographic_hotspots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              region: { type: "string" },
              intensity: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["region", "intensity"],
          },
        },
        social_proof: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              source_url: { type: "string", description: "Click-through URL — required." },
              source_type: { type: "string", enum: ["news", "social", "search_volume", "commerce", "other"] },
              source_name: { type: "string" },
              captured_at: { type: "string", description: "ISO timestamp." },
            },
            required: ["claim", "source_url", "source_type"],
          },
          description: "≥2 structured proof points with click-throughs.",
        },
        name_candidates_considered: {
          type: "array",
          items: {
            type: "object",
            properties: {
              audience: { type: "string", enum: ["b2b", "b2c"] },
              name: { type: "string" },
              scores: {
                type: "object",
                properties: {
                  distinctiveness: { type: "number" },
                  whimsy: { type: "number" },
                  specificity: { type: "number" },
                },
              },
            },
            required: ["audience", "name", "scores"],
          },
          description: "All 10 candidates (5 b2b + 5 b2c) with per-axis 0-10 scores. Required for naming-quality audit.",
        },
        reasoning: { type: "string", description: "≤500 chars on why these names + categorization fit." },
      },
      required: ["trend_name_b2b", "trend_name_b2c", "summary_short", "summary_long", "category", "subcategory", "category_confidence", "social_proof", "name_candidates_considered", "reasoning"],
    },
  },
};

const META_SCHEMAS = {
  discover_external_tools: {
    name: "discover_external_tools",
    description:
      "Surface schemas of additional tools (web/social/search). Use when you need to gather external evidence and the tool isn't already in your toolbox. Returns the JSON schemas matching `need`; call them by name afterward.",
    input_schema: {
      type: "object",
      properties: {
        need: {
          type: "string",
          enum: ["social", "web", "search", "cultural", "competitive", "all"],
          description: "social → Bluesky; cultural → Bluesky+Grok; search → GDELT+Google Trends+Grok; competitive → Grok+GDELT; all → everything.",
        },
      },
      required: ["need"],
    },
  },
};

const ALL_SCHEMAS = { ...QUERY_SCHEMAS, ...INGEST_SCHEMAS, ...ENRICHMENT_SCHEMAS, ...META_SCHEMAS };

const EAGER_TOOL_NAMES = [
  "query_trend_neighbors",
  "query_trend_metrics",
  "query_trend_source_metrics",
  "validate_url_canonical",
  "discover_external_tools",
  "propose_enrichment",
];

const DEFERRED_BY_NEED = {
  social: ["ingest_search_bluesky"],
  web: ["ingest_grok_live_search", "ingest_search_google_trends"],
  search: ["ingest_search_gdelt", "ingest_grok_live_search", "ingest_search_google_trends"],
  cultural: ["ingest_search_bluesky", "ingest_grok_live_search"],
  competitive: ["ingest_grok_live_search", "ingest_search_gdelt"],
  all: ["ingest_search_bluesky", "ingest_search_gdelt", "ingest_search_google_trends", "ingest_grok_live_search"],
};

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
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function lookupTrendNeighbors(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const { topic, k = 5, min_similarity = 0 } = input || {};
  const cap = Math.min(Number(k) || 5, 15);
  if (!topic) return { error: "topic is required" };
  const queryTokens = tokenize(topic);
  const scored = pool.map((t) => ({
    trend_id: t.trend_id,
    trend_topic: t.trend_topic,
    total_cluster_size: t.total_cluster_size,
    velocity_direction: t.velocity_direction,
    trend_heat_index: t.trend_heat_index,
    last_update_at: t.last_update_at,
    category: t.category,
    subcategory: t.subcategory,
    trend_name_b2c: t.trend_name_b2c,
    summary_short: t.summary_short,
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

function lookupTrendSourceMetrics(input, ctx) {
  const pool = ctx.source_metrics_pool || [];
  const { source, min_headline_metric } = input || {};
  const out = [];
  for (const r of pool) {
    if (source && r.source_name !== source) continue;
    if (typeof min_headline_metric === "number" && Number(r.headline_metric || 0) < min_headline_metric) continue;
    out.push({
      source_name: r.source_name,
      headline_metric: r.headline_metric,
      headline_metric_name: r.headline_metric_name,
      metrics: r.metrics,
    });
  }
  return { source_metrics: out, total_in_pool: pool.length };
}

async function validateUrlCanonical(input) {
  const urls = (input.urls || []).slice(0, 10);
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        clearTimeout(timer);
        return {
          input_url: u,
          canonical_url: resp.url,
          status: resp.status,
          content_type: resp.headers.get("content-type") || null,
        };
      } catch (e) {
        return { input_url: u, error: e.message };
      }
    }),
  );
  return { results };
}

function discoverExternalTools(input) {
  const need = (input.need || "all").toLowerCase();
  const wanted = DEFERRED_BY_NEED[need] || DEFERRED_BY_NEED.all;
  return {
    tools: wanted.map((n) => ALL_SCHEMAS[n]),
    note: `Loaded ${wanted.length} tool(s) for need='${need}'. Call them by name.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// HTTP-side tool implementations
// ─────────────────────────────────────────────────────────────────────

async function postJson(url, body, { timeoutMs = 90_000 } = {}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return { error: `tool endpoint not configured (got '${url}')` };
  }
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
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}: ${text.slice(0, 400)}` };
    }
    return parsed ?? { _raw: text };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function ingestBluesky(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_bluesky, {
    query: input.query,
    limit: input.limit ?? 25,
    sort: input.sort ?? "latest",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}
async function ingestGdelt(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_gdelt, {
    topic: input.topic,
    window_days: input.window_days ?? 7,
    mode: input.mode ?? "ArtList",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 60_000 });
}
async function ingestGoogleTrends(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_google_trends, {
    keyword: input.keyword,
    geo: input.geo ?? "US",
    timeframe: input.timeframe ?? "now 7-d",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 90_000 });
}
async function ingestGrokLive(input, ctx) {
  return postJson(ctx.endpoints?.ingest_grok_live_search, {
    query: input.query,
    mode: input.mode ?? "both",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}

function proposeEnrichment(input, ctx) {
  // Single-shot accumulator: latest call wins (the agent's "final answer").
  ctx.proposed_enrichment = { ...input, emitted_at: new Date().toISOString() };
  return {
    accepted: true,
    note: "Enrichment record captured. The workflow's terminal step will persist it.",
  };
}

const DISPATCHERS = {
  query_trend_neighbors: (input, ctx) => lookupTrendNeighbors(input, ctx),
  query_trend_metrics: (input, ctx) => lookupTrendMetrics(input, ctx),
  query_trend_source_metrics: (input, ctx) => lookupTrendSourceMetrics(input, ctx),
  validate_url_canonical: (input) => validateUrlCanonical(input),
  discover_external_tools: (input) => discoverExternalTools(input),
  ingest_search_bluesky: (input, ctx) => ingestBluesky(input, ctx),
  ingest_search_gdelt: (input, ctx) => ingestGdelt(input, ctx),
  ingest_search_google_trends: (input, ctx) => ingestGoogleTrends(input, ctx),
  ingest_grok_live_search: (input, ctx) => ingestGrokLive(input, ctx),
  propose_enrichment: (input, ctx) => proposeEnrichment(input, ctx),
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
// Anthropic agent loop runtime (Sonnet 4.6 + interleaved thinking)
// (canonical: agents/lib/anthropic_loop.mjs)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";
const BETA_HEADERS = "interleaved-thinking-2025-05-14";

const LOOP_DEFAULTS = {
  max_iterations: 10,
  budget_usd: 0.30,
  per_call_max_tokens: 6000,
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
      throw new Error(`Anthropic fetch failed (turn ${turn}): ${e.message}`);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic HTTP ${resp.status} (turn ${turn}): ${errText.slice(0, 600)}`);
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

const SYSTEM_PROMPT_KEY = "enrichment.agent.system";
const NAMING_GUIDANCE_KEY = "enrichment.agent.naming_guidance";
const USER_PROMPT_KEY = "enrichment.agent.user";

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    event: { type: "any" },
    metrics_rows: { type: "any" },
    queue_rows: { type: "any", optional: true },
    signal_rows: { type: "any", optional: true },
    source_metrics_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
    prompts_rows: { type: "any" },
    examples_rows: { type: "any", optional: true },
    bluesky_url: { type: "string", label: "Search Bluesky tool endpoint" },
    gdelt_url: { type: "string", label: "Search GDELT tool endpoint" },
    gtrends_url: { type: "string", label: "Search Google Trends tool endpoint" },
    grok_url: { type: "string", label: "Grok Live Search tool endpoint" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const trend_id = evt.trend_id;
    const started = Date.now();

    const metricsRow = (this.metrics_rows || [])[0];
    if (!metricsRow) {
      throw new Error(`enrichment: no FCT_TREND_METRICS row for trend_id ${trend_id}`);
    }

    const queueRow = (this.queue_rows || [])[0] || null;
    // ENRICHMENT_TYPE is captured for telemetry/audit but no longer gates
    // the run. The promotion agent only queues trends that need enrichment,
    // so every invocation should run the full agent loop. Legacy values
    // (SOURCES_ONLY, REFRESH) still flow through but are ignored.
    const enrichment_type = (queueRow?.ENRICHMENT_TYPE || evt.enrichment_type || "FULL").toUpperCase();

    // Normalize prefetched pools.
    const source_metrics_pool = (this.source_metrics_rows || []).map((r) => ({
      source_name: r.SOURCE_NAME,
      headline_metric: r.HEADLINE_METRIC,
      headline_metric_name: r.HEADLINE_METRIC_NAME,
      metrics: parseVariant(r.METRICS),
    }));

    const trend_neighbor_pool = (this.neighbor_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      total_cluster_size: r.TOTAL_CLUSTER_SIZE,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      trend_heat_index: r.TREND_HEAT_INDEX,
      last_update_at: r.LAST_UPDATE_AT,
      category: r.CATEGORY,
      subcategory: r.SUBCATEGORY,
      trend_name_b2c: r.TREND_NAME_B2C,
      summary_short: r.SUMMARY_SHORT,
    }));

    const context = {
      source_metrics_pool,
      trend_neighbor_pool,
      proposed_enrichment: null,
      agent_session_id: evt.agent_session_id,
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      endpoints: {
        ingest_search_bluesky: this.bluesky_url,
        ingest_search_gdelt: this.gdelt_url,
        ingest_search_google_trends: this.gtrends_url,
        ingest_grok_live_search: this.grok_url,
      },
    };

    // Build the trend summary block + user message.
    const trend_metadata_json = JSON.stringify({
      trend_id: metricsRow.TREND_ID,
      trend_topic: metricsRow.TREND_TOPIC,
      cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
      distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
      heat_index: metricsRow.TREND_HEAT_INDEX,
      velocity: metricsRow.VELOCITY_DIRECTION,
      detected_at: metricsRow.DETECTED_AT,
      last_update_at: metricsRow.LAST_UPDATE_AT,
    });

    const top_signals_formatted = (this.signal_rows || []).map((s, i) => {
      const head = `${i + 1}. [${s.DOMAIN || "?"}] ${s.TITLE || s.SIGNAL_NAME || "(no title)"} — ${s.URL || "(no url)"}`;
      const body = (s.ARTICLE_BODY || "").trim();
      // Body content is reachable for the subset of prefetched signals where
      // SIGNAL_ID == URL (mostly wikimedia + google_trends_explore + recent
      // bluesky/grok). When present, include a short snippet so the agent
      // has actual context to cite from rather than just title + URL.
      if (body) {
        const snippet = body.replace(/\s+/g, " ").slice(0, 400);
        return `${head}\n     body: "${snippet}${body.length > 400 ? "…" : ""}"`;
      }
      return head;
    }).join("\n") || "(no signals)";

    const source_breakdown_formatted = source_metrics_pool.map((s) =>
      `  • ${s.source_name}: ${s.headline_metric_name || "metric"}=${s.headline_metric ?? "?"}`
    ).join("\n") || "(no source coverage)";

    const related_signals_formatted = (this.signal_rows || []).slice(0, 5).map((s, i) => {
      const md = parseVariant(s.SIGNAL_METADATA) || {};
      const why = md.why_now || md.WHY_NOW || "";
      const pub = md.article_published_date || md.ARTICLE_PUBLISHED_DATE || "";
      return `${i + 1}. ${s.TITLE || ""}${pub ? ` (${pub})` : ""}${why ? ` — why_now: ${why}` : ""}`;
    }).join("\n") || "(no metadata)";

    const neighbors_formatted = trend_neighbor_pool.slice(0, 10).map((n, i) =>
      `${i + 1}. "${n.trend_name_b2c || n.trend_topic}" — ${n.category || "?"}/${n.subcategory || "?"} (heat ${n.trend_heat_index ?? "?"})`
    ).join("\n") || "(no neighbors in window)";

    const trend_summary_block = `TREND_TOPIC: ${metricsRow.TREND_TOPIC}
TREND_ID: ${trend_id}
HEAT_INDEX: ${metricsRow.TREND_HEAT_INDEX} | CLUSTER_SIZE: ${metricsRow.TOTAL_CLUSTER_SIZE} | VELOCITY: ${metricsRow.VELOCITY_DIRECTION}
DETECTED_AT (originally surfaced): ${metricsRow.DETECTED_AT}`;

    // Few-shot examples (optional).
    const valuable_examples = (this.examples_rows || []).map((r, i) => {
      const b2b = r.TREND_NAME_B2B || "";
      const b2c = r.TREND_NAME_B2C || "";
      const cat = `${r.CATEGORY || "?"}/${r.SUBCATEGORY || "?"}`;
      const summary = (r.SUMMARY_SHORT || "").replace(/\s+/g, " ").trim().slice(0, 240);
      return `${i + 1}. "${b2b}" / "${b2c}" — ${cat}: ${summary}`;
    }).join("\n") || "(no examples available)";

    // Load + render prompts.
    const loaded = loadPrompts(this.prompts_rows);
    const systemPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
    const namingGuidance = mustGet(loaded, NAMING_GUIDANCE_KEY);
    const userPrompt = mustGet(loaded, USER_PROMPT_KEY);

    const renderedSystem = render(systemPrompt.template, { valuable_examples, trend_summary_block }) +
      "\n\n" + render(namingGuidance.template, {});

    const renderedUser = render(userPrompt.template, {
      trend_metadata_json,
      top_signals_formatted,
      source_breakdown_formatted,
      related_signals_formatted,
      neighbors_formatted,
      current_date: new Date().toISOString().slice(0, 10),
    });

    console.log(`enrichment system prompt: ${SYSTEM_PROMPT_KEY} v${systemPrompt.version} + ${NAMING_GUIDANCE_KEY} v${namingGuidance.version}`);

    if (evt.dry_run) {
      console.log("dry_run=true: skipping LLM");
      $.export("$summary", `${trend_id}: dry_run`);
      return {
        gated: false,
        enrichment_type,
        enrichment_output: null,
        agent_session_id: evt.agent_session_id,
        chain_id: evt.chain_id,
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
        anthropic: this.anthropic,
        tool_names: EAGER_TOOL_NAMES,
        system: renderedSystem,
        user_message: renderedUser,
        context,
        max_iterations: evt.max_iterations || systemPrompt.params.max_iterations || 10,
        budget_usd: evt.budget_usd || systemPrompt.params.budget_usd || 0.30,
        per_call_max_tokens: systemPrompt.params.per_call_max_tokens || 6000,
        thinking_budget_tokens: systemPrompt.params.thinking_budget_tokens || 4000,
      });
    } catch (e) {
      console.log(`enrichment loop error: ${e.message}`);
      throw e;
    }

    const duration_ms = Date.now() - started;
    const enrichment_output = context.proposed_enrichment;

    if (!enrichment_output) {
      console.log(`enrichment: agent did NOT call propose_enrichment (stop=${result.stop_reason}, turns=${result.turns})`);
    }

    console.log(
      `enrichment done: trend=${trend_id} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms emitted=${!!enrichment_output}`
    );
    $.export("$summary", `${result.turns} turns, $${result.cost_usd.toFixed(3)}, ${Math.round(duration_ms / 1000)}s${enrichment_output ? "" : " — no output"}`);

    return {
      gated: false,
      enrichment_type,
      enrichment_output,
      trend_id,
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      iteration: evt.iteration,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      turns: result.turns,
      stop_reason: result.stop_reason,
      final_text: result.final_text,
      reasoning_trace_size: result.reasoning_trace.length,
      tool_call_count: result.tool_calls.length,
      duration_ms,
      model: result.model,
    };
  },
});

function parseVariant(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}
