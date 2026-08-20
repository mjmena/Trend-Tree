// Model-parameterised Gemini client for the replay harness.
//
// This is a deliberate FORK of agents/lib/gemini_loop.mjs, not an import.
// Three reasons the fork is the honest choice:
//
//   1. The deployed loops are INLINED copies inside each workflow's
//      entry.js. agents/lib/gemini_loop.mjs is a reference copy, so
//      importing it would not give the harness deployed-code fidelity
//      either way.
//   2. The loop hardcodes `const MODEL` and its rate table. Swapping the
//      model id is the entire point of this harness.
//   3. The harness must record things production does not: thinking tokens,
//      both cost interpretations, and every finishReason verbatim.
//
// Where behaviour must match production it matches deliberately, and the
// divergences are named in DELTAS below so a lane decision can cite them.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Per-million rates. The repo has 13 disagreeing hardcoded tables
 * (CRMA-726 established fact); this is the harness's single one. It exists
 * to price a REPLAY, not to fix production — rate-table hygiene rides in
 * the spec, not here.
 *
 * `until` marks a scheduled price change; the harness warns when it passes
 * so a stale number is never read as current.
 */
export const RATES_PER_M = {
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0, note: "sub-200k context tier" },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, until: "2026-12-31", after: { input: 1.5, output: 7.5 } },
  "gemini-3.6-flash": { input: 0.5, output: 2.5 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3-flash-preview": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

/** Models whose thinking budget cannot be switched off (CRMA-727). */
const NO_THINKING_OFF = new Set(["gemini-3.7-flash"]);

export const DELTAS = {
  temperature:
    "temperature/top_p/top_k are deprecated as of 2026-07-21. The harness omits " +
    "them by default so a replay is not judged on a parameter the API is retiring.",
  thinking:
    "gemini-3.7-flash has no 'minimal' thinking level; low is the floor and every " +
    "call bills thinking tokens at the output rate.",
  functionResponseId:
    "functionResponse parts carry the originating functionCall id. Production omits " +
    "it at five call sites (CRMA-727 defect 1); the harness sends it.",
};

/** Resolve the rate card for a model, honouring a scheduled price change. */
export function ratesFor(model, at = new Date()) {
  const r = RATES_PER_M[model];
  if (!r) {
    throw new Error(
      `No rate table for '${model}'. Add it to scripts/replay/lib/gemini.mjs ` +
        `so replay cost is not silently reported as zero.`,
    );
  }
  if (r.until && at > new Date(`${r.until}T23:59:59Z`) && r.after) {
    return { ...r.after, note: `post-${r.until} tier` };
  }
  return r;
}

/**
 * Cost, computed BOTH ways, because the two live sources disagree.
 *
 * agents/lib/gemini_loop.mjs:150 asserts candidatesTokenCount already
 * includes thinking tokens. CRMA-727 defect 2 asserts it does not, making
 * every loop under-report. Rather than pick a side, the harness reports
 * both and marks which one reconciles against the API's own
 * totalTokenCount. Over a replay batch that settles the argument with
 * arithmetic instead of opinion.
 */
export function costBothWays(usage, model, at) {
  const rate = ratesFor(model, at);
  const input = usage.promptTokenCount || 0;
  const candidates = usage.candidatesTokenCount || 0;
  const thoughts = usage.thoughtsTokenCount || 0;
  const total = usage.totalTokenCount || 0;

  const asDeployed = (input / 1e6) * rate.input + (candidates / 1e6) * rate.output;
  const withThinking = (input / 1e6) * rate.input + ((candidates + thoughts) / 1e6) * rate.output;

  // Which output interpretation reconciles with the API's own total?
  // With zero thinking tokens both readings coincide, so the test proves
  // nothing — say so rather than reporting a coincidence as evidence.
  let reconciles = "indeterminate";
  if (thoughts === 0) {
    reconciles = "n/a_no_thinking_tokens";
  } else if (total > 0) {
    if (input + candidates === total) reconciles = "candidates_includes_thinking";
    else if (input + candidates + thoughts === total) reconciles = "candidates_excludes_thinking";
  }

  return {
    input_tokens: input,
    candidates_tokens: candidates,
    thoughts_tokens: thoughts,
    total_tokens: total,
    cost_as_deployed: round4(asDeployed),
    cost_with_thinking: round4(withThinking),
    understated_by: round4(withThinking - asDeployed),
    reconciles,
    rate,
  };
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * One Gemini call. Returns the raw response alongside parsed parts, so a
 * lane can diff structure rather than prose when it needs to.
 *
 * @param {object} a
 * @param {string} a.apiKey
 * @param {string} a.model              Model id under test.
 * @param {string} [a.system]           System instruction.
 * @param {Array}  a.contents           Full conversation contents array.
 * @param {Array}  [a.tools]            functionDeclarations wrapper array.
 * @param {object} [a.responseSchema]   Structured-output schema.
 * @param {string} [a.thinkingLevel]    low | medium | high.
 * @param {number} [a.maxOutputTokens]
 * @param {number} [a.temperature]      Omitted unless explicitly passed.
 * @param {string} [a.functionCallingMode] AUTO | VALIDATED | ANY | NONE.
 */
export async function callGemini({
  apiKey,
  model,
  system,
  contents,
  tools,
  responseSchema,
  thinkingLevel = "medium",
  maxOutputTokens = 8192,
  temperature,
  functionCallingMode = "AUTO",
  timeoutMs = 180_000,
}) {
  if (!apiKey) throw new Error("callGemini: apiKey is required");
  if (!model) throw new Error("callGemini: model is required");

  // A lane passes null to mean "production does not send this key". The
  // discovery lane needs that: its deployed step sends only `temperature`,
  // so a harness-added cap or thinking level would compare against a call
  // production never makes.
  const generationConfig = {};
  if (maxOutputTokens != null) generationConfig.maxOutputTokens = maxOutputTokens;

  // 3.7 Flash cannot disable thinking; asking for a level it lacks is a 400.
  if (NO_THINKING_OFF.has(model) && thinkingLevel === "minimal") {
    generationConfig.thinkingConfig = { thinkingLevel: "low" };
  } else if (thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel };
  }

  // Deprecated since 2026-07-21 — sent only when a lane insists, so that a
  // lane which needs it to reproduce its incumbent can still say so.
  if (temperature != null) generationConfig.temperature = temperature;

  if (responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = responseSchema;
  }

  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) {
    body.tools = tools;
    if (functionCallingMode != null) {
      body.toolConfig = { functionCallingConfig: { mode: functionCallingMode } };
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  const started = Date.now();
  try {
    resp = await fetch(`${ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`Gemini fetch failed (${model}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`Gemini HTTP ${resp.status} (${model}): ${text.slice(0, 800)}`);
    err.status = resp.status;
    err.model = model;
    throw err;
  }

  const data = JSON.parse(text);
  const candidate = (data.candidates || [])[0] || {};
  return {
    model,
    duration_ms: Date.now() - started,
    finishReason: candidate.finishReason || null,
    parts: candidate.content?.parts || [],
    usage: data.usageMetadata || {},
    raw: data,
  };
}

/**
 * finishReason values that production treats as a clean stop but are not
 * (CRMA-727 defect 3). The loops assign stop_reason = finishReason and
 * break, so these land as a silent no-emission.
 */
export const SILENT_FAILURE_REASONS = new Set([
  "MISSING_THOUGHT_SIGNATURE",
  "TOO_MANY_TOOL_CALLS",
  "MALFORMED_RESPONSE",
  "ESCALATION",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "PROHIBITED_CONTENT",
]);

export function classifyFinish(finishReason, emitted) {
  if (emitted) return { ok: true, reason: finishReason || "STOP" };
  if (!finishReason) return { ok: false, reason: "no_finish_reason", silent: true };
  if (SILENT_FAILURE_REASONS.has(finishReason)) {
    return { ok: false, reason: finishReason, silent: true };
  }
  return { ok: false, reason: finishReason, silent: false };
}

/**
 * Agentic tool loop, model-parameterised.
 *
 * Mirrors the deployed loop's contract (verbatim model-part echo for
 * thoughtSignature validity, sequential dispatch) and fixes the three live
 * defects the map holds, each marked so a diff can attribute a behaviour
 * change to the fix rather than to the model.
 */
export async function runLoop({
  apiKey,
  model,
  system,
  userMessage,
  tools,
  dispatchTool,
  context,
  maxIterations = 12,
  budgetUsd = 5.0,
  perCallMaxTokens = 8192,
  thinkingLevel = "medium",
  temperature,
  functionCallingMode = "AUTO",
  onEvent = () => {},
}) {
  const contents = [
    {
      role: "user",
      parts: typeof userMessage === "string" ? [{ text: userMessage }] : userMessage,
    },
  ];

  const accounting = {
    input_tokens: 0,
    candidates_tokens: 0,
    thoughts_tokens: 0,
    total_tokens: 0,
    cost_as_deployed: 0,
    cost_with_thinking: 0,
    reconciles: new Set(),
  };
  const toolCalls = [];
  const trace = [];
  let finalText = "";
  let stopReason = "max_iterations";
  let turn = 0;
  const finishReasons = [];

  while (turn < maxIterations) {
    turn += 1;

    // Budget is measured on the truthful cost, not the understated one.
    if (accounting.cost_with_thinking >= budgetUsd) {
      stopReason = "budget_exhausted";
      trace.push({ turn, kind: "stop", reason: stopReason, cost: accounting.cost_with_thinking });
      break;
    }

    const resp = await callGemini({
      apiKey,
      model,
      system,
      contents,
      tools,
      thinkingLevel,
      maxOutputTokens: perCallMaxTokens,
      temperature,
      functionCallingMode,
    });

    const c = costBothWays(resp.usage, model);
    accounting.input_tokens += c.input_tokens;
    accounting.candidates_tokens += c.candidates_tokens;
    accounting.thoughts_tokens += c.thoughts_tokens;
    accounting.total_tokens += c.total_tokens;
    accounting.cost_as_deployed += c.cost_as_deployed;
    accounting.cost_with_thinking += c.cost_with_thinking;
    accounting.reconciles.add(c.reconciles);
    if (resp.finishReason) finishReasons.push(resp.finishReason);

    const callParts = [];
    for (const p of resp.parts) {
      if (p.functionCall) {
        callParts.push(p);
        trace.push({
          turn,
          kind: "tool_use",
          name: p.functionCall.name,
          args: p.functionCall.args || {},
          has_signature: Boolean(p.thoughtSignature),
        });
      } else if (p.thought === true) {
        trace.push({ turn, kind: "thinking", chars: (p.text || "").length });
      } else if (typeof p.text === "string") {
        trace.push({ turn, kind: "text", text: p.text });
        finalText = p.text;
      }
    }

    // Verbatim echo — reconstructing this array drops thoughtSignature and
    // earns a 400. Same rule as production.
    contents.push({ role: "model", parts: resp.parts });
    onEvent({ turn, finishReason: resp.finishReason, toolCount: callParts.length });

    if (callParts.length === 0) {
      stopReason = resp.finishReason || "STOP";
      break;
    }

    const responseParts = [];
    for (const fcp of callParts) {
      const fc = fcp.functionCall;
      const started = Date.now();
      let out;
      let failed = null;
      try {
        out = await dispatchTool(fc.name, fc.args || {}, context);
      } catch (e) {
        failed = e.message;
        out = { error: e.message };
      }
      toolCalls.push({
        turn,
        name: fc.name,
        args: fc.args || {},
        output: out,
        error: failed,
        duration_ms: Date.now() - started,
      });
      const part = {
        functionResponse: {
          name: fc.name,
          response: out && typeof out === "object" ? out : { result: out },
        },
      };
      // CRMA-727 defect 1: results map back by id. Production omits this.
      if (fc.id) part.functionResponse.id = fc.id;
      responseParts.push(part);
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return {
    model,
    stop_reason: stopReason,
    finish_reasons: finishReasons,
    turns: turn,
    tool_calls: toolCalls,
    trace,
    final_text: finalText,
    contents,
    accounting: {
      ...accounting,
      cost_as_deployed: round4(accounting.cost_as_deployed),
      cost_with_thinking: round4(accounting.cost_with_thinking),
      understated_by: round4(accounting.cost_with_thinking - accounting.cost_as_deployed),
      reconciles: [...accounting.reconciles],
    },
  };
}

/** Pull the args of the terminal emitting tool call, e.g. propose_enrichment. */
export function terminalEmission(result, toolName) {
  const hit = [...result.tool_calls].reverse().find((t) => t.name === toolName);
  return hit ? hit.args : null;
}
