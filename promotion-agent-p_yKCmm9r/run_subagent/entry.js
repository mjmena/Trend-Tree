// Promotion Subagent — run_subagent
//
// Verifier loop: Gemini 3.1 Pro reads distillation's recommendation + the surfaced
// neighbor pool, then decides PROMOTE_NEW / MERGE_INTO_EXISTING / REJECT / DEFER.
//
// Tools:
//   - compare_topics        — pairwise topic-judgment between candidate and one neighbor
//   - query_neighbor_details — look up full info on a specific neighbor
//   - propose_decision      — terminal action; populates ctx.decision and ends the loop
//
// Anti-hallucination: target_trend_id for MERGE_INTO_EXISTING must be one of
// the trend_ids in the supplied neighbor_pool. Validated both here and in
// PROC_PROMOTION_APPLY.
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports fail at deploy time. Canonical
// source for the helpers lives at /home/marty/dev/Trend-Tree/agents/lib/
// — keep edits in sync.
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// prompt_loader (canonical source: agents/lib/prompt_loader.mjs)
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
    throw new Error(
      `Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT has IS_ACTIVE=TRUE for this key and the q_load_prompts step's WHERE clause includes it.`,
    );
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// Exploding Topics adapter (canonical source: agents/lib/exploding_topics.mjs)
// The corroboration oracle (ADR-0004). Pure normalizer + request builder.
// ET is queried by the [candidate query]; a positive verdict earns a
// single-family candidate its missing second source family. ET is NOT a
// [Source] — it never writes FCT_SIGNALS / SOURCE_BREAKDOWN.
// ─────────────────────────────────────────────────────────────────────

const ET_BASE_URL = "https://api.explodingtopics.com/api/v1";
// ET is behind Cloudflare and SILENTLY 403s default library User-Agents.
const ET_BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Both returned with HTTP 200 (not 404).
const ET_MISS_MESSAGES = ["No meta trends found.", "No topic found."];
// Absolute-volume floor below which a match is too thin to count as demand.
const ET_MIN_ABSOLUTE_VOLUME = 1000;

// Build a GET /database-search request. api_key rides in the query string, so
// `url` is SECRET — never log it. Log `log_target` (same endpoint, no key).
function buildEtSearchRequest({ keyword, apiKey, responseTimeframe = "last_12_months" }) {
  if (!keyword || !String(keyword).trim()) throw new Error("buildEtSearchRequest: keyword required");
  if (!apiKey) throw new Error("buildEtSearchRequest: apiKey required");
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("keyword", String(keyword).trim());
  if (responseTimeframe) params.set("response_timeframe", responseTimeframe);
  const safe = new URLSearchParams();
  safe.set("keyword", String(keyword).trim());
  if (responseTimeframe) safe.set("response_timeframe", responseTimeframe);
  return {
    url: `${ET_BASE_URL}/database-search?${params.toString()}`,
    headers: { "User-Agent": ET_BROWSER_UA },
    log_target: `${ET_BASE_URL}/database-search?${safe.toString()}`,
  };
}

// Pure. Normalize a raw /database-search response. `matched` is the
// transport-level hit (total > 0), NOT a corroboration verdict — the agent
// still judges concept-sameness + the volume floor.
function normalizeEtResponse({ status, body } = {}) {
  const miss = (extra) => ({
    matched: false, total: 0,
    keyword: null, path: null, absolute_volume: null,
    classifications: null, growth: null, candidates: [], ...extra,
  });
  if (typeof status === "number" && status !== 200) return miss({ error: `http_${status}` });
  const b = body || {};
  if (typeof b.message === "string" && ET_MISS_MESSAGES.includes(b.message.trim())) {
    return miss({ miss_message: b.message.trim() });
  }
  const results = Array.isArray(b.result) ? b.result : [];
  const total = Number(b.total ?? results.length) || 0;
  if (total <= 0 || results.length === 0) return miss({});
  const top = results[0] || {};
  const num = (v) => (typeof v === "number" ? v : v != null && v !== "" ? Number(v) : null);
  return {
    matched: true,
    total,
    keyword: top.keyword ?? null,
    path: top.path ?? null,
    absolute_volume: num(top.absolute_volume),
    classifications: top.classifications ?? null,
    growth: top.growth ?? null,
    candidates: results.slice(0, 5).map((r) => ({
      keyword: r.keyword ?? null,
      path: r.path ?? null,
      absolute_volume: num(r.absolute_volume),
      categories: r.categories ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tool catalog
// ─────────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = {
  compare_topics: {
    name: "compare_topics",
    description:
      "Think pairwise about whether two trends are the same topic. Pass the candidate's topic + signals on one side and one specific neighbor (by trend_id from the supplied neighbor_pool) on the other. Returns the neighbor's full context to help you reason. Use this BEFORE proposing MERGE_INTO_EXISTING with a target — it forces explicit reasoning per pair.",
    input_schema: {
      type: "object",
      properties: {
        neighbor_trend_id: { type: "string", description: "trend_id of the neighbor to compare against (must be in the supplied neighbor_pool)" },
        my_judgment: {
          type: "string",
          enum: ["same_topic", "hierarchical_distinct", "temporal_recurrence_same", "temporal_recurrence_new_instance", "different_topic"],
          description: "Your judgment after comparison. Must be one of the enum values.",
        },
        reasoning: { type: "string", description: "One short sentence on why" },
      },
      required: ["neighbor_trend_id", "my_judgment", "reasoning"],
    },
  },
  query_neighbor_details: {
    name: "query_neighbor_details",
    description: "Look up full info on a specific neighbor from the supplied neighbor_pool by trend_id. Returns its topic, summary, recent signal samples, similarity score, age, heat. Use this to inspect a neighbor more carefully before deciding.",
    input_schema: {
      type: "object",
      properties: {
        trend_id: { type: "string" },
      },
      required: ["trend_id"],
    },
  },
  verify_exploding_topics: {
    name: "verify_exploding_topics",
    description:
      "Look a keyword up in Exploding Topics (an independent external search-demand catalog) to corroborate whether the concept is real. Use this for ET-RESCUE candidates (flagged in your prompt): a candidate with only one signal source family, where ET's independent recognition can earn the missing second source family. Pass the candidate_query (the atomic consumer-vernacular term). Returns fuzzy matches ranked by relevance, each with keyword + absolute_volume (searches last month) + classifications + growth. IMPORTANT: /database-search is FUZZY — it returns near-matches, so YOU must judge whether the returned keyword is genuinely the SAME concept as the candidate (not merely adjacent). Corroboration requires (same concept, your judgment) AND (absolute_volume above a small floor). classifications/growth are informational only — a 'peaked' or negative-growth reading does NOT disqualify (the gate asks 'is this a real movement independent parties recognize', not 'is it surging now'). ET can only SUPPLY a missing source family; it can never veto a candidate that already has two real families.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "The atomic consumer-vernacular term to look up — normally the candidate_query. One ingredient/product/practice, not the compound behavior." },
      },
      required: ["keyword"],
    },
  },
  propose_decision: {
    name: "propose_decision",
    description:
      "TERMINAL action: emit the final decision for this candidate. Once called, the loop ends. Set decision to one of PROMOTE_NEW | MERGE_INTO_EXISTING | REJECT | DEFER. For MERGE_INTO_EXISTING, target_trend_id MUST be one of the trend_ids in the supplied neighbor_pool. For an ET-RESCUE candidate you are promoting because Exploding Topics corroborated it, set et_was_second_source=true and et_matched_keyword to the ET keyword you judged as the same concept. Defend any override of distillation's verdict in the rationale.",
    input_schema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["PROMOTE_NEW", "MERGE_INTO_EXISTING", "REJECT", "DEFER"],
        },
        decision_category: {
          type: "string",
          enum: [
            "CONFIRM_NEW", "MISSED_DUPLICATE",
            "CONFIRM_DUPE", "OVER_DEDUP", "CORRECTED_DEDUP_TARGET",
            "CONFIRM_REJECT", "OVER_REJECT_PROMOTE", "LOW_QUALITY",
            "NEEDS_MORE_SIGNAL", "AMBIGUOUS_TOPIC_JUDGMENT",
          ],
          description: "Finer-grained reason within decision",
        },
        target_trend_id: {
          type: "string",
          description: "Required for MERGE_INTO_EXISTING. Must be a trend_id from the supplied neighbor_pool.",
        },
        trend_topic: {
          type: "string",
          description: "Optional cleaned/refined topic for PROMOTE_NEW. Defaults to the candidate's topic.",
        },
        rejection_reason: { type: "string", description: "Required for REJECT." },
        defer_reason: { type: "string", description: "Required for DEFER." },
        defer_until: { type: "string", description: "ISO-8601 timestamp for when to re-evaluate; defaults to now+48h" },
        rationale: { type: "string", description: "Required: one paragraph defending the decision. If overriding distillation, defend the override." },
        et_was_second_source: { type: "boolean", description: "Set true ONLY when you are promoting an ET-rescue candidate because Exploding Topics independently corroborated the concept (same concept + real volume) and thereby supplied the missing second source family. Leave false/unset otherwise. Never set true for a candidate that already had two real signal source families." },
        et_matched_keyword: { type: "string", description: "When et_was_second_source=true: the ET keyword (from verify_exploding_topics results) you judged as the same concept." },
      },
      required: ["decision", "decision_category", "rationale"],
    },
  },
};

const TOOL_NAMES = ["compare_topics", "query_neighbor_details", "verify_exploding_topics", "propose_decision"];

function getToolSchemas(names) {
  return names.map((n) => {
    const s = TOOL_SCHEMAS[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return s;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Tool dispatchers
// ─────────────────────────────────────────────────────────────────────

function compareTopics(input, ctx) {
  const tid = input?.neighbor_trend_id;
  if (!tid) return { error: "neighbor_trend_id required" };
  const neighbor = (ctx.neighbor_pool || []).find((n) => n.trend_id === tid);
  if (!neighbor) {
    return { error: `trend_id ${tid} not in supplied neighbor_pool` };
  }
  ctx.considered = ctx.considered || [];
  ctx.considered.push({
    trend_id: tid,
    similarity: neighbor.similarity,
    judgment: input.my_judgment,
    reasoning: (input.reasoning || "").slice(0, 400),
  });
  return {
    neighbor: {
      trend_id: neighbor.trend_id,
      topic: neighbor.topic,
      summary: neighbor.summary || null,
      similarity: neighbor.similarity,
      cluster_size: neighbor.cluster_size,
      heat: neighbor.heat,
      age_days: neighbor.age_days,
      sample_signals: (neighbor.sample_signals || []).slice(0, 3),
    },
    recorded_judgment: input.my_judgment,
    note: "judgment recorded in considered_neighbors trail",
  };
}

function queryNeighborDetails(input, ctx) {
  const tid = input?.trend_id;
  if (!tid) return { error: "trend_id required" };
  const neighbor = (ctx.neighbor_pool || []).find((n) => n.trend_id === tid);
  if (!neighbor) {
    return { error: `trend_id ${tid} not in supplied neighbor_pool` };
  }
  return { neighbor };
}

async function verifyExplodingTopics(input, ctx) {
  const keyword = (input?.keyword || "").trim();
  if (!keyword) return { error: "keyword required" };
  const apiKey = ctx.et_api_key;
  if (!apiKey) {
    return { error: "Exploding Topics API key not configured (EXPLODING_TOPICS_API_KEY unset). Cannot verify — treat the candidate as un-corroborated." };
  }
  ctx.et_verifications = ctx.et_verifications || [];

  let normalized;
  try {
    const { url, headers, log_target } = buildEtSearchRequest({ keyword, apiKey });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let status = null, body = null;
    try {
      const resp = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      status = resp.status;
      const text = await resp.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } finally {
      clearTimeout(timer);
    }
    normalized = normalizeEtResponse({ status, body });
    // Log the SAFE target (no api_key), never the real url.
    console.log(`ET verify: ${log_target} -> matched=${normalized.matched} total=${normalized.total} top=${normalized.keyword ?? "—"} vol=${normalized.absolute_volume ?? "—"}`);
  } catch (e) {
    normalized = {
      matched: false, total: 0, keyword: null, path: null, absolute_volume: null,
      classifications: null, growth: null, candidates: [],
      error: e.name === "AbortError" ? "timeout" : e.message,
    };
    console.log(`ET verify error: ${e.message}`);
  }

  ctx.et_verifications.push({ queried: keyword, ...normalized });

  return {
    queried: keyword,
    matched: normalized.matched,
    total: normalized.total,
    top_keyword: normalized.keyword,
    top_absolute_volume: normalized.absolute_volume,
    classifications: normalized.classifications,
    growth: normalized.growth,
    candidates: normalized.candidates,
    volume_floor: ET_MIN_ABSOLUTE_VOLUME,
    rubric:
      "Corroboration = (this is the SAME concept as the candidate — your judgment; the match is fuzzy) AND (absolute_volume above the volume_floor). classifications/growth are informational only. If corroborated, propose_decision(PROMOTE_NEW) with et_was_second_source=true and et_matched_keyword set. If not corroborated, the candidate is still single-family — REJECT.",
    error: normalized.error || null,
  };
}

// Snapshot the ET verdict onto the decision when the agent verified ET. Picks
// the verification matching et_matched_keyword, else the last matched one,
// else the last attempt. et_was_second_source is honored ONLY on PROMOTE_NEW
// (additive-only: ET can supply, never veto).
function buildEtSnapshot(input, ctx, decision) {
  const verifs = ctx.et_verifications || [];
  const etWasSecond = input.et_was_second_source === true && decision === "PROMOTE_NEW";
  if (verifs.length === 0) {
    return { et_was_second_source: false, et_corroboration: null };
  }
  const wantKw = (input.et_matched_keyword || "").toLowerCase();
  let chosen = null;
  if (wantKw) {
    chosen = verifs.find((v) => (v.keyword || "").toLowerCase() === wantKw)
      || verifs.find((v) => (v.candidates || []).some((c) => (c.keyword || "").toLowerCase() === wantKw));
  }
  if (!chosen) chosen = [...verifs].reverse().find((v) => v.matched) || verifs[verifs.length - 1];
  const et_corroboration = chosen ? {
    matched: chosen.matched === true,
    keyword: input.et_matched_keyword || chosen.keyword || null,
    absolute_volume: chosen.absolute_volume ?? null,
    classifications: chosen.classifications ?? null,
    growth: chosen.growth ?? null,
    queried: chosen.queried ?? null,
  } : null;
  return { et_was_second_source: etWasSecond, et_corroboration };
}

function proposeDecision(input, ctx) {
  const decision = (input?.decision || "").toUpperCase();
  if (!decision) return { error: "decision required" };

  // Validation per decision type
  if (decision === "MERGE_INTO_EXISTING") {
    if (!input.target_trend_id) {
      return { error: "target_trend_id required for MERGE_INTO_EXISTING" };
    }
    const pool = ctx.neighbor_pool || [];
    if (!pool.find((n) => n.trend_id === input.target_trend_id)) {
      return { error: `target_trend_id ${input.target_trend_id} not in supplied neighbor_pool — must pick a real neighbor` };
    }
  }
  if (decision === "REJECT" && !input.rejection_reason) {
    return { error: "rejection_reason required for REJECT" };
  }
  if (decision === "DEFER" && !input.defer_reason) {
    return { error: "defer_reason required for DEFER" };
  }
  if (!input.rationale) {
    return { error: "rationale required" };
  }

  // Compute max_neighbor_sim from the pool for audit
  const max_sim = (ctx.neighbor_pool || [])
    .reduce((acc, n) => Math.max(acc, n.similarity ?? 0), 0);

  const { et_was_second_source, et_corroboration } = buildEtSnapshot(input, ctx, decision);

  ctx.decision = {
    decision,
    decision_category: input.decision_category,
    target_trend_id: input.target_trend_id || null,
    trend_topic: input.trend_topic || null,
    rejection_reason: input.rejection_reason || null,
    defer_until: input.defer_until || null,
    defer_reason: input.defer_reason || null,
    rationale: (input.rationale || "").slice(0, 2000),
    max_neighbor_sim: max_sim || null,
    considered_neighbors: ctx.considered || [],
    et_was_second_source,
    et_corroboration,
  };

  return { accepted: true, decision: ctx.decision.decision, category: ctx.decision.decision_category };
}

const DISPATCHERS = {
  compare_topics: (input, ctx) => compareTopics(input, ctx),
  query_neighbor_details: (input, ctx) => queryNeighborDetails(input, ctx),
  verify_exploding_topics: (input, ctx) => verifyExplodingTopics(input, ctx),
  propose_decision: (input, ctx) => proposeDecision(input, ctx),
};

async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try { return await fn(input || {}, ctx || {}); }
  catch (e) { return { error: `tool '${name}' threw: ${e.message}` }; }
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
  max_iterations: 6,
  budget_usd: 0.15,
  per_call_max_tokens: 3072,
  thinking_level: "medium",
  temperature: 1.0,
  request_timeout_ms: 180_000,
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

    // If decision was proposed via tool, terminate the loop early
    if (context.decision) {
      stop_reason = "decision_proposed";
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
      reasoning_trace.push({ turn, kind: "tool_result", name: fc.name, output_preview: previewOutput(out) });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return {
    stop_reason, turns: turn, tokens,
    cost_usd: Math.round(cost_usd * 10000) / 10000,
    reasoning_trace, tool_calls, final_text, model: MODEL,
  };
}

function previewOutput(out) {
  if (!out || typeof out !== "object") return String(out).slice(0, 240);
  const summary = {};
  for (const k of Object.keys(out).slice(0, 8)) {
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

const SYSTEM_PROMPT_KEY = "promotion.subagent.system";
const RUBRIC_PROMPT_KEY = "promotion.subagent.decision_rubric";

export default defineComponent({
  name: "Promotion Subagent: run",
  description: "Sonnet 4.6 verifier — ratifies or overrides distillation's verdict",
  version: "0.0.1",
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    request: { type: "any" },                  // output of handle_request
    prompts_rows: { type: "any" },             // output of q_load_prompts
  },
  async run({ $ }) {
    const req = this.request || {};
    const candidate = req.candidate || {};
    const dryRun = req.dry_run === true;

    if (!candidate.candidate_id) {
      throw new Error("request.candidate.candidate_id required");
    }

    const loaded = loadPrompts(this.prompts_rows);
    const sysPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
    const rubricPrompt = mustGet(loaded, RUBRIC_PROMPT_KEY);

    const renderedSystem = render(sysPrompt.template, {
      ...req.system_vars,
      decision_rubric: rubricPrompt.template,
    });

    if (dryRun) {
      console.log("dry_run=true: skipping LLM, returning DEFER");
      return {
        decision: "DEFER",
        decision_category: "NEEDS_MORE_SIGNAL",
        defer_reason: "dry_run",
        rationale: "dry_run: no LLM call",
        max_neighbor_sim: (req.neighbor_pool[0] || {}).similarity || null,
        considered_neighbors: [],
        cost_usd: 0,
        tokens: { input: 0, output: 0, total: 0 },
        turns: 0,
        stop_reason: "dry_run",
        model: MODEL,
      };
    }

    // ET api key rides in the Pipedream project env (never a full-URL log).
    const etApiKey = process.env.EXPLODING_TOPICS_API_KEY || null;
    if (candidate.et_rescue && !etApiKey) {
      console.log("⚠ et_rescue candidate but EXPLODING_TOPICS_API_KEY unset — ET corroboration unavailable");
    }

    const ctx = {
      neighbor_pool: req.neighbor_pool || [],
      considered: [],
      decision: null,
      et_api_key: etApiKey,
      et_verifications: [],
    };

    const etStep = candidate.et_rescue
      ? `\n2b. This is an ET-RESCUE candidate (single source family). Call \`verify_exploding_topics\` with the candidate_query ("${candidate.candidate_query || candidate.candidate_topic}") to check whether Exploding Topics independently recognizes the concept. If it does (same concept + real volume), that earns the missing second source family → PROMOTE_NEW with et_was_second_source=true. If not, REJECT.`
      : "";

    const userMsg = `You are evaluating one candidate trend (id: ${candidate.candidate_id}). Distillation already made a recommendation; verify or override using the surfaced neighbors.

Workflow:
1. Read the candidate, distillation's recommendation, and the neighbor pool above (in your system prompt).
2. For neighbors you suspect might be the same topic, call \`compare_topics\` to record your pairwise judgment.${etStep}
3. Once you have enough evidence, call \`propose_decision\` with the final decision. This terminates the loop.

Be efficient — typical case is one or two compare_topics calls then propose_decision.`;

    let result;
    try {
      result = await runAgentLoop({
        google_gemini: this.google_gemini,
        tool_names: TOOL_NAMES,
        system: renderedSystem,
        user_message: userMsg,
        context: ctx,
        max_iterations: sysPrompt.params.max_iterations || 6,
        budget_usd: sysPrompt.params.budget_usd || 0.15,
        per_call_max_tokens: sysPrompt.params.per_call_max_tokens || 3072,
        thinking_level: sysPrompt.params.thinking_level || "medium",
      });
    } catch (e) {
      console.log(`subagent loop error: ${e.message}`);
      return {
        decision: "DEFER",
        decision_category: "AMBIGUOUS_TOPIC_JUDGMENT",
        defer_reason: `agent_error: ${e.message.slice(0, 200)}`,
        rationale: `subagent loop crashed: ${e.message.slice(0, 400)}`,
        considered_neighbors: ctx.considered || [],
        cost_usd: 0,
        tokens: { input: 0, output: 0, total: 0 },
        turns: 0,
        stop_reason: "error",
        error: e.message,
        model: MODEL,
      };
    }

    // If the agent ended without proposing a decision, default to DEFER
    if (!ctx.decision) {
      console.log("subagent ended without proposing a decision — defaulting to DEFER");
      ctx.decision = {
        decision: "DEFER",
        decision_category: "AMBIGUOUS_TOPIC_JUDGMENT",
        defer_reason: `agent stopped without decision: ${result.stop_reason}`,
        rationale: result.final_text || "agent did not call propose_decision",
        considered_neighbors: ctx.considered || [],
        max_neighbor_sim: (ctx.neighbor_pool[0] || {}).similarity || null,
        et_was_second_source: false,
        et_corroboration: null,
      };
    }

    const decision = ctx.decision;
    console.log(
      `subagent done: decision=${decision.decision} category=${decision.decision_category} target=${decision.target_trend_id || "—"} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)}`,
    );
    $.export("$summary", `${decision.decision} (${decision.decision_category}) — $${result.cost_usd.toFixed(3)}`);

    return {
      ...decision,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      turns: result.turns,
      stop_reason: result.stop_reason,
      reasoning_trace: result.reasoning_trace,
      tool_calls: result.tool_calls,
      final_text: result.final_text,
      model: result.model,
    };
  },
});
