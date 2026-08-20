// Lane: the promotion gate subagent (CRMA-733).
//
// The highest-stakes lane in the fleet: its verdict decides whether a
// candidate becomes a trend at all, and a wrong PROMOTE_NEW is expensive to
// undo downstream. It also has the tightest budget of any loop
// (budget_usd 0.15, max_iterations 6), which makes it the lane where the
// CRMA-726 budget-gate trap bites first — a model swap without the matching
// RATES_PER_M correction trips the gate ~3x early and promotion then
// SILENTLY defaults to DEFER.
//
// The subagent takes its whole input from the lead's HTTP dispatch body, so
// this adapter rebuilds that body using the lead's OWN functions —
// qualityFlags, indexCombinedRows, buildDispatch — and the receiving step's
// own formatters. Only the candidate SELECT is the harness's own, because
// the lead's q_load_pending_candidates filters on PENDING and a historical
// candidate has long since left that state. That one substitution is
// declared in `notes.reconstructed`.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { readWorkflow, runStep, stepSql } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const LEAD_DIR = "promotion-p_xMC99jg";
const SUB_DIR = "promotion-agent-p_yKCmm9r";
const LEAD_ENTRY = join(REPO_ROOT, LEAD_DIR, "run_lead_agent", "entry.js");
const LEAD_WORKFLOW = join(REPO_ROOT, LEAD_DIR, "workflow.yaml");
const SUB_ENTRY = join(REPO_ROOT, SUB_DIR, "run_subagent", "entry.js");
const HANDLE_ENTRY = join(REPO_ROOT, SUB_DIR, "handle_request", "entry.js");

export const name = "promotion";
export const summary =
  "Per-candidate promote/reject/dedupe gate. Tightest budget in the fleet — where the budget-gate trap bites first.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-733";

export async function cases({ limit = 3, caseId = null }) {
  const where = caseId ? `AND p.CANDIDATE_ID = ${sqlStr(caseId)}` : "";
  const rows = query(`
    SELECT p.CANDIDATE_ID, p.DECIDED_AT, p.DECISION, p.DECISION_CATEGORY, p.CONFIDENCE,
           p.RATIONALE, p.MAX_NEIGHBOR_SIM, p.CONSIDERED_NEIGHBORS, p.DISTILLATION_VERDICT,
           p.OVERRODE_VERDICT, p.CLUSTER_SIZE, p.SOURCE_COUNT, p.MODEL_USED,
           p.INPUT_TOKENS, p.OUTPUT_TOKENS, p.COST_ESTIMATE,
           c.TOPIC AS CANDIDATE_TOPIC
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER p
      JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c USING (CANDIDATE_ID)
     WHERE p.MODEL_USED = ${sqlStr(incumbentModel)}
       ${where}
     QUALIFY ROW_NUMBER() OVER (PARTITION BY p.CANDIDATE_ID ORDER BY p.DECIDED_AT DESC) = 1
     ORDER BY p.DECIDED_AT DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => ({
    id: r.CANDIDATE_ID,
    label: `${r.CANDIDATE_TOPIC ?? r.CANDIDATE_ID} · ${r.DECISION} @ ${String(r.DECIDED_AT).slice(0, 16)}`,
    incumbentAt: String(r.DECIDED_AT).slice(0, 10),
    incumbent: {
      emission: {
        decision: r.DECISION,
        decision_category: r.DECISION_CATEGORY,
        confidence: r.CONFIDENCE,
        rationale: r.RATIONALE,
        max_neighbor_sim: r.MAX_NEIGHBOR_SIM,
        considered_neighbors: variant(r.CONSIDERED_NEIGHBORS) || [],
      },
      context: {
        distillation_verdict: r.DISTILLATION_VERDICT,
        overrode_verdict: r.OVERRODE_VERDICT,
        cluster_size: r.CLUSTER_SIZE,
        source_count: r.SOURCE_COUNT,
      },
      telemetry: {
        model: r.MODEL_USED,
        input_tokens: r.INPUT_TOKENS,
        output_tokens: r.OUTPUT_TOKENS,
        cost_estimate: r.COST_ESTIMATE,
      },
    },
  }));
}

const CANDIDATES_TABLE = "MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES";

/** Keep the lead's SELECT list, replace everything from WHERE onward. */
function retargetCandidateQuery(sql, candidateId) {
  const from = sql.indexOf(CANDIDATES_TABLE);
  if (from === -1) {
    throw new Error(
      `q_load_pending_candidates no longer selects from ${CANDIDATES_TABLE}; update the promotion lane adapter.`,
    );
  }
  const head = sql.slice(0, from + CANDIDATES_TABLE.length);
  return `${head}\nWHERE CANDIDATE_ID = ${sqlStr(candidateId)}\nLIMIT 1`;
}

export async function build(c) {
  const wf = readWorkflow(LEAD_WORKFLOW);

  // The lead's own SQL, re-bound to this historical candidate.
  // extract_candidate_ids emits a bare array of id strings (entry.js:39).
  const combinedRows = runStep(wf, "q_compute_vectors_and_neighbors", {
    "steps.extract_candidate_ids.$return_value.selected_ids_json": JSON.stringify([c.id]),
  });

  const neighborIds = [...new Set(combinedRows.map((r) => r.NEIGHBOR_TREND_ID).filter(Boolean))];
  const sampleRows = neighborIds.length
    ? runStep(wf, "q_load_neighbor_signal_samples", {
        "steps.serialize_neighbor_pool.$return_value.neighbor_pool_json": JSON.stringify(
          neighborIds.map((id) => ({ NEIGHBOR_TREND_ID: id })),
        ),
      })
    : [];

  // The lead's own projection, with only its WHERE swapped: it filters on
  // PENDING, and a historical candidate has long since left that state.
  // Reusing the SELECT verbatim keeps the column aliases (TOPIC AS
  // CANDIDATE_TOPIC, ARRAY_SIZE(...) AS CLUSTER_SIZE, …) in sync with
  // production instead of copying them into this file to rot.
  const candRows = query(retargetCandidateQuery(stepSql(wf, "q_load_pending_candidates"), c.id));
  const candidateRow = candRows[0];
  if (!candidateRow) throw new Error(`no STG_TREND_CANDIDATES row for ${c.id}`);
  candidateRow.SOURCE_BREAKDOWN = variant(candidateRow.SOURCE_BREAKDOWN) || {};

  const { qualityFlags, indexCombinedRows, buildDispatch } = await loadStep(LEAD_ENTRY, [
    "qualityFlags",
    "indexCombinedRows",
    "buildDispatch",
  ]);
  const { fmtCandidateBlock, fmtDistillationBlock, fmtNeighborBlock } = await loadStep(HANDLE_ENTRY, [
    "fmtCandidateBlock",
    "fmtDistillationBlock",
    "fmtNeighborBlock",
  ]);
  const { TOOL_NAMES, toFunctionDeclarations, getToolSchemas, dispatchTool } = await loadStep(SUB_ENTRY, [
    "TOOL_NAMES",
    "toFunctionDeclarations",
    "getToolSchemas",
    "dispatchTool",
  ]);

  const { vectorsByCandidate, neighborsByCandidate } = indexCombinedRows(combinedRows, sampleRows);
  const flags = qualityFlags(candidateRow);
  const dispatch = buildDispatch(
    candidateRow,
    vectorsByCandidate.get(c.id) ?? null,
    neighborsByCandidate.get(c.id) ?? [],
    flags,
    { chain_id: "replay", iteration: 1, dry_run: false, et_rescue: false },
  );

  // The receiving step's transform (handle_request entry.js:107-155).
  const valid_neighbors = (dispatch.neighbor_pool || []).slice(0, 8).filter((n) => n && n.trend_id);
  const candidate = {
    candidate_id: dispatch.candidate_id,
    candidate_topic: dispatch.candidate_topic,
    candidate_query: dispatch.candidate_query,
    et_rescue: dispatch.et_rescue,
    distillation_verdict: dispatch.distillation_verdict,
    distillation_dedup_target: dispatch.distillation_dedup_target,
    distillation_reasoning: String(dispatch.distillation_reasoning || ""),
    cluster_size: Number(dispatch.cluster_size || 0),
    source_count: Number(dispatch.source_count || 0),
    confidence: Number(dispatch.confidence || 0),
    specificity_score: Number(dispatch.specificity_score || 0),
    bucket: dispatch.bucket || null,
    source_breakdown: dispatch.source_breakdown || {},
    quality_flags: Array.isArray(dispatch.quality_flags) ? dispatch.quality_flags : [],
    candidate_vector: dispatch.candidate_vector,
  };

  const system_vars = {
    candidate_block: fmtCandidateBlock(candidate),
    distillation_recommendation_block: fmtDistillationBlock(candidate),
    neighbor_count: valid_neighbors.length,
    neighbor_blocks:
      valid_neighbors.map((n, i) => fmtNeighborBlock(n, i)).join("\n\n") ||
      "(no surfaced neighbors above sim 0.50)",
    et_rescue_block: "",
  };

  const loaded = loadPrompts(["promotion.subagent.system", "promotion.subagent.decision_rubric"]);
  const sys = loaded["promotion.subagent.system"];
  const system = render(sys.template, {
    ...system_vars,
    decision_rubric: loaded["promotion.subagent.decision_rubric"].template,
  });

  const userMessage = `You are evaluating one candidate trend (id: ${candidate.candidate_id}). Distillation already made a recommendation; verify or override using the surfaced neighbors.

Workflow:
1. Read the candidate, distillation's recommendation, and the neighbor pool above (in your system prompt).
2. For neighbors you suspect might be the same topic, call \`compare_topics\` to record your pairwise judgment.
3. Once you have enough evidence, call \`propose_decision\` with the final decision. This terminates the loop.

Be efficient — typical case is one or two compare_topics calls then propose_decision.`;

  const p = sys.params || {};
  return {
    mode: "loop",
    system,
    userMessage,
    tools: [{ functionDeclarations: toFunctionDeclarations(TOOL_NAMES) }],
    toolNames: TOOL_NAMES,
    terminalTool: "propose_decision",
    terminalSchema: getToolSchemas(["propose_decision"])[0]?.input_schema ?? null,
    dispatchTool,
    context: {
      neighbor_pool: valid_neighbors,
      considered: [],
      decision: null,
      et_api_key: process.env.EXPLODING_TOPICS_API_KEY || null,
      et_verifications: [],
    },
    maxIterations: Number(p.max_iterations) || 6,
    budgetUsd: Number(p.budget_usd) || 0.15,
    perCallMaxTokens: Number(p.per_call_max_tokens) || 3072,
    thinkingLevel: p.thinking_level || "medium",
    promptProvenance: provenance(loaded),
    notes: {
      neighbors: valid_neighbors.length,
      quality_flags: flags,
      budget_usd: Number(p.budget_usd) || 0.15,
      budget_gate_warning:
        "This lane's budget is measured on the TRUTHFUL cost. Production measures it on the understated one, so a real switch must correct RATES_PER_M in the same slice.",
      reconstructed: "candidate row (q_load_pending_candidates filters on PENDING; a historical candidate is not)",
      et_rescue: "forced false — ET rescue routing is a lead-side classification the harness does not replay",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  const names = (x) => (Array.isArray(x) ? x : []).map((n) => n.trend_id || n.topic || JSON.stringify(n)).join("\n");
  return [
    {
      field: "decision",
      left: a.decision,
      right: b.decision,
      note: `distillation said ${incumbent?.context?.distillation_verdict ?? "?"}`,
    },
    { field: "decision_category", left: a.decision_category, right: b.decision_category },
    { field: "confidence", left: a.confidence, right: b.confidence },
    { field: "max_neighbor_sim", left: a.max_neighbor_sim, right: b.max_neighbor_sim },
    { field: "considered_neighbors", left: names(a.considered_neighbors), right: names(b.considered_neighbors) },
    { field: "rationale", left: a.rationale, right: b.rationale },
  ];
}

export default { name, summary, incumbentModel, ticket, cases, build, compareRows };
