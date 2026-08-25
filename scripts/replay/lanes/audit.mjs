// Lane: the health-auditor agent loop (CRMA-736).
//
// This lane is the DELIBERATE CONTRAST to enrichment in the H8 measurement.
// propose_audit_report declares a shallow schema, so if undeclared fields
// are dropped anywhere it should bite here least and at enrichment most.
// Reading the two lanes together is the point.
//
// A REAL LIMIT, stated up front: the audit agent audits the pipeline as it
// is RIGHT NOW. Its prefetch SQL has no historical binding — every query is
// "the last 24 hours". So a ledger row from last week audited a different
// world, and diffing today's candidate against it would measure the world,
// not the model. This lane therefore runs BOTH models against today's
// prefetch, and the ledger row is shown only as background.

import { join } from "node:path";
import { query, variant } from "../lib/snowflake.mjs";
import { readWorkflow, runSteps } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "audit-agent-p_xMC9nm3";
const ENTRY = join(REPO_ROOT, WF_DIR, "run_audit_agent", "entry.js");
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");

export const name = "audit";
export const summary =
  "Daily health auditor. Shallow emit schema — the contrast case for the H8 field-dropping measurement.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-736";

/** Always pair this lane with --rerun-incumbent; see the header note. */
export const requiresRerun = true;

export async function cases({ limit = 1 }) {
  const rows = query(`
    SELECT AUDIT_ID, EVALUATED_AT, OVERALL_STATUS, ALERT_COUNT, REPORT, ALERTS,
           MODEL_USED, INPUT_TOKENS, OUTPUT_TOKENS, AGENT_COST_USD
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_AUDIT_LEDGER
     ORDER BY EVALUATED_AT DESC
     LIMIT ${Number(limit)}
  `);
  return rows.map((r) => ({
    id: r.AUDIT_ID,
    label: `audit ${String(r.EVALUATED_AT).slice(0, 16)} — ${r.OVERALL_STATUS} (${r.ALERT_COUNT} alerts)`,
    incumbentAt: String(r.EVALUATED_AT).slice(0, 10),
    incumbent: {
      // The ledger nests the per-section findings under REPORT, but
      // propose_audit_report declares them at the top level. Spread them so
      // both sides of a diff are keyed the way the schema declares them —
      // otherwise the rerun-failed fallback path compares a nested incumbent
      // against a flat candidate and every section reads as empty (CRMA-760).
      emission: {
        overall_status: r.OVERALL_STATUS,
        alerts: variant(r.ALERTS) || [],
        ...(variant(r.REPORT) || {}),
      },
      telemetry: {
        model: r.MODEL_USED,
        input_tokens: r.INPUT_TOKENS,
        output_tokens: r.OUTPUT_TOKENS,
        cost_estimate: r.AGENT_COST_USD,
      },
    },
  }));
}

export async function build(c) {
  const wf = readWorkflow(WORKFLOW);
  // No historical binding exists — these all read "now".
  const { rows, skipped } = runSteps(
    wf,
    [
      "q_pipeline_freshness",
      "q_dashboard_freshness",
      "q_stuck_trends",
      "q_orphan_trends",
      "q_cost_24h",
      "q_et_rescue",
    ],
    { lookback_hours: 24, "normalize_event.$return_value.lookback_hours": 24 },
  );

  const { ALL_TOOL_NAMES, TOOL_SCHEMAS, toFunctionDeclarations, dispatchTool, fmtJson } = await loadStep(ENTRY, [
    "ALL_TOOL_NAMES",
    "TOOL_SCHEMAS",
    "toFunctionDeclarations",
    "dispatchTool",
    "fmtJson",
  ]);

  // Bind the compare axes to the schema this run actually drives (CRMA-760).
  const derived = sectionKeysFrom(TOOL_SCHEMAS);
  if (derived.length) SECTIONS = derived;

  const freshnessRows = rows.q_pipeline_freshness;
  const pipeline_freshness = {
    ingestion: freshnessRows.filter((r) => r.AREA === "ingestion"),
    promotion: freshnessRows.filter((r) => r.AREA === "promotion"),
    enrichment: freshnessRows.filter((r) => r.AREA === "enrichment"),
    lifecycle: freshnessRows.filter((r) => r.AREA === "lifecycle"),
    distillation: freshnessRows.filter((r) => r.AREA === "distillation"),
  };
  const dashboard_freshness = rows.q_dashboard_freshness[0] || null;
  const stuck_trends = rows.q_stuck_trends;
  const orphan_trends_count = Number(rows.q_orphan_trends[0]?.ACTIVE_ORPHAN_TRENDS || 0);
  const cost_24h = rows.q_cost_24h;
  const etr = rows.q_et_rescue[0] || {};

  // The Pipedream error feed is a live HTTP call in production. The harness
  // does not reproduce it — an empty feed is passed and declared, so nobody
  // reads "no errors" as a finding.
  const pipedream_health = { summary: {}, workflows: [], harness_note: "not fetched by the replay harness" };

  const n = (v) => Number(v || 0);
  const etQueryCov =
    n(etr.CANDS_24H) > 0
      ? `${n(etr.CANDS_WITH_QUERY_24H)}/${n(etr.CANDS_24H)} (${Math.round((100 * n(etr.CANDS_WITH_QUERY_24H)) / n(etr.CANDS_24H))}%)`
      : "n/a (no candidates in 24h)";

  const etRescueBlock =
    `candidate_query_authoring_coverage: ${etQueryCov}\n` +
    `et_consulted (single-family rescue attempts, = new LLM spend): ${n(etr.ET_CONSULTED_24H)}\n` +
    `  -> et_rescued_and_promoted: ${n(etr.ET_RESCUED_24H)}\n` +
    `  -> et_consulted_but_rejected: ${n(etr.ET_CONSULTED_REJECTED_24H)}\n` +
    `et_ledger_rows_written: ${n(etr.ET_LEDGER_ROWS_24H)} (should EQUAL et_rescued_and_promoted)`;

  const loaded = loadPrompts(["audit.system", "audit.report_rubric"]);
  const sys = loaded["audit.system"];

  const system = render(sys.template, {
    report_rubric: loaded["audit.report_rubric"].template,
    pipeline_freshness_block: fmtJson(pipeline_freshness),
    dashboard_freshness_block: fmtJson(dashboard_freshness),
    stuck_trends_block: stuck_trends.length === 0 ? "(no stuck trends)" : fmtJson(stuck_trends.slice(0, 50)),
    orphan_trends_block: `active_orphan_trends: ${orphan_trends_count}`,
    et_rescue_block: etRescueBlock,
    cost_24h_block: fmtJson(cost_24h),
    pipedream_health_block: fmtJson(pipedream_health),
  });

  const userMessage =
    `Run the audit for chain_id=replay, trigger=replay_harness, lookback_hours=24. ` +
    `Decide each per-area status, compose alerts[], and emit propose_audit_report exactly once.`;

  const context = { pipeline_freshness, pipedream_health, stuck_trends, cost_24h, proposed_report: null };

  const p = sys.params || {};
  return {
    mode: "loop",
    system,
    userMessage,
    // The deployed step's own translation, so the declarations the candidate
    // sees are byte-for-byte the ones production sends.
    tools: [{ functionDeclarations: toFunctionDeclarations(ALL_TOOL_NAMES) }],
    toolNames: ALL_TOOL_NAMES,
    terminalTool: "propose_audit_report",
    terminalSchema: TOOL_SCHEMAS.propose_audit_report?.input_schema ?? null,
    dispatchTool,
    context,
    maxIterations: Number(p.max_iterations) || 6,
    budgetUsd: Number(p.budget_usd) || 0.5,
    perCallMaxTokens: Number(p.per_call_max_tokens) || 4096,
    thinkingLevel: p.thinking_level || "medium",
    promptProvenance: provenance(loaded),
    notes: {
      prefetch_is_now: "audit has no historical binding — compare both models today, not against the ledger row",
      skipped_steps: skipped,
      pipedream_errors: "not fetched",
      stuck_trends: stuck_trends.length,
      cost_rows: cost_24h.length,
    },
  };
}

/**
 * The per-section findings, read OUT OF the terminal tool schema rather than
 * listed here.
 *
 * The old `report` axis read a.report / b.report, which propose_audit_report
 * never declared — so it was blank on both sides and the sections that ARE the
 * audit report went uncompared (CRMA-760). Hardcoding the section names would
 * fix today and re-break the moment someone adds one: CRMA-722 adds
 * `data_hygiene` and CRMA-469 adds `governance`, both to this same schema.
 * Deriving them means a new section is compared the day it is declared.
 *
 * Every object-typed property is a section; the scalars are the verdict fields
 * (overall_status, cost_24h_usd, reasoning) and are compared explicitly.
 */
export function sectionKeysFrom(toolSchemas) {
  const props = toolSchemas?.propose_audit_report?.input_schema?.properties ?? {};
  return Object.entries(props)
    .filter(([, spec]) => spec?.type === "object")
    .map(([k]) => k);
}

/** Populated by build() from the deployed step; the fallback keeps compareRows pure-testable. */
let SECTIONS = [
  "ingestion",
  "distillation",
  "promotion",
  "enrichment",
  "lifecycle",
  "dashboard",
  "workflow_health",
];

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  const alerts = (x) => (Array.isArray(x) ? x : []).map((al) => al.title || al.summary || JSON.stringify(al));
  // A section is an object whose shape varies per section; show its status
  // verdict, which is the axis a human actually judges, and keep the rest
  // available as the serialized body underneath it.
  const sect = (o, k) => (o?.[k] == null ? undefined : (o[k].status ?? JSON.stringify(o[k])));

  return [
    { field: "overall_status", left: a.overall_status, right: b.overall_status, note: "ledger row is a DIFFERENT day" },
    { field: "alert count", left: alerts(a.alerts).length, right: alerts(b.alerts).length },
    { field: "alerts", left: alerts(a.alerts).join("\n"), right: alerts(b.alerts).join("\n") },
    ...SECTIONS.map((k) => ({ field: `${k}.status`, left: sect(a, k), right: sect(b, k) })),
    { field: "cost_24h_usd", left: a.cost_24h_usd, right: b.cost_24h_usd },
    { field: "reasoning", left: a.reasoning, right: b.reasoning },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
