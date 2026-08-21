// Ecomm Agent — run_sourcing
//
// CRMA-776 (epic CRMA-772). The single mutating step: opens the sourcing
// run header, runs the selector (skipped when the retrieval pool is
// empty), derives the ledger write plan, completes the header, and writes
// the STG_AGENT_RUN_COSTS row — ALL inside one try/catch so that any
// failure after 'open' still reaches a 'failed' completion and a cost row
// (per the AC: "written on failure too"). A catalog-freshness decline
// (ctx.catalog_fresh === false, decided upstream by fetch_context) never
// reaches PROC_SOURCING_APPLY at all — "no header written" IS the decline
// state, not a distinct status.
//
// =====================================================================
// IMPORTANT: two blocks below are INLINED canonical copies (Pipedream
// GitHub-synced workflows do not bundle cross-file imports — see the
// pipedream-synced-project skill):
//   - the Gemini agent loop: canonical source agents/lib/gemini_loop.mjs
//   - the sourcing-run core: canonical source agents/lib/sourcing_run.mjs
// Keep both in exact sync with their canonical files.
// =====================================================================

import snowflake from "snowflake-sdk";

// ---------------------------------------------------------------------------
// sourcing-run core (canonical: agents/lib/sourcing_run.mjs — keep in sync)
// ---------------------------------------------------------------------------

const SEMANTIC_THRESHOLD = 0.40;
const TOP_N = 10;
const MAX_SOURCED_PRODUCTS = 5; // slots for this single-tier build (see agents/lib/sourcing_run.mjs)
const VALID_REASONED_FIT = new Set(["strong", "partial", "weak"]);
const RATIONALE_MAX_CHARS = 400;
const CANDIDATE_EMBED_DOC_CAP = 700;

function applyFloorAndTopN(pool, options = {}) {
  const threshold = options.threshold ?? SEMANTIC_THRESHOLD;
  const topN = options.topN ?? TOP_N;
  return (Array.isArray(pool) ? pool : [])
    .filter((c) => c && typeof c.semantic_score === "number" && Number.isFinite(c.semantic_score) && c.semantic_score >= threshold)
    .sort((a, b) => b.semantic_score - a.semantic_score)
    .slice(0, topN);
}

function capEmbedDoc(doc, capLen = CANDIDATE_EMBED_DOC_CAP) {
  const s = doc === null || doc === undefined ? "" : String(doc);
  return s.length > capLen ? s.slice(0, capLen) : s;
}

function formatCandidatesForPrompt(pool) {
  return (Array.isArray(pool) ? pool : [])
    .map((c, i) => `${i + 1}. catalog_product_id: ${c.catalog_product_id}\n   ${capEmbedDoc(c.embed_doc)}`)
    .join("\n");
}

function trimRationale(raw, capLen = RATIONALE_MAX_CHARS) {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s) return "";
  return s.length > capLen ? s.slice(0, capLen) : s;
}

function buildSourcingRunPlan({ pool, selectorEmit, slots = MAX_SOURCED_PRODUCTS } = {}) {
  const safePool = applyFloorAndTopN(pool);
  const poolById = new Map(safePool.map((c) => [String(c.catalog_product_id), c]));
  const warnings = [];

  if (safePool.length === 0) {
    return {
      outcome: "no_match",
      selector_note: "Retrieval found zero candidates at or above the similarity floor in the active catalog.",
      error_message: null,
      candidates: [],
      warnings,
    };
  }

  if (!selectorEmit || typeof selectorEmit !== "object") {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: "selector produced no usable emission (missing, non-object, or the call itself errored)",
      candidates: [],
      warnings,
    };
  }

  const rawOutcome = selectorEmit.outcome;
  if (rawOutcome !== "matched" && rawOutcome !== "no_match") {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: `selector emitted an invalid outcome: ${JSON.stringify(rawOutcome)}`,
      candidates: [],
      warnings,
    };
  }

  const poolNote = selectorEmit.pool_note === null || selectorEmit.pool_note === undefined
    ? ""
    : String(selectorEmit.pool_note).trim();

  if (rawOutcome === "no_match") {
    return {
      outcome: "no_match",
      selector_note: poolNote || "Selector found no candidate serving the trend.",
      error_message: null,
      candidates: [],
      warnings,
    };
  }

  const rawPicks = Array.isArray(selectorEmit.picks) ? selectorEmit.picks : [];
  if (rawPicks.length === 0) {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: "selector emitted outcome=matched with an empty picks list (contract violation — use outcome=no_match for a refusal)",
      candidates: [],
      warnings,
    };
  }

  const validPicks = [];
  for (const pick of rawPicks) {
    const id = pick && pick.catalog_product_id !== null && pick.catalog_product_id !== undefined
      ? String(pick.catalog_product_id)
      : "";
    if (!id || !poolById.has(id)) {
      warnings.push(`hallucinated_pick:${id || "(missing catalog_product_id)"}`);
      continue;
    }
    if (!VALID_REASONED_FIT.has(pick.reasoned_fit)) {
      warnings.push(`invalid_reasoned_fit:${id}:${JSON.stringify(pick.reasoned_fit)}`);
      continue;
    }
    validPicks.push({ id, reasoned_fit: pick.reasoned_fit, rationale: trimRationale(pick.rationale) });
  }

  const seen = new Set();
  let deduped = [];
  for (const p of validPicks) {
    if (seen.has(p.id)) {
      warnings.push(`duplicate_pick:${p.id}`);
      continue;
    }
    seen.add(p.id);
    deduped.push(p);
  }

  if (deduped.length > slots) {
    const dropped = deduped.length - slots;
    deduped = deduped.slice(0, slots);
    warnings.push(`picks_exceeded_slots:dropped_${dropped}`);
  }

  if (deduped.length === 0) {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: `selector emitted outcome=matched but every pick was invalid: ${warnings.join("; ")}`,
      candidates: [],
      warnings,
    };
  }

  const pickedById = new Map(deduped.map((p) => [p.id, p]));
  const candidates = safePool.map((c) => {
    const cid = String(c.catalog_product_id);
    const picked = pickedById.get(cid) || null;
    return {
      catalog_product_id: c.catalog_product_id,
      product_handle: c.product_handle ?? null,
      product_title: c.product_title ?? null,
      product_type: c.product_type ?? null,
      vendor: c.vendor ?? null,
      product_url: c.product_url ?? null,
      price_at_match: c.price_at_match ?? null,
      image_url_at_match: c.image_url_at_match ?? null,
      available_at_match: c.available_at_match ?? null,
      semantic_score: c.semantic_score,
      selected: !!picked,
      reasoned_fit: picked ? picked.reasoned_fit : null,
      reasoned_fit_rationale: picked ? (picked.rationale || null) : null,
      catalog_payload: c.catalog_payload ?? null,
    };
  });

  return { outcome: "matched", selector_note: poolNote || null, error_message: null, candidates, warnings };
}

// ---------------------------------------------------------------------------
// Gemini agent loop (canonical: agents/lib/gemini_loop.mjs — keep in sync)
// ---------------------------------------------------------------------------

const GEMINI_DEFAULTS = {
  max_iterations: 12,
  budget_usd: 5.0,
  per_call_max_tokens: 8192,
  thinking_level: "medium",
  temperature: 1.0,
  function_calling_mode: "AUTO",
  request_timeout_ms: 180_000,
};

function toFunctionDeclarations(toolNames, allSchemas) {
  return toolNames.map((n) => {
    const s = allSchemas[n];
    if (!s) throw new Error(`Unknown tool: ${n}`);
    return { name: s.name, description: s.description, parameters: s.input_schema };
  });
}

async function runAgentLoop({
  google_gemini, tool_names, all_schemas, system, user_message, context, dispatchTool,
  max_iterations = GEMINI_DEFAULTS.max_iterations,
  budget_usd = GEMINI_DEFAULTS.budget_usd,
  per_call_max_tokens = GEMINI_DEFAULTS.per_call_max_tokens,
  thinking_level = GEMINI_DEFAULTS.thinking_level,
  model,
  function_calling_mode = GEMINI_DEFAULTS.function_calling_mode,
  temperature = GEMINI_DEFAULTS.temperature,
  rates_per_m,
}) {
  if (!google_gemini?.$auth?.api_key) throw new Error("google_gemini app prop missing $auth.api_key");
  if (!Array.isArray(tool_names) || tool_names.length === 0) throw new Error("tool_names is required");
  if (!all_schemas) throw new Error("all_schemas is required");
  if (typeof dispatchTool !== "function") throw new Error("dispatchTool must be a function");

  const apiKey = google_gemini.$auth.api_key;
  const tools = [{ functionDeclarations: toFunctionDeclarations(tool_names, all_schemas) }];
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

    const generationConfig = {
      maxOutputTokens: per_call_max_tokens,
      thinkingConfig: { thinkingLevel: thinking_level },
    };
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
      const timer = setTimeout(() => ctrl.abort(), GEMINI_DEFAULTS.request_timeout_ms);
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody), signal: ctrl.signal },
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
    cost_usd += (tin / 1_000_000) * rates_per_m.input + (tout / 1_000_000) * rates_per_m.output;

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
      reasoning_trace.push({ turn, kind: "tool_result", name: fc.name, output_preview: fc.name });
      responseParts.push({ functionResponse: { name: fc.name, response: out && typeof out === "object" ? out : { result: out } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return { stop_reason, turns: turn, tokens, cost_usd: Math.round(cost_usd * 10000) / 10000, reasoning_trace, tool_calls, final_text, model };
}

// ---------------------------------------------------------------------------
// The selector — code-pinned model + call shape (CRMA-754 prototype
// contract; NOT registry-driven — only discovery lanes are, per this
// repo's fleet convention). rates_per_m is a public-pricing ESTIMATE for
// gemini-3.7-flash (this repo has no confirmed-invoice rate for it yet —
// flag this in review), sanity-checked against the CRMA-754 prototype's
// measured $0.0013-$0.0032/call.
// ---------------------------------------------------------------------------

const SELECTOR_MODEL = "gemini-3.7-flash";
const SELECTOR_RATES_PER_M = { input: 0.30, output: 2.50 }; // ESTIMATE — see comment above

const PROPOSE_PRODUCT_SELECTION_SCHEMA = {
  name: "propose_product_selection",
  description: "Emit the sourcing pass's product selection for this trend. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["matched", "no_match"], description: "matched if at least one product genuinely serves the trend; no_match otherwise." },
      picks: {
        type: "array",
        description: "Up to {slots} picks. Empty when outcome=no_match.",
        items: {
          type: "object",
          properties: {
            catalog_product_id: { type: "string", description: "Echoed verbatim from the shown candidate pool." },
            reasoned_fit: { type: "string", enum: ["strong", "partial", "weak"] },
            rationale: { type: "string", description: "One sentence, max 25 words, operator-facing. No scores, no hedging." },
          },
          required: ["catalog_product_id", "reasoned_fit", "rationale"],
        },
      },
      pool_note: { type: "string", description: "One sentence on the pool overall — what was rejected and why, or why nothing matched." },
    },
    required: ["outcome", "picks", "pool_note"],
  },
};

async function dispatchSelectorTool() {
  return { accepted: true };
}

function renderSlots(template, slots) {
  return String(template ?? "").split("{slots}").join(String(slots));
}

function buildSelectorUserMessage(trend, pool) {
  const t = trend || {};
  return [
    "Trend:",
    `  Name: ${t.trend_name || "(unnamed)"}`,
    `  Category: ${t.category || "?"} / ${t.subcategory || "?"}`,
    `  Summary: ${t.summary_short || "(none)"}`,
    "",
    "Candidates (score-descending):",
    formatCandidatesForPrompt(pool),
  ].join("\n");
}

async function callSelector({ google_gemini, prompt, trend, pool, slots = MAX_SOURCED_PRODUCTS }) {
  const system = renderSlots(prompt.template, slots);
  const user_message = buildSelectorUserMessage(trend, pool);
  const params = prompt.params || {};

  const result = await runAgentLoop({
    google_gemini,
    tool_names: ["propose_product_selection"],
    all_schemas: { propose_product_selection: PROPOSE_PRODUCT_SELECTION_SCHEMA },
    system,
    user_message,
    context: {},
    dispatchTool: dispatchSelectorTool,
    model: SELECTOR_MODEL,
    function_calling_mode: params.function_calling_mode || "ANY",
    thinking_level: params.thinking_level || "low",
    temperature: null, // deprecated fleet-wide — never sent for this lane
    max_iterations: params.max_iterations || 1,
    budget_usd: params.budget_usd || 0.02,
    per_call_max_tokens: params.per_call_max_tokens || 1024,
    rates_per_m: SELECTOR_RATES_PER_M,
  });

  const call = result.tool_calls.find((c) => c.name === "propose_product_selection");
  return { emit: call ? call.input : null, telemetry: result };
}

// ---------------------------------------------------------------------------
// Snowflake — direct snowflake-sdk with bounded retry (same pattern as
// fetch_context/entry.mjs and prediction-agent's commit_to_ledger.mjs).
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const TRANSIENT = /network|could not reach|unable to connect|connection|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|disconnect|timed out|timeout/i;

function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}
function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)) });
  });
}
function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWithRetry(connOpts, sqlText, binds) {
  for (let attempt = 1; ; attempt++) {
    let conn;
    let connected = false;
    try {
      conn = await connect(connOpts);
      connected = true;
      return await execute(conn, sqlText, binds);
    } catch (err) {
      const transient = !connected || TRANSIENT.test(String(err.message || err));
      if (!transient || attempt >= MAX_ATTEMPTS) {
        err.message = `Snowflake ${connected ? "execute" : "connect"} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`;
        throw err;
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? 3000;
      console.log(`Transient Snowflake error on attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}; retrying in ${backoff}ms`);
      await sleep(backoff);
    } finally {
      if (conn) await destroy(conn);
    }
  }
}

const CALL_OPEN = `
  CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
    'open', NULL, ?, ?, ?, ?, ?, ?, ?,
    NULL, NULL, NULL, NULL
  )
`;
const CALL_COMPLETE = `
  CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
    'complete', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    ?, ?, ?, PARSE_JSON(?)
  )
`;
const INSERT_COST_ROW = `
  INSERT INTO MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
    RUN_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, WORKFLOW_NAME,
    STARTED_AT, ENDED_AT, DURATION_MS, MODEL,
    INPUT_TOKENS, INPUT_TOKENS_CACHED, OUTPUT_TOKENS, THINKING_TOKENS,
    TOOL_CALL_COUNT, TURN_COUNT, COST_USD, STATUS, ERROR_MESSAGE
  ) VALUES (?, ?, ?, 1, 'ecomm-agent', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)
`;

async function callProcOpen(connOpts, evt) {
  const rows = await runWithRetry(connOpts, CALL_OPEN, [
    evt.trend_id, evt.tier, SEMANTIC_THRESHOLD, SELECTOR_MODEL, "v1", "v1", evt.agent_session_id,
  ]);
  const receipt = rows?.[0]?.[Object.keys(rows[0])[0]];
  const parsed = typeof receipt === "string" ? JSON.parse(receipt) : receipt;
  if (!parsed || parsed.applied !== true) {
    throw new Error(`PROC_SOURCING_APPLY open failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function callProcComplete(connOpts, sourcingRunId, plan) {
  const rows = await runWithRetry(connOpts, CALL_COMPLETE, [
    sourcingRunId, plan.outcome, plan.error_message, plan.selector_note, JSON.stringify(plan.candidates || []),
  ]);
  const receipt = rows?.[0]?.[Object.keys(rows[0])[0]];
  return typeof receipt === "string" ? JSON.parse(receipt) : receipt;
}

async function insertCostRow(connOpts, row) {
  await runWithRetry(connOpts, INSERT_COST_ROW, [
    row.run_id, row.agent_session_id, row.chain_id,
    row.started_at, row.ended_at, row.duration_ms, row.model,
    row.input_tokens, row.output_tokens, row.tool_call_count, row.turn_count,
    row.cost_usd, row.status, row.error_message,
  ]);
}

function cryptoRandomId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    google_gemini: { type: "app", app: "google_gemini" },
    event: { type: "any" },
    context: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event;
    const ctx = this.context;
    const startedAt = new Date();

    // DECLINE — the catalog freshness gate. No header, no cost row, no LLM
    // call: "no header written at all" IS the decline state (not 'failed').
    if (!ctx.catalog_fresh) {
      console.log(`ecomm-agent run_sourcing: DECLINED trend=${evt.trend_id} reason=${ctx.decline_reason}`);
      $.export("$summary", `declined: ${ctx.decline_reason}`);
      return {
        decision: "declined",
        trend_id: evt.trend_id,
        tier: evt.tier,
        reason: ctx.decline_reason,
        catalog_age_days: ctx.catalog_age_days,
      };
    }

    const connOpts = {
      account: this.snowflake.$auth.account,
      username: this.snowflake.$auth.username,
      privateKey: this.snowflake.$auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_PRESENTATION",
      schema: "TREND_AGENT",
      role: "MARKETING_ENGINEER",
    };

    let sourcingRunId = null;
    let selectorTelemetry = null;

    try {
      const openResult = await callProcOpen(connOpts, evt);
      sourcingRunId = openResult.sourcing_run_id;
      console.log(`ecomm-agent run_sourcing: opened sourcing_run_id=${sourcingRunId} trend=${evt.trend_id}`);

      let plan;
      if (!ctx.trend_found) {
        plan = {
          outcome: "failed",
          selector_note: null,
          error_message: `no real (non-seed) enrichment row with TREND_VECTOR found for trend_id ${evt.trend_id}`,
          candidates: [],
          warnings: [],
        };
      } else {
        const pool = applyFloorAndTopN(ctx.pool);
        if (pool.length === 0) {
          plan = buildSourcingRunPlan({ pool: [], selectorEmit: null });
        } else {
          if (!ctx.prompt || !ctx.prompt.template) {
            throw new Error("sourcing.selector prompt not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)");
          }
          const { emit, telemetry } = await callSelector({ google_gemini: this.google_gemini, prompt: ctx.prompt, trend: ctx.trend, pool });
          selectorTelemetry = telemetry;
          plan = buildSourcingRunPlan({ pool, selectorEmit: emit });
        }
      }

      const completeResult = await callProcComplete(connOpts, sourcingRunId, plan);
      if (!completeResult || completeResult.applied !== true) {
        throw new Error(`PROC_SOURCING_APPLY complete failed: ${JSON.stringify(completeResult)}`);
      }

      const endedAt = new Date();
      await insertCostRow(connOpts, {
        run_id: cryptoRandomId("ecomm-cost-"),
        agent_session_id: evt.agent_session_id,
        chain_id: evt.chain_id,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: endedAt.getTime() - startedAt.getTime(),
        model: selectorTelemetry ? SELECTOR_MODEL : null,
        input_tokens: selectorTelemetry?.tokens?.input ?? 0,
        output_tokens: selectorTelemetry?.tokens?.output ?? 0,
        tool_call_count: selectorTelemetry?.tool_calls?.length ?? 0,
        turn_count: selectorTelemetry?.turns ?? 0,
        cost_usd: selectorTelemetry?.cost_usd ?? 0,
        status: "OK",
        error_message: null,
      });

      console.log(`ecomm-agent run_sourcing: COMPLETE sourcing_run_id=${sourcingRunId} outcome=${plan.outcome} selected=${plan.candidates.filter((c) => c.selected).length}/${plan.candidates.length} warnings=${plan.warnings.length}`);
      $.export("$summary", `${evt.trend_id}: ${plan.outcome} (${plan.candidates.filter((c) => c.selected).length} picked)`);

      return {
        decision: "completed",
        sourcing_run_id: sourcingRunId,
        trend_id: evt.trend_id,
        tier: evt.tier,
        outcome: plan.outcome,
        selector_note: plan.selector_note,
        error_message: plan.error_message,
        candidates: plan.candidates,
        warnings: plan.warnings,
        selector_telemetry: selectorTelemetry
          ? { model: SELECTOR_MODEL, turns: selectorTelemetry.turns, tokens: selectorTelemetry.tokens, cost_usd: selectorTelemetry.cost_usd, stop_reason: selectorTelemetry.stop_reason }
          : null,
      };
    } catch (err) {
      console.log(`ecomm-agent run_sourcing: ERROR trend=${evt.trend_id} sourcing_run_id=${sourcingRunId}: ${err.message}`);

      let completeResult = null;
      if (sourcingRunId) {
        try {
          completeResult = await callProcComplete(connOpts, sourcingRunId, {
            outcome: "failed",
            selector_note: null,
            error_message: err.message,
            candidates: [],
          });
        } catch (e2) {
          console.log(`ecomm-agent run_sourcing: failed-completion ALSO failed for sourcing_run_id=${sourcingRunId}: ${e2.message}`);
        }
      }

      const endedAt = new Date();
      try {
        await insertCostRow(connOpts, {
          run_id: cryptoRandomId("ecomm-cost-"),
          agent_session_id: evt.agent_session_id,
          chain_id: evt.chain_id,
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_ms: endedAt.getTime() - startedAt.getTime(),
          model: selectorTelemetry ? SELECTOR_MODEL : null,
          input_tokens: selectorTelemetry?.tokens?.input ?? 0,
          output_tokens: selectorTelemetry?.tokens?.output ?? 0,
          tool_call_count: selectorTelemetry?.tool_calls?.length ?? 0,
          turn_count: selectorTelemetry?.turns ?? 0,
          cost_usd: selectorTelemetry?.cost_usd ?? 0,
          status: "ERROR",
          error_message: String(err.message || err).slice(0, 2000),
        });
      } catch (e3) {
        console.log(`ecomm-agent run_sourcing: cost-row insert ALSO failed: ${e3.message}`);
      }

      $.export("$summary", `${evt.trend_id}: FAILED — ${err.message}`);
      return {
        decision: "failed",
        sourcing_run_id: sourcingRunId,
        trend_id: evt.trend_id,
        tier: evt.tier,
        outcome: "failed",
        error_message: err.message,
        candidates: [],
        warnings: [],
        complete_result: completeResult,
      };
    }
  },
});
