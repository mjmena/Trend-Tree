// Lane: the shared distillation cluster agent (CRMA-732).
//
// The most leveraged lane in the pipeline: it decides what counts as a trend
// at all. Everything downstream — promotion, enrichment, lifecycle — only
// ever sees candidates this agent proposed, so a specificity regression here
// is invisible in every other lane's diff and silently starves the pipeline.
//
// TWO FINDINGS THIS ADAPTER DEPENDS ON, both worth carrying into CRMA-732:
//
//   1. `distillation-p_mkCBBqb/run_lead_agent/entry.js` is DEAD CODE. Its
//      pin at line 577 is not deployed — the workflow has no run_lead_agent
//      namespace; the lead now clusters in SQL and dispatches here. The
//      map's "distillation lead" pin should not be counted as live.
//   2. This one workflow serves BOTH distillation and distillation-revisit,
//      so a decision here moves two callers at once.
//
// RECONSTRUCTION, declared: production feeds this agent a Louvain cluster
// hint from PROC_CLUSTER_SIGNAL_SUBSET over a ~1600-signal pool. That hint
// is not persisted. The replay instead takes one historical candidate's
// SUPPORTING_SIGNAL_IDS as the pool and presents them as a single community
// — which is the grouping the incumbent actually settled on. So this lane
// asks "given these signals, what does the candidate model propose?", NOT
// "would it have found this cluster in the firehose?". The second question
// needs a live pool and is out of this harness's reach.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { embeddedSql, bindQuestionMarks } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "distillation-cluster-agent-p_YyC89Ke";
const ENTRY = join(REPO_ROOT, WF_DIR, "run_lead_agent", "entry.js");
const SIGNALS_STEP = join(REPO_ROOT, WF_DIR, "q_fetch_signals", "entry.js");
const NEIGHBORS_STEP = join(REPO_ROOT, WF_DIR, "q_fetch_neighbors", "entry.js");

export const name = "distillation";
export const summary =
  "Shared cluster reasoner behind both distillation and distillation-revisit. Decides what counts as a trend at all.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-732";

export async function cases({ limit = 3, caseId = null }) {
  const where = caseId ? `AND CANDIDATE_ID = ${sqlStr(caseId)}` : "";
  const rows = query(`
    SELECT CANDIDATE_ID, TOPIC, QUERY, VERDICT, CONFIDENCE, SPECIFICITY_SCORE,
           REASONING, SUPPORTING_SIGNAL_IDS, SOURCE_BREAKDOWN, CREATED_AT,
           ARRAY_SIZE(SUPPORTING_SIGNAL_IDS) AS CLUSTER_SIZE
      FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
     WHERE VERDICT IS NOT NULL
       AND ARRAY_SIZE(SUPPORTING_SIGNAL_IDS) BETWEEN 3 AND 40
       ${where}
     ORDER BY CREATED_AT DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => ({
    id: r.CANDIDATE_ID,
    label: `${r.TOPIC} · ${r.VERDICT} · ${r.CLUSTER_SIZE} signals @ ${String(r.CREATED_AT).slice(0, 16)}`,
    incumbentAt: String(r.CREATED_AT).slice(0, 10),
    signalIds: variant(r.SUPPORTING_SIGNAL_IDS) || [],
    incumbent: {
      emission: {
        candidates: [
          {
            topic: r.TOPIC,
            query: r.QUERY,
            verdict: r.VERDICT,
            confidence: r.CONFIDENCE,
            specificity_score: r.SPECIFICITY_SCORE,
            reasoning: r.REASONING,
          },
        ],
      },
      telemetry: { model: incumbentModel, cluster_size: r.CLUSTER_SIZE },
    },
  }));
}

export async function build(c) {
  const ids = c.signalIds || [];
  if (!ids.length) throw new Error(`candidate ${c.id} has no SUPPORTING_SIGNAL_IDS`);

  // Production's own queries, lifted out of the custom-code steps.
  const signalRows = query(bindQuestionMarks(embeddedSql(SIGNALS_STEP), [JSON.stringify(ids)]));
  const neighborRows = query(embeddedSql(NEIGHBORS_STEP));

  const {
    LEAD_TOOL_NAMES,
    toFunctionDeclarations,
    getToolSchemas,
    dispatchTool,
    buildClusterSummary,
    hostnameOf,
  } = await loadStep(ENTRY, [
    "LEAD_TOOL_NAMES",
    "toFunctionDeclarations",
    "getToolSchemas",
    "dispatchTool",
    "buildClusterSummary",
    "hostnameOf",
  ]);

  // One community — see the reconstruction note in the header.
  const cluster_assignments = ids.map((id) => ({ signal_id: id, cluster_id: 0, similarity: null }));
  const cluster_lookup = new Map(cluster_assignments.map((x) => [x.signal_id, x]));

  const signal_pool = signalRows.map((r) => {
    const cl = cluster_lookup.get(r.SIGNAL_ID);
    return {
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      title: r.SIGNAL_TITLE,
      body: r.SIGNAL_TEXT,
      detected_at: r.SIGNAL_TIMESTAMP,
      domain: r.MD_DOMAIN || hostnameOf(r.MD_URL),
      url: r.MD_URL || null,
      cluster_id: cl ? cl.cluster_id : null,
    };
  });

  const infoById = new Map(signal_pool.map((s) => [s.signal_id, s]));
  const cluster_summary = buildClusterSummary(cluster_assignments, infoById);

  const trend_neighbor_pool = neighborRows.map((r) => ({
    trend_id: r.TREND_ID,
    trend_topic: r.TREND_NAME,
    total_cluster_size: r.TOTAL_CLUSTER_SIZE,
    distinct_source_count: r.DISTINCT_SOURCE_COUNT,
    velocity_direction: r.VELOCITY_DIRECTION,
    trend_heat_index: r.HEAT_INDEX,
    last_update_at: r.LAST_LIFECYCLE_EVAL_AT,
  }));

  const context = {
    signal_pool,
    trend_neighbor_pool,
    proposed_candidates: [],
    agent_session_id: `replay_${Date.now()}`,
    chain_id: null,
    iteration: 0,
    // dispatch_subagent is deliberately left UNCONFIGURED. Pointing it at
    // the live subagent would fan out real work and write real candidates;
    // the deployed prompt already tells the agent to expect that, and the
    // tool returns a clear error instead of silently doing nothing.
    endpoints: {},
  };

  const clusterBlock =
    cluster_summary.length > 0
      ? `Pre-clustered into ${cluster_summary.length} Louvain communities (soft hint — feel free to merge across communities or split within):\n` +
        cluster_summary
          .map(
            (cs) =>
              `  community ${cs.cluster_id}: ${cs.size} signals, sources [${cs.source_breakdown}], e.g. ${cs.sample_titles
                .map((t) => JSON.stringify(t))
                .join(" / ")}`,
          )
          .join("\n") +
        "\n\n"
      : "";

  const userMessage =
    clusterBlock +
    `Pre-fetched pools available to your tools:
  - signal_pool: ${signal_pool.length} signals from STG_EXTERNAL_SIGNALS
  - trend_neighbor_pool: ${trend_neighbor_pool.length} active trends (last 30d) for dedup

Subagent endpoint: NOT CONFIGURED — dispatch_subagent will return errors

Begin your scan. Be opinionated about specificity.`;

  const loaded = loadPrompts(["distillation.lead.system"]);
  const p = loaded["distillation.lead.system"];

  // The deployed step renders few-shot examples from q_load_examples. The
  // replay passes none, and says so, rather than inventing a different set.
  const system = render(p.template, { valuable_examples: "(no examples available)" });

  return {
    mode: "loop",
    system,
    userMessage,
    tools: [{ functionDeclarations: toFunctionDeclarations(LEAD_TOOL_NAMES) }],
    toolNames: LEAD_TOOL_NAMES,
    terminalTool: "propose_trend_candidate",
    terminalSchema: getToolSchemas(["propose_trend_candidate"])[0]?.input_schema ?? null,
    dispatchTool,
    context,
    maxIterations: p.params.max_iterations ?? 15,
    budgetUsd: p.params.budget_usd ?? 5.0,
    perCallMaxTokens: p.params.per_call_max_tokens ?? 8192,
    thinkingLevel: p.params.thinking_level ?? "medium",
    promptProvenance: provenance(loaded),
    notes: {
      signals_in_pool: signal_pool.length,
      neighbors: trend_neighbor_pool.length,
      cluster_hint: "single synthetic community — the real Louvain hint is not persisted",
      few_shot_examples: "none passed (production renders these from q_load_examples)",
      subagent: "unconfigured on purpose — replay must not fan out real work",
      dead_code_note: "distillation-p_mkCBBqb/run_lead_agent is NOT deployed; its pin is not live",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission?.candidates ?? [];
  const b = candidate?.emission ? [candidate.emission] : [];
  const one = (x, k) => (x[0] ? x[0][k] : undefined);
  const list = (x) => x.map((t, i) => `${i + 1}. ${t.topic ?? t.candidate_topic}`).join("\n") || "—";

  return [
    {
      field: "candidates proposed",
      left: a.length,
      right: b.length,
      note: "the incumbent's row is ONE candidate; the agent may propose several from the same pool",
    },
    { field: "topic", left: one(a, "topic"), right: one(b, "topic") ?? one(b, "candidate_topic") },
    { field: "verdict", left: one(a, "verdict"), right: one(b, "verdict") },
    { field: "specificity_score", left: one(a, "specificity_score"), right: one(b, "specificity_score") },
    { field: "confidence", left: one(a, "confidence"), right: one(b, "confidence") },
    { field: "all proposed topics", left: list(a), right: list(b) },
    { field: "reasoning", left: one(a, "reasoning"), right: one(b, "reasoning") },
  ];
}

export default { name, summary, incumbentModel, ticket, cases, build, compareRows };
