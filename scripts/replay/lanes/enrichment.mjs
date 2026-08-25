// Lane: the enrichment agent loop (CRMA-735).
//
// The deepest schema in the fleet — propose_enrichment declares 39 leaf
// paths — which makes this the lane most exposed to CRMA-727 hazard H8
// (undeclared/dropped schema fields). The ticket says to measure it here
// first, so this adapter is the reference implementation for the others.
//
// Fidelity notes, stated plainly because a lane decision rests on them:
//   - Tool schemas and the tool dispatcher are loaded from the DEPLOYED
//     step file, not from agents/lib (which is a drifting reference copy).
//   - Prefetch SQL is the workflow's own q_* steps, re-bound to a
//     historical trend_id.
//   - Prompts come from DIM_LLM_PROMPT, never the repo — the v7 enrichment
//     template exists only in Snowflake (the CRMA-728 trap).
//   - The user-message formatting is REIMPLEMENTED here, because it lives
//     inside the component's run() body and cannot be imported. It is a
//     line-for-line copy of entry.js:833-863 and must be re-checked if that
//     block changes.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "enrichment-p_xMC995w";
const ENTRY = join(REPO_ROOT, WF_DIR, "run_enrichment_agent", "entry.js");
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");

// Endpoints the deployed step is wired to (workflow.yaml:317-320). Replayed
// tool calls hit the same live tools production uses.
const ENDPOINTS = {
  ingest_search_bluesky: "https://eoydyalz1dslfre.m.pipedream.net",
  ingest_search_gdelt: "https://eoovhehfk229jrg.m.pipedream.net",
  ingest_search_google_trends: "https://eov9u8rngcgi2z6.m.pipedream.net",
  ingest_grok_live_search: "https://eovzc5ljf76h3h6.m.pipedream.net",
};

const parseVariant = (v) => variant(v);

export const name = "enrichment";
export const summary =
  "Single Gemini agent loop producing the canonical enrichment record. Deepest schema in the fleet (39 declared leaf paths).";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-735";

/**
 * Historical cases: real enrichment records the pipeline actually wrote.
 *
 * NOTE ON MODEL_USED: this ledger's MODEL_USED column reads
 * 'claude-sonnet-4-6' on every recent row while PAYLOAD:agent_telemetry.model
 * reads 'gemini-3.1-pro-preview'. The telemetry is the truthful one — the
 * column is mislabelled. Selection therefore filters on the telemetry field,
 * not the column, or it would select nothing.
 */
export async function cases({ limit = 3, caseId = null }) {
  const where = caseId
    ? `AND e.TREND_ID = ${sqlStr(caseId)}`
    : `AND e.PAYLOAD:agent_telemetry:model::STRING = ${sqlStr(incumbentModel)}`;

  const rows = query(`
    SELECT e.TREND_ID, e.ENRICHMENT_ID, e.WRITTEN_AT, e.PAYLOAD,
           e.PAYLOAD:agent_telemetry:model::STRING       AS TELEMETRY_MODEL,
           e.PAYLOAD:agent_telemetry:turns::NUMBER       AS TURNS,
           e.PAYLOAD:agent_telemetry:stop_reason::STRING AS STOP_REASON,
           e.LLM_INPUT_TOKENS, e.LLM_OUTPUT_TOKENS, e.LLM_COST_ESTIMATE,
           t.TREND_TOPIC
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER e
      JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
     WHERE e.ENRICHMENT_KIND = 'initial'
       AND e.PAYLOAD:trend_name IS NOT NULL
       ${where}
     QUALIFY ROW_NUMBER() OVER (PARTITION BY e.TREND_ID ORDER BY e.WRITTEN_AT DESC) = 1
     ORDER BY e.WRITTEN_AT DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => {
    const payload = variant(r.PAYLOAD) || {};
    return {
      id: r.TREND_ID,
      label: `${r.TREND_TOPIC ?? r.TREND_ID} · enriched ${String(r.WRITTEN_AT).slice(0, 16)}`,
      incumbentAt: String(r.WRITTEN_AT).slice(0, 10),
      incumbent: {
        emission: payload,
        telemetry: {
          model: r.TELEMETRY_MODEL,
          turns: r.TURNS,
          stop_reason: r.STOP_REASON,
          input_tokens: r.LLM_INPUT_TOKENS,
          output_tokens: r.LLM_OUTPUT_TOKENS,
          cost_estimate: r.LLM_COST_ESTIMATE,
        },
      },
    };
  });
}

export async function build(c) {
  const wf = readWorkflow(WORKFLOW);
  const bindings = { trend_id: c.id };

  const metrics_rows = runStep(wf, "q_metrics", bindings);
  const signal_rows = runStep(wf, "q_signals", bindings);
  const source_metrics_rows = runStep(wf, "q_source_metrics", bindings);
  const neighbor_rows = runStep(wf, "q_neighbors", bindings);

  const metricsRow = metrics_rows[0];
  if (!metricsRow) throw new Error(`no FCT_TRENDS row for trend_id ${c.id}`);

  const { ALL_SCHEMAS, EAGER_TOOL_NAMES, getToolSchemas, dispatchTool } = await loadStep(ENTRY, [
    "ALL_SCHEMAS",
    "EAGER_TOOL_NAMES",
    "getToolSchemas",
    "dispatchTool",
  ]);

  const source_metrics_pool = source_metrics_rows.map((r) => ({
    source_name: r.SOURCE_NAME,
    headline_metric: r.HEADLINE_METRIC,
    headline_metric_name: r.HEADLINE_METRIC_NAME,
    metrics: parseVariant(r.METRICS),
  }));

  const trend_neighbor_pool = neighbor_rows.map((r) => ({
    trend_id: r.TREND_ID,
    trend_topic: r.TREND_TOPIC,
    total_cluster_size: r.TOTAL_CLUSTER_SIZE,
    distinct_source_count: r.DISTINCT_SOURCE_COUNT,
    velocity_direction: r.VELOCITY_DIRECTION,
    trend_heat_index: r.TREND_HEAT_INDEX,
    last_update_at: r.LAST_UPDATE_AT,
    category: r.CATEGORY,
    subcategory: r.SUBCATEGORY,
    trend_name: r.TREND_NAME || r.TREND_NAME_B2C,
    summary_short: r.SUMMARY_SHORT,
  }));

  const context = {
    source_metrics_pool,
    trend_neighbor_pool,
    proposed_enrichment: null,
    agent_session_id: `replay_${Date.now()}`,
    chain_id: null,
    iteration: 0,
    endpoints: ENDPOINTS,
  };

  // ── copy of entry.js:833-863 ──────────────────────────────────────────
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

  const top_signals_formatted =
    signal_rows
      .map((s, i) => {
        const head = `${i + 1}. [${s.DOMAIN || "?"}] ${s.TITLE || s.SIGNAL_NAME || "(no title)"} — ${s.URL || "(no url)"}`;
        const body = (s.ARTICLE_BODY || "").trim();
        if (body) {
          const snippet = body.replace(/\s+/g, " ").slice(0, 400);
          return `${head}\n     body: "${snippet}${body.length > 400 ? "…" : ""}"`;
        }
        return head;
      })
      .join("\n") || "(no signals)";

  const source_breakdown_formatted =
    source_metrics_pool
      .map((s) => `  • ${s.source_name}: ${s.headline_metric_name || "metric"}=${s.headline_metric ?? "?"}`)
      .join("\n") || "(no source coverage)";

  const related_signals_formatted =
    signal_rows
      .slice(0, 5)
      .map((s, i) => {
        const md = parseVariant(s.SIGNAL_METADATA) || {};
        const why = md.why_now || md.WHY_NOW || "";
        const pub = md.article_published_date || md.ARTICLE_PUBLISHED_DATE || "";
        return `${i + 1}. ${s.TITLE || ""}${pub ? ` (${pub})` : ""}${why ? ` — why_now: ${why}` : ""}`;
      })
      .join("\n") || "(no metadata)";

  const neighbors_formatted =
    trend_neighbor_pool
      .slice(0, 10)
      .map(
        (n, i) =>
          `${i + 1}. "${n.trend_name || n.trend_topic}" — ${n.category || "?"}/${n.subcategory || "?"} (heat ${n.trend_heat_index ?? "?"})`,
      )
      .join("\n") || "(no neighbors in window)";

  const trend_summary_block = `TREND_TOPIC: ${metricsRow.TREND_TOPIC}
TREND_ID: ${c.id}
HEAT_INDEX: ${metricsRow.TREND_HEAT_INDEX} | CLUSTER_SIZE: ${metricsRow.TOTAL_CLUSTER_SIZE} | VELOCITY: ${metricsRow.VELOCITY_DIRECTION}
DETECTED_AT (originally surfaced): ${metricsRow.DETECTED_AT}`;
  // ── end copy ──────────────────────────────────────────────────────────

  const loaded = loadPrompts([
    "enrichment.agent.system",
    "enrichment.agent.naming_guidance",
    "enrichment.agent.user",
  ]);
  const sys = loaded["enrichment.agent.system"];
  const system =
    render(sys.template, { trend_summary_block }) +
    "\n\n" +
    render(loaded["enrichment.agent.naming_guidance"].template, {});

  const userMessage = render(loaded["enrichment.agent.user"].template, {
    trend_metadata_json,
    top_signals_formatted,
    source_breakdown_formatted,
    related_signals_formatted,
    neighbors_formatted,
    // The replay's own date. The incumbent ran on its own date, which is a
    // real and unavoidable confound for any lane whose prompt is dated.
    current_date: new Date().toISOString().slice(0, 10),
  });

  // Schemas come from the deployed getToolSchemas(), then through the same
  // Anthropic input_schema -> Gemini parameters translation the loop does.
  const tools = [
    {
      functionDeclarations: getToolSchemas(EAGER_TOOL_NAMES).map((s) => ({
        name: s.name,
        description: s.description,
        parameters: s.input_schema,
      })),
    },
  ];

  return {
    mode: "loop",
    system,
    userMessage,
    tools,
    toolNames: EAGER_TOOL_NAMES,
    terminalTool: "propose_enrichment",
    terminalSchema: ALL_SCHEMAS.propose_enrichment.input_schema,
    dispatchTool,
    context,
    // Loop limits from the registry params, exactly as entry.js:911-916 reads them.
    maxIterations: sys.params.max_iterations || 10,
    budgetUsd: sys.params.budget_usd || 0.3,
    perCallMaxTokens: sys.params.per_call_max_tokens || 6000,
    thinkingLevel: sys.params.thinking_level || "medium",
    promptProvenance: provenance(loaded),
    notes: {
      signals: signal_rows.length,
      neighbors: neighbor_rows.length,
      source_metrics: source_metrics_rows.length,
      live_tools: "ingest_* tools hit live endpoints; results differ from the incumbent's run date",
    },
  };
}

/** The axes a human actually judges an enrichment record on. */
export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  const pick = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

  const rows = [
    { field: "trend_name", left: a.trend_name, right: b.trend_name },
    // trend_name_b2c / trend_name_b2b were dropped here by CRMA-760: neither is
    // declared in propose_enrichment (the per-audience names went away in the
    // 2026-05-27 single-name cutover), and neither appears in any of the 504
    // ledger payloads. Both axes rendered blank on both sides.
    { field: "summary_short", left: a.summary_short, right: b.summary_short },
    { field: "category / subcategory", left: `${a.category} / ${a.subcategory}`, right: `${b.category} / ${b.subcategory}` },
    { field: "specificity_score", left: a.specificity_score, right: b.specificity_score },
    {
      field: "descriptor.statement",
      left: pick(a, "descriptor.statement"),
      right: pick(b, "descriptor.statement"),
      note: "ADR-0003 axis — see --descriptor-neighbors. Only 333 of 504 ledger payloads carry a descriptor; on an older case this reads blank on the LEFT and populated on the right, which is the row predating the field, not the incumbent failing to emit.",
    },
    { field: "descriptor.query", left: pick(a, "descriptor.query"), right: pick(b, "descriptor.query") },
    {
      field: "social_narrative (count)",
      left: (a.social_narrative || []).length,
      right: (b.social_narrative || []).length,
    },
    {
      field: "cultural_drivers (count)",
      left: (a.cultural_drivers || []).length,
      right: (b.cultural_drivers || []).length,
    },
    { field: "evidence (count)", left: (a.evidence || []).length, right: (b.evidence || []).length },
    { field: "summary_long", left: a.summary_long, right: b.summary_long },
  ];
  return rows;
}

/**
 * The statement pair the CRMA-728 descriptor axis compares.
 * Declared here rather than in the runner because only this lane produces a
 * descriptor, and only this lane knows where it sits in the payload.
 */
export function descriptorStatements(incumbent, candidate) {
  return {
    incumbent: incumbent?.emission?.descriptor?.statement ?? null,
    candidate: candidate?.emission?.descriptor?.statement ?? null,
  };
}

export default {
  name,
  summary,
  incumbentModel,
  ticket,
  cases,
  build,
  compareRows,
  descriptorStatements,
};
