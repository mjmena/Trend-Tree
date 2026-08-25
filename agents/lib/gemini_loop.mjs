// Gemini agent loop runtime
// ==========================
//
// Drives a Gemini 3.1 Pro tool-use loop with thinking enabled. Mirrors
// anthropic_loop.mjs but targets the Google Generative Language REST API
// instead of api.anthropic.com. Used by distillation, promotion, lifecycle,
// and enrichment agents.
//
// Direct fetch() (no SDK dependency). Bearer key from Pipedream's
// google_gemini app prop ($auth.api_key). Multi-turn loop with
// functionDeclarations + functionCall / functionResponse parts.
// thinkingConfig: { thinkingLevel: "medium" } replaces the Anthropic
// interleaved-thinking beta. thoughtSignature round-trip is REQUIRED —
// push model parts back VERBATIM or Gemini returns 400.
//
// Tool dispatch is sequential (not Promise.all): Gemini matches
// functionResponse parts to functionCall parts by name with positional
// fallback when the same tool is called twice in one turn.
//
// Tool dispatch is delegated to dispatchTool / getToolSchemas (caller-
// supplied or imported from tool_catalog.mjs). This file drives the loop,
// not the tools themselves.
//
// model / function_calling_mode / temperature / rates_per_m are all
// caller-overridable (CRMA-776): the ecomm agent's selector pins a
// different model (gemini-3.7-flash vs. this file's gemini-3.1-pro-preview
// default), forces functionCallingConfig.mode="ANY" instead of "AUTO", and
// omits `temperature` entirely (deprecated fleet-wide 2026-07-21, the
// CRMA-726 migration strips it) — pass `temperature: null` to omit it from
// the request. Every existing caller that doesn't pass these gets the
// original gemini-3.1-pro-preview / AUTO / temperature=1.0 behavior
// unchanged.

const MODEL = "gemini-3.1-pro-preview";
const RATES_PER_M = { input: 2.0, output: 12.0 }; // sub-200k context tier, gemini-3.1-pro-preview

const DEFAULTS = {
  max_iterations: 12,
  budget_usd: 5.0,
  per_call_max_tokens: 8192,
  thinking_level: "medium",
  temperature: 1.0, // required to be 1.0 when thinking is enabled; pass null to omit entirely
  function_calling_mode: "AUTO", // "AUTO" | "ANY" | "NONE"
  request_timeout_ms: 180_000,
};

// Translate Anthropic-shaped tool schemas (input_schema) into Gemini's
// functionDeclarations shape (parameters). The JSON Schema body is identical;
// only the wrapper field name differs.
export function toFunctionDeclarations(toolNames, allSchemas) {
  return toolNames.map((n) => {
    const s = allSchemas[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return { name: s.name, description: s.description, parameters: s.input_schema };
  });
}

/**
 * Run the Gemini agent loop.
 *
 * @param {object} args
 * @param {object} args.google_gemini  Pipedream `google_gemini` app prop with $auth.api_key
 * @param {string[]} args.tool_names   Tool names from the caller's schema registry
 * @param {object} args.all_schemas    Full schema map { [name]: { name, description, input_schema } }
 * @param {string} args.system         System prompt (string)
 * @param {string|object[]} args.user_message  Initial user message (string or parts array)
 * @param {object} args.context        Passed to dispatchTool() — pre-fetched data, endpoints, session info
 * @param {Function} args.dispatchTool (name, input, ctx) => Promise<any>
 * @param {number} [args.max_iterations]
 * @param {number} [args.budget_usd]
 * @param {number} [args.per_call_max_tokens]
 * @param {string} [args.thinking_level]
 * @param {string} [args.model]                  Overrides the default gemini-3.1-pro-preview pin.
 * @param {string} [args.function_calling_mode]   "AUTO" (default) | "ANY" | "NONE" — toolConfig.functionCallingConfig.mode.
 * @param {number|null} [args.temperature]        Defaults to 1.0 (required when thinking is enabled on 3.1 Pro);
 *                                                 pass null to omit the field entirely (deprecated fleet-wide on newer models).
 * @param {{input:number,output:number}} [args.rates_per_m]  $/M-token rates for cost_usd — defaults to the 3.1 Pro sub-200k tier.
 * @returns {Promise<object>} { stop_reason, turns, tokens, cost_usd, reasoning_trace, tool_calls, final_text, model }
 */
export async function runAgentLoop({
  google_gemini,
  tool_names,
  all_schemas,
  system,
  user_message,
  context,
  dispatchTool,
  max_iterations = DEFAULTS.max_iterations,
  budget_usd = DEFAULTS.budget_usd,
  per_call_max_tokens = DEFAULTS.per_call_max_tokens,
  thinking_level = DEFAULTS.thinking_level,
  model = MODEL,
  function_calling_mode = DEFAULTS.function_calling_mode,
  temperature = DEFAULTS.temperature,
  rates_per_m = RATES_PER_M,
}) {
  if (!google_gemini?.$auth?.api_key) throw new Error("google_gemini app prop missing $auth.api_key");
  if (!Array.isArray(tool_names) || tool_names.length === 0) throw new Error("tool_names is required");
  if (!all_schemas) throw new Error("all_schemas is required");
  if (typeof dispatchTool !== "function") throw new Error("dispatchTool must be a function");

  const apiKey = google_gemini.$auth.api_key;
  const tools = [{ functionDeclarations: toFunctionDeclarations(tool_names, all_schemas) }];
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

    const generationConfig = {
      maxOutputTokens: per_call_max_tokens,
      thinkingConfig: { thinkingLevel: thinking_level },
    };
    // Omit temperature entirely when null/undefined — newer models
    // (gemini-3.7-flash) deprecate the param fleet-wide; older callers keep
    // sending 1.0 (required alongside thinking on 3.1 Pro) unless they opt out.
    if (temperature !== null && temperature !== undefined) {
      generationConfig.temperature = temperature;
    }

    const reqBody = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools,
      toolConfig: { functionCallingConfig: { mode: function_calling_mode } },
      generationConfig,
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DEFAULTS.request_timeout_ms);
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
    // candidatesTokenCount already includes thinking tokens — do NOT add thoughtsTokenCount.
    const tout = usage.candidatesTokenCount || 0;
    tokens.input += tin;
    tokens.output += tout;
    tokens.total = tokens.input + tokens.output;
    cost_usd += (tin / 1_000_000) * rates_per_m.input + (tout / 1_000_000) * rates_per_m.output;

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

    // Push the model turn back VERBATIM. Gemini enforces strict thoughtSignature
    // validation — reconstructing the parts array drops signatures and causes 400.
    contents.push({ role: "model", parts });

    if (functionCallParts.length === 0) {
      stop_reason = candidate.finishReason || "STOP";
      break;
    }

    // Sequential dispatch (not Promise.all): Gemini matches functionResponse
    // parts to functionCall parts by name with positional fallback when the
    // same name appears twice in one turn.
    const responseParts = [];
    for (const fcp of functionCallParts) {
      const fc = fcp.functionCall;
      const started = Date.now();
      const out = await dispatchTool(fc.name, fc.args || {}, context);
      const duration_ms = Date.now() - started;
      tool_calls.push({ turn, name: fc.name, input: fc.args || {}, output: out, duration_ms });
      reasoning_trace.push({ turn, kind: "tool_result", name: fc.name, output_preview: previewOutput(out) });
      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: out && typeof out === "object" ? out : { result: out },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (turn >= max_iterations && stop_reason === "max_iterations") {
    reasoning_trace.push({ turn, kind: "stop", reason: "max_iterations" });
  }

  return {
    stop_reason,
    turns: turn,
    tokens,
    cost_usd: Math.round(cost_usd * 10000) / 10000,
    reasoning_trace,
    tool_calls,
    final_text,
    model,
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
