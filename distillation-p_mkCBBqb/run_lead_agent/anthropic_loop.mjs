// Anthropic agent loop runtime
// ============================
//
// Drives a Sonnet 4.6 tool-use loop with interleaved thinking. Used by both
// the distillation lead orchestrator and the distillation subagent. Future
// Phase 2/3 agents (enrichment, lifecycle) can reuse this runtime as-is.
//
// Pattern follows the existing audit-p_pWCwPyL/llm_plan/entry.js shape:
//   - Direct fetch() to api.anthropic.com (no SDK dependency).
//   - Bearer key from Pipedream's anthropic app prop ($auth.api_key).
//   - JSON-only request/response.
//
// Differences from the audit pattern:
//   - Multi-turn loop with `tools` array + `tool_use` / `tool_result` blocks.
//   - `anthropic-beta: interleaved-thinking-2025-05-14` header so Sonnet 4.6
//     can emit `thinking` blocks between tool calls. We capture and persist
//     them in the reasoning trace.
//   - Hard caps on iterations + dollar budget (`max_iterations`, `budget_usd`).
//   - Returns aggregated cost/token usage per run.
//
// Tool dispatch is delegated to ./tool_catalog.js — this file knows how to
// drive the loop, not what the tools mean.

import { dispatchTool, getToolSchemas } from "./tool_catalog.mjs";

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 }; // Sonnet 4.6 pricing
const ANTHROPIC_VERSION = "2023-06-01";
const BETA_HEADERS = "interleaved-thinking-2025-05-14";

const DEFAULTS = {
  max_iterations: 12,
  budget_usd: 5.0,
  per_call_max_tokens: 8192,
  thinking_budget_tokens: 4000,
  temperature: 1.0, // required to be 1.0 when extended thinking is on
  request_timeout_ms: 180_000,
};

/**
 * Run the agent loop.
 *
 * @param {object} args
 * @param {object} args.anthropic    Pipedream `anthropic` app prop with $auth.api_key
 * @param {string[]} args.tool_names Tool names from tool_catalog to expose
 * @param {string} args.system       System prompt (string)
 * @param {string|object[]} args.user_message  Initial user message
 * @param {object} args.context      Passed to dispatchTool() — pre-fetched data, endpoints, session info
 * @param {number} [args.max_iterations]
 * @param {number} [args.budget_usd]
 * @param {number} [args.per_call_max_tokens]
 * @param {number} [args.thinking_budget_tokens]
 * @returns {Promise<object>} { stop_reason, turns, tokens, cost_usd, reasoning_trace, tool_calls, final_text }
 */
export async function runAgentLoop({
  anthropic,
  tool_names,
  system,
  user_message,
  context,
  max_iterations = DEFAULTS.max_iterations,
  budget_usd = DEFAULTS.budget_usd,
  per_call_max_tokens = DEFAULTS.per_call_max_tokens,
  thinking_budget_tokens = DEFAULTS.thinking_budget_tokens,
}) {
  if (!anthropic?.$auth?.api_key) throw new Error("anthropic app prop missing $auth.api_key");
  if (!Array.isArray(tool_names) || tool_names.length === 0) throw new Error("tool_names is required");

  const tools = getToolSchemas(tool_names);
  const messages = [
    {
      role: "user",
      content: typeof user_message === "string" ? [{ type: "text", text: user_message }] : user_message,
    },
  ];

  const tokens = { input: 0, output: 0, total: 0 };
  const reasoning_trace = []; // { turn, kind: 'thinking'|'text'|'tool_use'|'tool_result', ...payload }
  const tool_calls = []; // { turn, name, input, output, duration_ms, error? }
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
      model: MODEL,
      max_tokens: per_call_max_tokens,
      system,
      messages,
      tools,
      tool_choice: { type: "auto" },
      temperature: DEFAULTS.temperature,
      thinking: { type: "enabled", budget_tokens: thinking_budget_tokens },
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DEFAULTS.request_timeout_ms);
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

    // Token + cost accounting
    const usage = data.usage || {};
    const tin = usage.input_tokens || 0;
    const tout = usage.output_tokens || 0;
    tokens.input += tin;
    tokens.output += tout;
    tokens.total = tokens.input + tokens.output;
    cost_usd +=
      (tin / 1_000_000) * RATES_PER_M.input +
      (tout / 1_000_000) * RATES_PER_M.output;

    const content = Array.isArray(data.content) ? data.content : [];

    // Capture all blocks into reasoning trace
    for (const block of content) {
      if (block.type === "thinking") {
        reasoning_trace.push({ turn, kind: "thinking", text: block.thinking, signature: block.signature });
      } else if (block.type === "text") {
        reasoning_trace.push({ turn, kind: "text", text: block.text });
        final_text = block.text; // last text block wins
      } else if (block.type === "tool_use") {
        reasoning_trace.push({ turn, kind: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }

    // Always append the assistant turn to messages, preserving thinking + tool_use blocks intact.
    // Anthropic requires the full content array to be echoed back when there are thinking blocks
    // and tool_use blocks; otherwise interleaved thinking won't continue across turns.
    messages.push({ role: "assistant", content });

    // If the model wants to call tools, dispatch them and append a user turn with tool_results
    if (data.stop_reason === "tool_use") {
      const toolUses = content.filter((b) => b.type === "tool_use");
      const toolResults = [];
      // Run tool calls in parallel within a single turn (Anthropic supports multiple tool_use blocks)
      const dispatched = await Promise.all(
        toolUses.map(async (tu) => {
          const started = Date.now();
          const out = await dispatchTool(tu.name, tu.input, context);
          const duration_ms = Date.now() - started;
          tool_calls.push({ turn, name: tu.name, input: tu.input, output: out, duration_ms });
          return { id: tu.id, name: tu.name, output: out };
        }),
      );
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

    // Model is done (end_turn, stop_sequence, max_tokens, etc.)
    stop_reason = data.stop_reason || "end_turn";
    break;
  }

  if (turn >= max_iterations && stop_reason === "max_iterations") {
    reasoning_trace.push({ turn, kind: "stop", reason: "max_iterations" });
  }

  return {
    stop_reason,
    turns: turn,
    tokens,
    cost_usd: round4(cost_usd),
    reasoning_trace,
    tool_calls,
    final_text,
    model: MODEL,
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

function previewOutput(out) {
  if (!out || typeof out !== "object") return String(out).slice(0, 240);
  // Don't dump huge arrays into the trace; show a summary
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
