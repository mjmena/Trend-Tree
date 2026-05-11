// Lifecycle Attribution Subagent — run_subagent
//
// Gemini 3.1 Pro agent. Receives pre-fetched candidate signals (vector-
// filtered, last 24h, not yet linked to this trend), reasons about which
// genuinely extend the trend topic, and calls commit_attributions exactly
// once with confirmed { signal_id, link_type } pairs.
//
// Early exit: if no candidates arrive, skips LLM entirely (saves cost).
//
// Output: { attributions, attributions_json, attributions_count, tokens, cost_usd, ... }
//
// ─────────────────────────────────────────────────────────────────────
// INLINED helpers — Pipedream requires each step to be self-contained.
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
// Tool schemas
// ─────────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = {
  filter_candidates: {
    name: "filter_candidates",
    description:
      "Slice the prefetched candidate pool by cosine similarity floor or source name. Use to inspect a tighter cut before deciding. Operates on the pre-fetched pool — no live SQL.",
    input_schema: {
      type: "object",
      properties: {
        min_similarity: {
          type: "number",
          description: "Cosine similarity floor (0.0–1.0). Returns only candidates at or above this score.",
        },
        source_filter: {
          type: "string",
          description: "Optional: filter to one source name (e.g. 'gdelt', 'bluesky', 'amazon_trends').",
        },
      },
    },
  },
  commit_attributions: {
    name: "commit_attributions",
    description:
      "Commit confirmed signal-trend links. Call exactly ONCE. Pass an empty array if no candidates qualify — that is a valid and acceptable outcome.",
    input_schema: {
      type: "object",
      properties: {
        attributions: {
          type: "array",
          description: "Array of confirmed attributions. Each element: { signal_id, link_type }.",
          items: {
            type: "object",
            properties: {
              signal_id: { type: "string" },
              link_type: {
                type: "string",
                enum: ["news", "social", "commerce", "other"],
              },
            },
            required: ["signal_id", "link_type"],
          },
        },
      },
      required: ["attributions"],
    },
  },
};

const ALL_TOOL_NAMES = ["filter_candidates", "commit_attributions"];

// ─────────────────────────────────────────────────────────────────────
// In-process tool dispatchers
// ─────────────────────────────────────────────────────────────────────

const VALID_LINK_TYPES = new Set(["news", "social", "commerce", "other"]);

function filterCandidates(input, ctx) {
  const { min_similarity = 0, source_filter } = input || {};
  let pool = [...(ctx.candidate_signals || [])];
  if (min_similarity > 0) pool = pool.filter((s) => s.similarity >= min_similarity);
  if (source_filter) pool = pool.filter((s) => s.source_name === source_filter);
  return { candidates: pool, count: pool.length, total_in_pool: (ctx.candidate_signals || []).length };
}

function commitAttributions(input, ctx) {
  const raw = Array.isArray(input?.attributions) ? input.attributions : [];
  const normalized = raw
    .map((a) => ({
      signal_id: String(a.signal_id || "").trim(),
      link_type: VALID_LINK_TYPES.has(a.link_type) ? a.link_type : "other",
    }))
    .filter((a) => a.signal_id.length > 0);
  ctx.proposed_attributions = normalized;
  return {
    accepted: true,
    count: normalized.length,
    note: "Attributions captured. Commit step will INSERT to FCT_TREND_SIGNALS (LINK_KIND='attributed').",
  };
}

const DISPATCHERS = {
  filter_candidates: (input, ctx) => filterCandidates(input, ctx),
  commit_attributions: (input, ctx) => commitAttributions(input, ctx),
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
// Gemini 3.1 Pro agent loop (identical runtime to lifecycle subagent)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "gemini-3.1-pro-preview";
const RATES_PER_M = { input: 2.0, output: 12.0 };

const LOOP_DEFAULTS = {
  max_iterations: 6,
  budget_usd: 0.04,
  per_call_max_tokens: 2048,
  thinking_level: "medium",
  temperature: 1.0,
  request_timeout_ms: 240_000,
};

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
      responseParts.push({
        functionResponse: {
          name: fc.name,
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

const SYSTEM_PROMPT_KEY = "signal.attribution.system";
const RUBRIC_PROMPT_KEY = "signal.attribution.rubric";
const SIMILARITY_THRESHOLD = "0.45";

function parseVariant(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export default defineComponent({
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    event: { type: "any" },
    trend_context_rows: { type: "any" },
    existing_sources_rows: { type: "any", optional: true },
    candidate_signal_rows: { type: "any", optional: true },
    prompts_rows: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const trend_id = ev.trend_id;
    const started = Date.now();

    const contextRow = (this.trend_context_rows || [])[0];
    if (!contextRow) throw new Error(`attr-sub: no FCT_TRENDS row for trend_id ${trend_id}`);

    const trend = {
      trend_id: contextRow.TREND_ID,
      trend_topic: contextRow.TREND_TOPIC,
      trend_name_b2c: contextRow.TREND_NAME_B2C,
      trend_name_b2b: contextRow.TREND_NAME_B2B,
      category: contextRow.CATEGORY,
      subcategory: contextRow.SUBCATEGORY,
      promoted_at: contextRow.PROMOTED_AT,
      summary_short: contextRow.SUMMARY_SHORT,
      summary_long: contextRow.SUMMARY_LONG,
    };

    const existing_source_types = (this.existing_sources_rows || [])
      .map((r) => r.LINK_TYPE)
      .filter(Boolean);

    const candidate_signals = (this.candidate_signal_rows || []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      signal_timestamp: r.SIGNAL_TIMESTAMP,
      signal_title: r.SIGNAL_TITLE,
      signal_text: r.SIGNAL_TEXT,
      similarity: Number(r.SIMILARITY || 0),
    }));

    // Early exit — no candidates means no work to do
    if (candidate_signals.length === 0) {
      console.log(`attr-sub: trend=${trend_id} no candidate signals — skipping LLM`);
      $.export("$summary", `${trend_id}: no candidates`);
      return {
        attributions: [],
        attributions_json: "[]",
        attributions_count: 0,
        tokens: { input: 0, output: 0, total: 0 },
        cost_usd: 0,
        turns: 0,
        stop_reason: "no_candidates",
        skipped: "no_candidates",
        duration_ms: Date.now() - started,
        model: MODEL,
      };
    }

    if (ev.dry_run) {
      console.log(`attr-sub: trend=${trend_id} dry_run=true — skipping LLM`);
      $.export("$summary", `${trend_id}: dry_run, ${candidate_signals.length} candidates`);
      return {
        attributions: [],
        attributions_json: "[]",
        attributions_count: 0,
        candidate_count: candidate_signals.length,
        tokens: { input: 0, output: 0, total: 0 },
        cost_usd: 0,
        turns: 0,
        stop_reason: "dry_run",
        skipped: "dry_run",
        duration_ms: Date.now() - started,
        model: MODEL,
      };
    }

    // Build context blocks for the system prompt
    const trend_block =
      `TREND_ID: ${trend.trend_id}
TREND_TOPIC: ${trend.trend_topic}
TREND_NAME_B2B / B2C: ${trend.trend_name_b2b || "(unenriched)"} / ${trend.trend_name_b2c || "(unenriched)"}
CATEGORY: ${trend.category || "?"} / ${trend.subcategory || "?"}
PROMOTED_AT: ${trend.promoted_at}
SUMMARY: ${trend.summary_short || "(no summary yet)"}
EXISTING SIGNAL SOURCE TYPES: ${existing_source_types.length ? existing_source_types.join(", ") : "(none yet)"}`;

    const candidate_signals_block = candidate_signals
      .map((s, i) =>
        `${i + 1}. [${s.signal_id}] sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp}\n` +
        `   Title: "${(s.signal_title || "").slice(0, 120)}"\n` +
        `   Text: ${(s.signal_text || "").slice(0, 250)}`
      )
      .join("\n\n");

    // Load + render prompts
    const loaded = loadPrompts(this.prompts_rows);
    const systemPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
    const rubric = mustGet(loaded, RUBRIC_PROMPT_KEY);

    const renderedSystem = render(systemPrompt.template, {
      trend_block,
      candidate_signals_block,
      similarity_threshold: SIMILARITY_THRESHOLD,
      attribution_rubric: rubric.template,
    });

    const userMessage =
      `Evaluate ${candidate_signals.length} candidate signals for trend ${trend_id} ("${trend.trend_topic}"). ` +
      `Apply the attribution rubric to each candidate. ` +
      `Call commit_attributions exactly once with the confirmed list (empty array is a valid outcome).`;

    const context = {
      candidate_signals,
      proposed_attributions: [],
    };

    console.log(
      `attr-sub: trend=${trend_id} candidates=${candidate_signals.length} ` +
      `prompt=${SYSTEM_PROMPT_KEY} v${systemPrompt.version}`
    );

    let result;
    try {
      result = await runAgentLoop({
        google_gemini: this.google_gemini,
        tool_names: ALL_TOOL_NAMES,
        system: renderedSystem,
        user_message: userMessage,
        context,
        max_iterations: systemPrompt.params.max_iterations || LOOP_DEFAULTS.max_iterations,
        budget_usd: ev.budget_usd || systemPrompt.params.budget_usd || LOOP_DEFAULTS.budget_usd,
        per_call_max_tokens: systemPrompt.params.per_call_max_tokens || LOOP_DEFAULTS.per_call_max_tokens,
        thinking_level: systemPrompt.params.thinking_level || LOOP_DEFAULTS.thinking_level,
      });
    } catch (e) {
      console.log(`attr-sub loop error: ${e.message}`);
      throw e;
    }

    const duration_ms = Date.now() - started;
    const attributions = context.proposed_attributions || [];

    if (!attributions.length && !context.proposed_attributions) {
      console.log(`attr-sub: agent did NOT call commit_attributions (stop=${result.stop_reason}, turns=${result.turns})`);
    }

    console.log(
      `attr-sub done: trend=${trend_id} attributed=${attributions.length} ` +
      `candidates=${candidate_signals.length} turns=${result.turns} ` +
      `cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms`
    );

    $.export(
      "$summary",
      `${trend_id}: ${attributions.length}/${candidate_signals.length} attributed, ` +
      `$${result.cost_usd.toFixed(3)}, ${result.turns} turns`
    );

    return {
      attributions,
      attributions_json: JSON.stringify(attributions),
      attributions_count: attributions.length,
      candidate_count: candidate_signals.length,
      trend_id,
      chain_id: ev.chain_id,
      session_id: ev.session_id,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      turns: result.turns,
      stop_reason: result.stop_reason,
      tool_call_count: result.tool_calls.length,
      duration_ms,
      model: result.model,
    };
  },
});
