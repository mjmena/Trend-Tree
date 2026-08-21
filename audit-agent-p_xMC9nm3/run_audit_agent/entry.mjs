// Audit Agent — run_audit_agent
//
// Single Gemini 3.1 Pro agent loop. Purely observational — no live HTTP,
// no Snowflake from inside the loop. All inputs prefetched in workflow.yaml
// (pipeline_freshness, dashboard_freshness, stuck_trends, cost_24h_rows,
// audit_prompts, pipedream_errors, catalog_freshness). The four query tools
// just slice and filter that prefetched data; propose_audit_report is the
// terminal capture.
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports fail at deploy. Cross-workflow
// shared libs don't bundle either. Mirrors lifecycle-subagent's pattern.
//
// Exception: ./catalog_freshness.mjs is a sibling in this SAME step dir
// (the one cross-file import Pipedream's bundler allows) and holds the
// CRMA-775 catalog-freshness grading as a plain, defineComponent-free
// module — deterministic, not LLM-judged, and independently unit-testable.
// This file is named entry.mjs (not entry.js, unlike this workflow's other
// steps) BECAUSE it does this sibling import — a hand-authored .js step
// cannot use sibling .mjs imports (pipedream-synced-project skill).
// =====================================================================

import { gradeCatalogFreshness, buildCatalogFreshnessBlock, applyCatalogFinding } from "./catalog_freshness.mjs";

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

function fmtJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// ─────────────────────────────────────────────────────────────────────
// Tool schemas (Anthropic-shaped; translated to Gemini at loop entry)
// ─────────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = {
  query_pipeline_freshness: {
    name: "query_pipeline_freshness",
    description:
      "Slice the prefetched pipeline-freshness snapshot by area. Returns the relevant rollup rows. Use when you need finer-grained inspection than the inlined block (e.g. just the per-source signal counts).",
    input_schema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          enum: ["ingestion", "promotion", "enrichment", "lifecycle", "dashboard", "all"],
          description: "Which slice of the freshness snapshot to return.",
        },
      },
    },
  },
  query_workflow_errors: {
    name: "query_workflow_errors",
    description:
      "Filter the prefetched Pipedream-error pool. Returns workflows with at least min_count errors in the last since_hours window. Useful for digging into a specific workflow when the inlined block shows aggregate counts but not per-event detail.",
    input_schema: {
      type: "object",
      properties: {
        workflow_name: { type: "string", description: "Optional substring match on workflow name (case-insensitive)." },
        min_count: { type: "integer", description: "Minimum error count to include (default 1)." },
        since_hours: { type: "number", description: "Window in hours (default 24, max 24)." },
      },
    },
  },
  query_stuck_entities: {
    name: "query_stuck_entities",
    description:
      "Filter the prefetched stuck-trend list (trends promoted with no enrichment ledger row) by minimum age. Use to quantify the enrichment lag.",
    input_schema: {
      type: "object",
      properties: {
        min_age_hours: { type: "number", description: "Minimum hours since PROMOTED_AT (default 6)." },
      },
    },
  },
  query_cost_breakdown: {
    name: "query_cost_breakdown",
    description:
      "Slice the prefetched 24h cost rollup. Filter by agent name (substring) or model. Returns rows of {agent, model, runs, input_tokens, output_tokens, cost_usd}.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Optional substring match (e.g. 'enrichment', 'promotion', 'lifecycle')." },
        model: { type: "string", description: "Optional model substring (e.g. 'sonnet', 'gemini')." },
      },
    },
  },
  propose_audit_report: {
    name: "propose_audit_report",
    description:
      "Emit the final structured audit report. Call exactly ONCE near the end of the loop. The commit step persists this; the Slack step posts slack_summary_md (gated on overall_status != GREEN unless force_slack=true). If you don't call it, nothing gets written.",
    input_schema: {
      type: "object",
      properties: {
        overall_status: { type: "string", enum: ["GREEN", "YELLOW", "RED"] },
        ingestion: { type: "object", description: "{ status, signals_24h_by_source, baseline_7d_avg, gap_notes }" },
        distillation: { type: "object", description: "{ status, candidates_24h, processed_24h, pending_oldest_hours }" },
        promotion: { type: "object", description: "{ status, ledger_inserts_24h, gemini_cost_24h_usd }" },
        enrichment: { type: "object", description: "{ status, ledger_inserts_24h, p50_lag_minutes, sonnet_cost_24h_usd }" },
        lifecycle: { type: "object", description: "{ status, ledger_inserts_24h, last_eval_age_minutes, gemini_cost_24h_usd }" },
        dashboard: { type: "object", description: "{ status, last_refresh_age_minutes, target_lag_minutes }" },
        workflow_health: { type: "object", description: "{ audited_count, active_count, errored_24h: [{workflow_name, count, top_error}] }" },
        cost_24h_usd: { type: "number" },
        alerts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["INFO", "WARN", "RED"] },
              area: { type: "string" },
              summary: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["severity", "area", "summary"],
          },
        },
        slack_summary_md: { type: "string", description: "≤ 1500 chars. Markdown for Slack DM body." },
        reasoning: { type: "string", description: "≤500 chars defending overall_status." },
      },
      required: ["overall_status", "alerts", "slack_summary_md", "reasoning"],
    },
  },
};

const ALL_TOOL_NAMES = [
  "query_pipeline_freshness",
  "query_workflow_errors",
  "query_stuck_entities",
  "query_cost_breakdown",
  "propose_audit_report",
];

// ─────────────────────────────────────────────────────────────────────
// In-process tool dispatchers (operate on prefetched context only)
// ─────────────────────────────────────────────────────────────────────

function queryPipelineFreshness(input, ctx) {
  const snap = ctx.pipeline_freshness || {};
  const area = input?.area || "all";
  if (area === "all") return snap;
  return { [area]: snap[area] ?? null };
}

function queryWorkflowErrors(input, ctx) {
  const pool = ctx.pipedream_health?.workflows || [];
  const nameSub = (input?.workflow_name || "").toLowerCase();
  const minCount = Number(input?.min_count) || 1;
  const sinceHours = Math.min(Number(input?.since_hours) || 24, 24);
  const sinceMs = Date.now() - sinceHours * 3600_000;

  const filtered = pool
    .map((w) => {
      const errs = (w.errors_24h || []).filter((e) => !e.ts_ms || e.ts_ms >= sinceMs);
      return { ...w, errors_in_window: errs, count: errs.length };
    })
    .filter((w) => w.count >= minCount)
    .filter((w) => (nameSub ? (w.workflow_name || "").toLowerCase().includes(nameSub) : true));

  return { workflows: filtered, total_in_pool: pool.length };
}

function queryStuckEntities(input, ctx) {
  const pool = ctx.stuck_trends || [];
  const minAge = Number(input?.min_age_hours) || 6;
  const filtered = pool.filter((t) => Number(t.HOURS_SINCE_PROMOTED || t.hours_since_promoted || 0) >= minAge);
  return { stuck: filtered, total_in_pool: pool.length };
}

function queryCostBreakdown(input, ctx) {
  const pool = ctx.cost_24h || [];
  const agentSub = (input?.agent_name || "").toLowerCase();
  const modelSub = (input?.model || "").toLowerCase();
  const filtered = pool
    .filter((r) => (agentSub ? String(r.AGENT || r.agent || "").toLowerCase().includes(agentSub) : true))
    .filter((r) => (modelSub ? String(r.MODEL_USED || r.model || "").toLowerCase().includes(modelSub) : true));
  const total = filtered.reduce((s, r) => s + Number(r.COST_USD || r.cost_usd || 0), 0);
  return { rows: filtered, total_cost_usd: Math.round(total * 10000) / 10000 };
}

function proposeAuditReport(input, ctx) {
  ctx.proposed_report = { ...input, emitted_at: new Date().toISOString() };
  return {
    accepted: true,
    note: "Audit report captured. Commit step will persist; Slack step will post if overall_status != GREEN or force_slack=true.",
  };
}

const DISPATCHERS = {
  query_pipeline_freshness: queryPipelineFreshness,
  query_workflow_errors: queryWorkflowErrors,
  query_stuck_entities: queryStuckEntities,
  query_cost_breakdown: queryCostBreakdown,
  propose_audit_report: proposeAuditReport,
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
// Gemini 3.1 Pro agent loop runtime (inlined from agents/lib/gemini_loop.mjs)
// ─────────────────────────────────────────────────────────────────────

const MODEL = "gemini-3.1-pro-preview";
const RATES_PER_M = { input: 2.0, output: 12.0 };  // sub-200k context tier

const LOOP_DEFAULTS = {
  max_iterations: 6,
  budget_usd: 0.50,
  per_call_max_tokens: 4096,
  thinking_level: "medium",
  temperature: 1.0,
  request_timeout_ms: 120_000,
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

const SYSTEM_PROMPT_KEY = "audit.system";
const RUBRIC_PROMPT_KEY = "audit.report_rubric";

export default defineComponent({
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    event: { type: "any" },
    pipeline_freshness_rows: { type: "any" },
    dashboard_freshness_rows: { type: "any" },
    stuck_trends_rows: { type: "any" },
    orphan_trends_rows: { type: "any", optional: true },
    cost_24h_rows: { type: "any" },
    et_rescue_rows: { type: "any", optional: true },
    catalog_freshness_rows: { type: "any", optional: true },
    pipedream_errors: { type: "any" },
    prompts_rows: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const started = Date.now();

    // Reshape pipeline_freshness_rows into per-area structure. The single
    // q_pipeline_freshness query returns one row per (area, key) — see
    // workflow.yaml for the SQL shape.
    const freshnessRows = this.pipeline_freshness_rows || [];
    const pipeline_freshness = {
      ingestion: freshnessRows.filter((r) => r.AREA === "ingestion"),
      promotion: freshnessRows.filter((r) => r.AREA === "promotion"),
      enrichment: freshnessRows.filter((r) => r.AREA === "enrichment"),
      lifecycle: freshnessRows.filter((r) => r.AREA === "lifecycle"),
      distillation: freshnessRows.filter((r) => r.AREA === "distillation"),
    };
    const dashboard_freshness = (this.dashboard_freshness_rows || [])[0] || null;
    const stuck_trends = this.stuck_trends_rows || [];
    const orphan_trends_count = Number((this.orphan_trends_rows || [])[0]?.ACTIVE_ORPHAN_TRENDS || 0);
    const cost_24h = this.cost_24h_rows || [];
    const et_rescue = (this.et_rescue_rows || [])[0] || {};
    const pipedream_health = this.pipedream_errors || { summary: {}, workflows: [] };
    // CRMA-775: deterministic catalog-sync freshness grade (GREEN<=3d /
    // YELLOW<=7d / RED>7d over MAX(LAST_SEEN_AT), per active TIER). Computed
    // here so it's folded into the report regardless of whether the LLM
    // loop notices it — see catalog_freshness.mjs for why.
    const catalogGraded = gradeCatalogFreshness(this.catalog_freshness_rows || []);

    // Load + render prompts
    const prompts = loadPrompts(this.prompts_rows);
    const systemTpl = mustGet(prompts, SYSTEM_PROMPT_KEY).template;
    const rubricTpl = mustGet(prompts, RUBRIC_PROMPT_KEY).template;

    // Compose the inlined context blocks. The agent's tools are still
    // available for finer slicing, but the bulk of the context lives in
    // the system prompt — fewer round trips, cheaper.
    const pipelineFreshnessBlock = fmtJson(pipeline_freshness);
    const dashboardFreshnessBlock = fmtJson(dashboard_freshness);
    const stuckTrendsBlock = stuck_trends.length === 0
      ? "(no stuck trends)"
      : fmtJson(stuck_trends.slice(0, 50));
    const orphanTrendsBlock = `active_orphan_trends: ${orphan_trends_count}\n` +
      `(live trends whose FCT_TREND_SIGNALS all point at SIGNAL_IDs not in FCT_SIGNALS — ` +
      `distillation-agent leak. Migration backlog was purged 2026-05-26; this should stay near 0.)`;
    const cost24hBlock = fmtJson(cost_24h);
    const catalogFreshnessBlock = buildCatalogFreshnessBlock(catalogGraded);
    // ET corroboration-oracle rescue funnel (ADR-0004). Single prefetched row.
    const etr = et_rescue;
    const n = (v) => Number(v || 0);
    const etQueryCov = n(etr.CANDS_24H) > 0
      ? `${n(etr.CANDS_WITH_QUERY_24H)}/${n(etr.CANDS_24H)} (${Math.round(100 * n(etr.CANDS_WITH_QUERY_24H) / n(etr.CANDS_24H))}%)`
      : "n/a (no candidates in 24h)";
    const etRescueBlock =
      `candidate_query_authoring_coverage: ${etQueryCov}\n` +
      `et_consulted (single-family rescue attempts, = new LLM spend): ${n(etr.ET_CONSULTED_24H)}\n` +
      `  -> et_rescued_and_promoted: ${n(etr.ET_RESCUED_24H)}\n` +
      `  -> et_consulted_but_rejected: ${n(etr.ET_CONSULTED_REJECTED_24H)}\n` +
      `et_ledger_rows_written: ${n(etr.ET_LEDGER_ROWS_24H)} (should EQUAL et_rescued_and_promoted)\n` +
      `Interpretation: query coverage should approach 100% — near 0% means distillation ` +
      `is not authoring the atomic query, so ET rescue silently no-ops while still paying ` +
      `for the subagent run (WARN). et_ledger_rows != et_rescued signals a ledger-seed bug ` +
      `(WARN). A spike in et_consulted with ~zero rescues over many days can mean bad ` +
      `queries or ET API failures — check the promotion subagent logs for http_403 / ` +
      `timeout / "key not configured". Some rejects are healthy (ET genuinely misses); ` +
      `judge the RATIO over time, not a single day. This funnel is INFORMATIONAL — only ` +
      `raise an alert on the structural anomalies above, not on normal reject volume.`;
    const pipedreamHealthBlock = fmtJson({
      summary: pipedream_health.summary,
      note: "active flag is NOT surfaced — Pipedream REST has no GET endpoint for it. Do not infer 'workflow deactivated' from missing active field.",
      workflows: (pipedream_health.workflows || []).map((w) => ({
        workflow_name: w.workflow_name,
        workflow_id: w.workflow_id,
        errors_24h_count: w.errors_24h_count,
        top_errors: (w.errors_24h || []).slice(0, 3).map((e) => ({
          ts_iso: e.ts_iso, code: e.code, msg: e.msg, cell_id: e.cell_id,
        })),
        fetch_error: w.fetch_error,
      })),
    });

    const renderedSystem = render(systemTpl, {
      report_rubric: rubricTpl,
      pipeline_freshness_block: pipelineFreshnessBlock,
      dashboard_freshness_block: dashboardFreshnessBlock,
      stuck_trends_block: stuckTrendsBlock,
      orphan_trends_block: orphanTrendsBlock,
      et_rescue_block: etRescueBlock,
      catalog_freshness_block: catalogFreshnessBlock,
      cost_24h_block: cost24hBlock,
      pipedream_health_block: pipedreamHealthBlock,
    });

    const userMessage =
      `Run the audit for chain_id=${ev.chain_id}, trigger=${ev.trigger_kind}, ` +
      `lookback_hours=${ev.lookback_hours}. Decide each per-area status, compose ` +
      `alerts[], and emit propose_audit_report exactly once.`;

    const context = {
      pipeline_freshness,
      pipedream_health,
      stuck_trends,
      cost_24h,
      proposed_report: null,
    };

    // Apply prompt-defined model_params if present (max_iterations, budget_usd, etc.)
    const sysParams = mustGet(prompts, SYSTEM_PROMPT_KEY).params || {};

    // CRMA-775: a thrown Gemini error (HTTP failure, timeout, etc.) must not
    // swallow the deterministic catalog-freshness finding — catch it here
    // and synthesize a minimal loop result so the fallback-report path below
    // still runs, and the ledger/Slack chain still fires with whatever we DO
    // know (catalog). Previously an uncaught throw here failed the whole
    // step and no report — catalog included — ever reached commit/Slack.
    let loop;
    try {
      loop = await runAgentLoop({
        google_gemini: this.google_gemini,
        tool_names: ALL_TOOL_NAMES,
        system: renderedSystem,
        user_message: userMessage,
        context,
        max_iterations: Number(sysParams.max_iterations) || LOOP_DEFAULTS.max_iterations,
        budget_usd: Number(sysParams.budget_usd) || LOOP_DEFAULTS.budget_usd,
        per_call_max_tokens: Number(sysParams.per_call_max_tokens) || LOOP_DEFAULTS.per_call_max_tokens,
        thinking_level: sysParams.thinking_level || LOOP_DEFAULTS.thinking_level,
      });
    } catch (e) {
      loop = {
        stop_reason: "agent_loop_threw",
        turns: 0,
        tokens: { input: 0, output: 0, total: 0 },
        cost_usd: 0,
        model: MODEL,
        error_message: e.message,
      };
      context.proposed_report = null;
    }

    const llmReport = context.proposed_report;
    const synthesized_fallback = !llmReport;
    const loopThrew = loop.stop_reason === "agent_loop_threw";
    // Loop ended without terminal-tool call (or threw). Synthesize a YELLOW
    // with a meta-alert so the operator notices instead of silently writing
    // nothing.
    const baseReport = llmReport || {
      overall_status: "YELLOW",
      alerts: [{
        severity: "WARN",
        area: "audit-agent",
        summary: loopThrew
          ? "Agent loop threw before completing — Gemini call failed"
          : "Agent did not call propose_audit_report — possible prompt drift or budget cap",
        evidence: loopThrew
          ? `stop_reason=${loop.stop_reason} error=${loop.error_message}`
          : `stop_reason=${loop.stop_reason} turns=${loop.turns} cost_usd=${loop.cost_usd}`,
      }],
      slack_summary_md: loopThrew
        ? "*Audit YELLOW*: agent loop failed before emitting a report (Gemini call error). Investigate immediately."
        : "*Audit YELLOW*: agent loop ended without emitting a report. Investigate prompts / budget.",
      reasoning: loopThrew
        ? "Fallback emission — agent loop threw an exception."
        : "Fallback emission — no propose_audit_report call observed.",
    };

    // CRMA-775: fold the deterministic catalog-freshness grade in last, on
    // BOTH paths (LLM-emitted or fallback) — a dead catalog sync must be
    // noticed even if the rest of the agent loop misbehaves. Escalates
    // (never de-escalates) overall_status, so the existing post_to_slack /
    // commit_audit_ledger non-GREEN gating picks it up with no changes.
    const report = applyCatalogFinding(baseReport, catalogGraded);

    return {
      report,
      telemetry: {
        tokens: loop.tokens,
        cost_usd: loop.cost_usd,
        model: loop.model,
        stop_reason: loop.stop_reason,
        turns: loop.turns,
        run_duration_ms: Date.now() - started,
      },
      synthesized_fallback,
    };
  },
});
