// Promotion Subagent — run_subagent
//
// Verifier loop: Sonnet 4.6 reads distillation's recommendation + the surfaced
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
  propose_decision: {
    name: "propose_decision",
    description:
      "TERMINAL action: emit the final decision for this candidate. Once called, the loop ends. Set decision to one of PROMOTE_NEW | MERGE_INTO_EXISTING | REJECT | DEFER. For MERGE_INTO_EXISTING, target_trend_id MUST be one of the trend_ids in the supplied neighbor_pool. Defend any override of distillation's verdict in the rationale.",
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
      },
      required: ["decision", "decision_category", "rationale"],
    },
  },
};

const TOOL_NAMES = ["compare_topics", "query_neighbor_details", "propose_decision"];

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
  };

  return { accepted: true, decision: ctx.decision.decision, category: ctx.decision.decision_category };
}

const DISPATCHERS = {
  compare_topics: (input, ctx) => compareTopics(input, ctx),
  query_neighbor_details: (input, ctx) => queryNeighborDetails(input, ctx),
  propose_decision: (input, ctx) => proposeDecision(input, ctx),
};

async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try { return await fn(input || {}, ctx || {}); }
  catch (e) { return { error: `tool '${name}' threw: ${e.message}` }; }
}

// ─────────────────────────────────────────────────────────────────────
// Anthropic agent loop runtime (canonical: agents/lib/anthropic_loop.mjs)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";
const BETA_HEADERS = "interleaved-thinking-2025-05-14";

const LOOP_DEFAULTS = {
  max_iterations: 6,
  budget_usd: 0.15,
  per_call_max_tokens: 3072,
  thinking_budget_tokens: 2000,
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

    // If decision was proposed via tool, terminate the loop early
    if (context.decision) {
      stop_reason = "decision_proposed";
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
    anthropic: { type: "app", app: "anthropic" },
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

    const ctx = {
      neighbor_pool: req.neighbor_pool || [],
      considered: [],
      decision: null,
    };

    const userMsg = `You are evaluating one candidate trend (id: ${candidate.candidate_id}). Distillation already made a recommendation; verify or override using the surfaced neighbors.

Workflow:
1. Read the candidate, distillation's recommendation, and the neighbor pool above (in your system prompt).
2. For neighbors you suspect might be the same topic, call \`compare_topics\` to record your pairwise judgment.
3. Once you have enough evidence, call \`propose_decision\` with the final decision. This terminates the loop.

Be efficient — typical case is one or two compare_topics calls then propose_decision.`;

    let result;
    try {
      result = await runAgentLoop({
        anthropic: this.anthropic,
        tool_names: TOOL_NAMES,
        system: renderedSystem,
        user_message: userMsg,
        context: ctx,
        max_iterations: sysPrompt.params.max_iterations || 6,
        budget_usd: sysPrompt.params.budget_usd || 0.15,
        per_call_max_tokens: sysPrompt.params.per_call_max_tokens || 3072,
        thinking_budget_tokens: sysPrompt.params.thinking_budget_tokens || 2000,
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
