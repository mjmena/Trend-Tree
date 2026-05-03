// Distillation Revisit Subagent — run_revisit_subagent
//
// Drives a Sonnet 4.6 tool-use loop on ONE pre-clustered slice of leftover
// signals (the daily revisit pool). The agent's job: look at the cluster
// + neighbor-trend context, propose a candidate if the cluster collectively
// suggests a trend the main pass missed, otherwise return empty-handed.
//
// Differs from the main distillation subagent:
//   - No bucket logic (every revisit cluster follows the same path)
//   - No ingest tools (the cluster is fixed; subagent doesn't fetch more)
//   - No neighbor-lookup tools (lead pre-fetches and passes via context)
//   - Single emit tool: propose_trend_candidate
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file. Canonical source: /home/marty/dev/Trend-Tree/agents/lib/*.mjs
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// prompt_loader (canonical: agents/lib/prompt_loader.mjs)
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
      `Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT has IS_ACTIVE=TRUE for this key.`,
    );
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// Tool catalog — only propose_trend_candidate
// ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "propose_trend_candidate",
    description:
      "Emit a candidate trend that this cluster of signals collectively supports. Use ONLY if the signals together suggest a real cross-source pattern the main distillation pass missed. If the cluster is just noise / misc / too narrow, do NOT call this tool — end the turn empty-handed.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Specific noun-verb consumer behavior phrase" },
        verdict: {
          type: "string",
          enum: ["REAL_TREND", "DUPLICATE_OF", "NOISE", "CATEGORY_TOO_BROAD"],
          description: "REAL_TREND for a fresh trend candidate. DUPLICATE_OF if it matches an existing FCT_TRENDS row.",
        },
        dedup_of_trend_id: { type: "string", description: "When verdict='DUPLICATE_OF', the matching trend_id" },
        bucket: { type: "string", enum: ["AGENT_ONLY"], description: "Always AGENT_ONLY for revisit-emitted candidates" },
        confidence: { type: "number", description: "0.0-1.0 self-assessed confidence" },
        specificity_score: { type: "number", description: "0.0-1.0; high = noun-verb specific behavior; low = vague category" },
        supporting_signal_ids: { type: "array", items: { type: "string" }, description: "Subset of the cluster's signal_ids that support this candidate" },
        reasoning: { type: "string", description: "Why this cluster collectively suggests this trend" },
        evidence_added: { type: "object", description: "Optional structured evidence; can be empty {}" },
      },
      required: ["topic", "verdict", "bucket", "confidence", "specificity_score", "supporting_signal_ids", "reasoning"],
    },
  },
];

function cryptoRandomId() {
  return "cand-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

function proposeTrendCandidate(input, ctx) {
  ctx.proposed_candidates = ctx.proposed_candidates || [];
  ctx.proposed_candidates.push({
    ...input,
    candidate_id: cryptoRandomId(),
    chain_id: ctx.chain_id,
    iteration: 1,
    agent_session_id: ctx.agent_session_id,
  });
  return {
    accepted: true,
    accepted_count: ctx.proposed_candidates.length,
    candidate_id: ctx.proposed_candidates[ctx.proposed_candidates.length - 1].candidate_id,
  };
}

const DISPATCHERS = {
  propose_trend_candidate: (input, ctx) => proposeTrendCandidate(input, ctx),
};

async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try { return await fn(input || {}, ctx || {}); }
  catch (e) { return { error: `tool '${name}' threw: ${e.message}` }; }
}

// ─────────────────────────────────────────────────────────────────────
// Anthropic agent loop (canonical: agents/lib/anthropic_loop.mjs)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";
const BETA_HEADERS = "interleaved-thinking-2025-05-14";

const LOOP_DEFAULTS = {
  max_iterations: 6,
  budget_usd: 1.5,
  per_call_max_tokens: 8192,
  thinking_budget_tokens: 3000,
  temperature: 1.0,
  request_timeout_ms: 180_000,
};

function previewOutput(out) {
  try {
    const s = typeof out === "string" ? out : JSON.stringify(out);
    return s.slice(0, 200);
  } catch { return "<unserializable>"; }
}

async function runAgentLoop({ anthropic, system, user_message, context, max_iterations, budget_usd }) {
  if (!anthropic?.$auth?.api_key) throw new Error("anthropic app prop missing $auth.api_key");

  const messages = [{
    role: "user",
    content: typeof user_message === "string" ? [{ type: "text", text: user_message }] : user_message,
  }];
  const tokens = { input: 0, output: 0, total: 0 };
  const reasoning_trace = [];
  let cost_usd = 0;
  let final_text = "";
  let stop_reason = "max_iterations";
  let turn = 0;
  const max_iter = max_iterations || LOOP_DEFAULTS.max_iterations;
  const budget = budget_usd || LOOP_DEFAULTS.budget_usd;

  while (turn < max_iter) {
    turn += 1;
    if (cost_usd >= budget) {
      stop_reason = "budget_exhausted";
      reasoning_trace.push({ turn, kind: "stop", reason: stop_reason, cost_usd });
      break;
    }

    const reqBody = {
      model: MODEL,
      max_tokens: LOOP_DEFAULTS.per_call_max_tokens,
      system,
      messages,
      tools: TOOLS,
      tool_choice: { type: "auto" },
      temperature: LOOP_DEFAULTS.temperature,
      thinking: { type: "enabled", budget_tokens: LOOP_DEFAULTS.thinking_budget_tokens },
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
        reasoning_trace.push({ turn, kind: "thinking", text: block.thinking?.slice(0, 600), signature: block.signature });
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
        const out = await dispatchTool(tu.name, tu.input, context);
        return { id: tu.id, name: tu.name, output: out };
      }));
      for (const d of dispatched) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: d.id,
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

  return { stop_reason, turns: turn, tokens, cost_usd, reasoning_trace, final_text };
}

// ─────────────────────────────────────────────────────────────────────
// Step body
// ─────────────────────────────────────────────────────────────────────

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    request: { type: "object" },
    signal_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
    prompts_rows: { type: "any", optional: true },
  },
  async run({ $ }) {
    const req = this.request || {};
    const signals = Array.isArray(this.signal_rows) ? this.signal_rows : [];
    const neighbors = Array.isArray(this.neighbor_rows) ? this.neighbor_rows : [];

    const loaded = loadPrompts(this.prompts_rows);
    const sysPrompt = mustGet(loaded, "distillation.revisit.subagent.system");

    const system = render(sysPrompt.template, {
      cluster_id: req.cluster_id,
      signal_count: signals.length,
      neighbor_count: neighbors.length,
    });

    const userMessage = JSON.stringify({
      cluster_id: req.cluster_id,
      signals: signals.map((s) => ({
        signal_id: s.SIGNAL_ID,
        source: s.SOURCE_NAME,
        timestamp: s.SIGNAL_TIMESTAMP,
        title: s.SIGNAL_TITLE,
        text: (s.SIGNAL_TEXT || "").slice(0, 1500),
      })),
      existing_trends: neighbors.map((n) => ({
        trend_id: n.TREND_ID,
        topic: n.TREND_NAME,
        cluster_size: n.TOTAL_CLUSTER_SIZE,
        velocity: n.VELOCITY_DIRECTION,
        heat: n.HEAT_INDEX,
      })),
    }, null, 2);

    const context = {
      proposed_candidates: [],
      chain_id: req.chain_id,
      agent_session_id: req.agent_session_id,
    };

    const t0 = Date.now();
    const result = await runAgentLoop({
      anthropic: this.anthropic,
      system,
      user_message: userMessage,
      context,
      max_iterations: 6,
      budget_usd: 1.5,
    });
    const run_duration_ms = Date.now() - t0;

    const candidates = context.proposed_candidates || [];
    console.log(
      `revisit-subagent: cluster=${req.cluster_id} candidates=${candidates.length} ` +
      `turns=${result.turns} tokens=${result.tokens.total} cost=$${result.cost_usd.toFixed(4)} ` +
      `stop=${result.stop_reason}`,
    );

    return {
      cluster_id: req.cluster_id,
      proposed_candidates: candidates,
      candidates_count: candidates.length,
      stop_reason: result.stop_reason,
      turns: result.turns,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      run_duration_ms,
      reasoning_trace: result.reasoning_trace,
      prompt_version: sysPrompt.version,
    };
  },
});
