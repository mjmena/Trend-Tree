// Lane: the lifecycle subagent loop (CRMA-734).
//
// The highest-volume LLM lane in the fleet — FCT_TREND_LIFECYCLE_LEDGER
// carries ~64k rows and roughly 4,200 evaluations a week — so a per-call
// cost change lands here harder than anywhere else, and a quality
// regression is hardest to spot by eye.
//
// This lane also has the fleet's only recorded tool trace: the ledger's
// TOOL_CALLS_JSON column. The replay shows the incumbent's real tool
// sequence beside the candidate's, which is the closest thing the fleet has
// to a behavioural diff rather than an output diff.
//
// heat_base is computed by the DEPLOYED computeHeatBase(), loaded from the
// step file. Re-deriving that formula here would have been the single most
// likely place for the harness to quietly disagree with production.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "lifecycle-subagent-p_gYC562o";
const ENTRY = join(REPO_ROOT, WF_DIR, "run_subagent", "entry.js");
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");

export const name = "lifecycle";
export const summary =
  "Hourly trend-status re-evaluation. Highest-volume LLM lane in the fleet and the only one with a recorded tool trace.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-734";

export async function cases({ limit = 3, caseId = null }) {
  const where = caseId ? `AND l.TREND_ID = ${sqlStr(caseId)}` : "";
  const rows = query(`
    SELECT l.LIFECYCLE_EVAL_ID, l.TREND_ID, l.EVALUATED_AT, l.PRIOR_STATUS, l.NEW_STATUS,
           l.PRIOR_HEAT, l.NEW_HEAT, l.HEAT_BASE, l.HEAT_MODIFIER_PCT, l.REASONING,
           l.DECISION_PAYLOAD, l.TOOL_CALLS_JSON, l.STOP_REASON, l.MODEL_USED,
           l.LLM_INPUT_TOKENS, l.LLM_OUTPUT_TOKENS, l.LLM_COST_ESTIMATE,
           t.TREND_TOPIC
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
      JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
     WHERE l.MODEL_USED = ${sqlStr(incumbentModel)}
       AND l.DECISION_PAYLOAD IS NOT NULL
       ${where}
     QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY l.EVALUATED_AT DESC) = 1
     ORDER BY l.EVALUATED_AT DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => ({
    id: r.TREND_ID,
    label: `${r.TREND_TOPIC ?? r.TREND_ID} · ${r.PRIOR_STATUS}→${r.NEW_STATUS} @ ${String(r.EVALUATED_AT).slice(0, 16)}`,
    incumbentAt: String(r.EVALUATED_AT).slice(0, 10),
    evaluatedAt: String(r.EVALUATED_AT),
    incumbent: {
      emission: variant(r.DECISION_PAYLOAD) || {},
      committed: {
        prior_status: r.PRIOR_STATUS,
        new_status: r.NEW_STATUS,
        prior_heat: r.PRIOR_HEAT,
        new_heat: r.NEW_HEAT,
        heat_base: r.HEAT_BASE,
        heat_modifier_pct: r.HEAT_MODIFIER_PCT,
        reasoning: r.REASONING,
      },
      tool_calls: variant(r.TOOL_CALLS_JSON) || [],
      telemetry: {
        model: r.MODEL_USED,
        stop_reason: r.STOP_REASON,
        input_tokens: r.LLM_INPUT_TOKENS,
        output_tokens: r.LLM_OUTPUT_TOKENS,
        cost_estimate: r.LLM_COST_ESTIMATE,
      },
    },
  }));
}

export async function build(c) {
  const wf = readWorkflow(WORKFLOW);
  const b = { trend_id: c.id };

  const metrics_rows = runStep(wf, "q_metrics", b);
  const signal_domain_rows = runStep(wf, "q_signal_domains", b);
  const lifecycle_history_rows = runStep(wf, "q_lifecycle_history", b);
  const recent_signal_rows = runStep(wf, "q_recent_signals", b);
  const candidate_signal_rows = runStep(wf, "q_candidate_signals", b);
  const gtrends_rows = runStep(wf, "q_gtrends_history", b);
  const neighbor_rows = runStep(wf, "q_neighbors", b);

  const metricsRow = metrics_rows[0];
  if (!metricsRow) throw new Error(`no FCT_TRENDS row for trend_id ${c.id}`);

  // ── the replayed evaluation must not be visible to the model ─────────
  // q_metrics' `lc` CTE and q_lifecycle_history both read the NEWEST ledger
  // rows with no time cut, and cases() picks each trend's LATEST evaluation.
  // Together those fed the candidate the incumbent's own answer — the status
  // it chose, the heat it wrote, its own timestamp, and its full reasoning
  // text as history entry #1 — and then asked it to decide. Every case was a
  // tautology, and the agreement it produced measured nothing.
  //
  // Same defect class as the promotion lane's self-neighbour (CRMA-733). The
  // cut is the replayed row's EVALUATED_AT: everything strictly before it is
  // what production actually fed the incumbent.
  const cutAt = c.evaluatedAt ? new Date(c.evaluatedAt).getTime() : null;
  const beforeCut = (ts) => cutAt === null || (ts && new Date(ts).getTime() < cutAt);

  const priorLedger = cutAt === null
    ? []
    : query(`
        SELECT NEW_HEAT_SMOOTHED, EVALUATED_AT
          FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
         WHERE TREND_ID = ${sqlStr(c.id)}
           AND EVALUATED_AT < ${sqlStr(c.evaluatedAt)}
         ORDER BY EVALUATED_AT DESC
         LIMIT 1
      `);

  const { ALL_TOOL_NAMES, toFunctionDeclarations, getToolSchemas, dispatchTool, computeHeatBase, fmtJson, parseVariant } =
    await loadStep(ENTRY, [
      "ALL_TOOL_NAMES",
      "toFunctionDeclarations",
      "getToolSchemas",
      "dispatchTool",
      "computeHeatBase",
      "fmtJson",
      "parseVariant",
    ]);

  // ── normalisation, mirroring entry.js:496-609 ────────────────────────
  const metrics = {
    trend_id: metricsRow.TREND_ID,
    trend_topic: metricsRow.TREND_TOPIC,
    // PRIOR_STATUS/PRIOR_HEAT on the replayed row are exactly the state
    // production handed the incumbent — use them, not today's post-decision row.
    lifecycle_status: c.incumbent?.committed?.prior_status ?? metricsRow.LIFECYCLE_STATUS,
    total_cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
    distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
    confidence: metricsRow.CONFIDENCE,
    specificity_score: metricsRow.SPECIFICITY_SCORE,
    trend_heat_index: c.incumbent?.committed?.prior_heat ?? metricsRow.TREND_HEAT_INDEX,
    trend_heat_index_smoothed:
      cutAt === null ? metricsRow.TREND_HEAT_INDEX_SMOOTHED : (priorLedger[0]?.NEW_HEAT_SMOOTHED ?? null),
    promoted_at: metricsRow.PROMOTED_AT,
    last_update_at: metricsRow.LAST_UPDATE_AT,
    last_lifecycle_eval_at:
      cutAt === null ? metricsRow.LAST_LIFECYCLE_EVAL_AT : (priorLedger[0]?.EVALUATED_AT ?? null),
    trend_name_b2b: metricsRow.TREND_NAME_B2B,
    trend_name_b2c: metricsRow.TREND_NAME_B2C,
    category: metricsRow.CATEGORY,
    subcategory: metricsRow.SUBCATEGORY,
    summary_short: metricsRow.SUMMARY_SHORT,
    summary_long: metricsRow.SUMMARY_LONG,
    vibe_shift: metricsRow.VIBE_SHIFT,
    enriched_at: metricsRow.ENRICHED_AT,
    enrichment_version: metricsRow.ENRICHMENT_VERSION,
  };

  const signal_domain_counts = Object.fromEntries(
    signal_domain_rows
      .filter((r) => r.DOMAIN && Number(r.SIGNAL_COUNT) > 0)
      .map((r) => [r.DOMAIN, Number(r.SIGNAL_COUNT)]),
  );

  const lifecycle_history = lifecycle_history_rows
    .filter((r) => beforeCut(r.EVALUATED_AT))
    .map((r) => ({
    evaluated_at: r.EVALUATED_AT,
    prior_status: r.PRIOR_STATUS,
    new_status: r.NEW_STATUS,
    prior_heat: r.PRIOR_HEAT,
    new_heat: r.NEW_HEAT,
    heat_base: r.HEAT_BASE,
    heat_modifier_pct: r.HEAT_MODIFIER_PCT,
    reasoning: r.REASONING,
    retirement_proposal: parseVariant(r.RETIREMENT_PROPOSAL),
    requested_re_enrichment: r.REQUESTED_RE_ENRICHMENT,
  }));

  const recent_signals = recent_signal_rows.map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
  }));

  const candidate_signals = candidate_signal_rows.map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  const gtrends_history = gtrends_rows.map((r) => ({
    pulled_at: r.PULLED_AT,
    interest_peak_pct: r.INTEREST_PEAK_PCT,
    interest_avg_pct: r.INTEREST_AVG_PCT,
    related_queries: parseVariant(r.RELATED_QUERIES),
  }));

  const neighbor_pool = neighbor_rows.map((r) => ({
    trend_id: r.TREND_ID,
    trend_topic: r.TREND_TOPIC,
    lifecycle_status: r.LIFECYCLE_STATUS,
    heat: r.HEAT,
    last_update_at: r.LAST_UPDATE_AT,
    trend_name_b2c: r.TREND_NAME_B2C,
    category: r.CATEGORY,
    subcategory: r.SUBCATEGORY,
    summary_short: r.SUMMARY_SHORT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  const { heat_base, components } = computeHeatBase({ metrics, signal_domain_counts, recent_signals });

  const _now = Date.now();
  const _7d = 7 * 24 * 3600 * 1000;
  const _24h = 24 * 3600 * 1000;
  const linkedTs = recent_signals
    .map((s) => (s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0))
    .filter((ts) => ts > 0);
  const last7dCount = linkedTs.filter((ts) => _now - ts <= _7d).length;
  const priorWeekCount = linkedTs.filter((ts) => _now - ts > _7d).length;
  const last24hCount = linkedTs.filter((ts) => _now - ts <= _24h).length;
  const newestLinkedTs = linkedTs.length ? Math.max(...linkedTs) : null;
  const daysSilent = newestLinkedTs !== null ? ((_now - newestLinkedTs) / (24 * 3600 * 1000)).toFixed(1) : null;
  const activeDomains = Object.values(signal_domain_counts).filter((v) => v > 0).length;
  const priorHeatBase =
    lifecycle_history.length && lifecycle_history[0].heat_base != null ? Number(lifecycle_history[0].heat_base) : null;
  const heatDelta = priorHeatBase !== null ? (heat_base - priorHeatBase).toFixed(1) : null;
  const heatTrajectory = lifecycle_history.length
    ? lifecycle_history.slice(0, 5).map((h) => `${h.evaluated_at}: ${h.new_heat}`).join(" → ")
    : null;

  const context = {
    neighbor_pool,
    recent_signals,
    lifecycle_history,
    proposed_decision: null,
    agent_session_id: `replay_${Date.now()}`,
    chain_id: null,
  };

  const trend_state_block = `TREND_ID: ${metrics.trend_id}
TREND_TOPIC: ${metrics.trend_topic}
TREND_NAME_B2B / B2C: ${metrics.trend_name_b2b || "(unenriched)"} / ${metrics.trend_name_b2c || "(unenriched)"}
CATEGORY: ${metrics.category || "?"} / ${metrics.subcategory || "?"}
CURRENT LIFECYCLE_STATUS: ${metrics.lifecycle_status}
CURRENT HEAT (smoothed): ${metrics.trend_heat_index_smoothed ?? metrics.trend_heat_index}
CURRENT HEAT (raw): ${metrics.trend_heat_index}
PROMOTED_AT: ${metrics.promoted_at}
LAST_UPDATE_AT: ${metrics.last_update_at}
LAST_LIFECYCLE_EVAL_AT: ${metrics.last_lifecycle_eval_at || "(never)"}`;

  const metrics_block = `Cluster size: ${metrics.total_cluster_size}
Distinct source count: ${metrics.distinct_source_count}
Confidence: ${metrics.confidence}
Specificity score: ${metrics.specificity_score}`;

  const lifecycle_history_block = lifecycle_history.length
    ? lifecycle_history
        .map(
          (h, i) =>
            `${i + 1}. ${h.evaluated_at} — ${h.prior_status} → ${h.new_status} | heat ${h.prior_heat} → ${h.new_heat} ` +
            `${h.retirement_proposal ? "[RETIREMENT_PROPOSED] " : ""}` +
            `reason: ${(h.reasoning || "").slice(0, 200)}`,
        )
        .join("\n")
    : "(no prior lifecycle evaluations)";

  const recent_signals_block = recent_signals.length
    ? recent_signals
        .slice(0, 20)
        .map((s, i) => `${i + 1}. [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`)
        .join("\n")
    : "(no signals in last 14d)";

  const gtrends_block = gtrends_history.length
    ? gtrends_history
        .slice(0, 10)
        .map((g) => `${g.pulled_at}: peak=${g.interest_peak_pct}, avg=${g.interest_avg_pct}`)
        .join("\n")
    : "(no GTrends data yet — gtrends-poller may not have run for this trend)";

  const neighbor_block = neighbor_pool.length
    ? neighbor_pool
        .slice(0, 10)
        .map(
          (n, i) =>
            `${i + 1}. sim=${n.similarity.toFixed(2)} | ${n.lifecycle_status} | "${n.trend_name_b2c || n.trend_topic}" (heat ${n.heat})`,
        )
        .join("\n")
    : "(no neighbors in pool)";

  const candidate_signals_block = candidate_signals.length
    ? candidate_signals
        .map(
          (s, i) =>
            `${i + 1}. sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`,
        )
        .join("\n")
    : "(no vector-similar signals in last 7d)";

  const heat_baseline_block = `heat_base = ${heat_base}
components: ${fmtJson(components)}
formula: 25*recency + 25*velocity + 40*breadth + 10*confidence  (LINKED evidence only)
heat_base_delta (vs prior eval's heat_base): ${heatDelta !== null ? heatDelta : "(first eval)"}
heat_trajectory (committed heat, recent evals, newest first): ${heatTrajectory || "(first eval)"}
LINKED signals last 7d: ${last7dCount}  |  prior week (7-14d ago): ${priorWeekCount}
LINKED signals last 24h: ${last24hCount}
days since newest linked signal: ${daysSilent !== null ? daysSilent : "(none in 14d window)"}
active publisher domains (last 21d): ${activeDomains}
Status heat factor is FIXED and applied at commit: GROWING/RESURGENT +10%, STABLE/NEW 0%, DECLINING -10%, DORMANT -15%.`;

  const loaded = loadPrompts(["lifecycle.subagent.system", "lifecycle.subagent.decision_rubric"]);
  const sys = loaded["lifecycle.subagent.system"];

  const system = render(sys.template, {
    decision_rubric: loaded["lifecycle.subagent.decision_rubric"].template,
    trend_state_block,
    metrics_block,
    lifecycle_history_block,
    recent_signals_block,
    candidate_signals_block,
    gtrends_block,
    neighbor_block,
    heat_baseline_block,
  });

  const userMessage =
    `Evaluate trend ${c.id}. Current status is ${metrics.lifecycle_status}. ` +
    `Use the prefetched context to decide the new status, heat modifier, and any description update. ` +
    `Call propose_lifecycle_decision exactly once with your final answer.`;

  const p = sys.params || {};
  return {
    mode: "loop",
    system,
    userMessage,
    tools: [{ functionDeclarations: toFunctionDeclarations(ALL_TOOL_NAMES) }],
    toolNames: ALL_TOOL_NAMES,
    terminalTool: "propose_lifecycle_decision",
    terminalSchema: getToolSchemas(["propose_lifecycle_decision"])[0]?.input_schema ?? null,
    dispatchTool,
    context,
    maxIterations: Number(p.max_iterations) || 8,
    budgetUsd: Number(p.budget_usd) || 0.06,
    perCallMaxTokens: Number(p.per_call_max_tokens) || 3072,
    thinkingLevel: p.thinking_level || "medium",
    promptProvenance: provenance(loaded),
    notes: {
      heat_base,
      recent_signals: recent_signals.length,
      candidate_signals: candidate_signals.length,
      neighbors: neighbor_pool.length,
      replayed_eval_at: c.evaluatedAt ?? null,
      prior_state_restored: `status=${metrics.lifecycle_status} heat=${metrics.trend_heat_index}`,
      history_entries_after_cut_dropped: lifecycle_history_rows.length - lifecycle_history.length,
      answer_leak_cut:
        "the replayed evaluation and everything after it are hidden: status, heat and history come from BEFORE it, so the model is not shown the incumbent's own answer",
      recomputed_now:
        "heat_base and the signal windows are recomputed against TODAY, so they differ from the incumbent's evaluation",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  const seq = (calls) => (Array.isArray(calls) ? calls.map((t) => t.name || t.tool || "?").join(" → ") : "—");
  // Field names must match propose_lifecycle_decision's ACTUAL schema
  // (run_subagent/entry.js): status, retirement_reason, next_eval_in_hours,
  // request_re_enrichment, re_enrichment_reason, reasoning. Four axes here
  // previously read ledger column names instead — new_status,
  // requested_re_enrichment, retirement_proposal — so the candidate column
  // rendered "—" on every case while the incumbent column fell back to
  // `committed` and populated. The diff looked like the candidate had
  // emitted nothing when it had emitted a full, valid decision.
  //
  // heat_modifier_pct is deliberately NOT compared: ADR-0005 removed it from
  // the schema, and PROC_LIFECYCLE_APPLY now derives the factor from status.
  // It is not the model's to pick, so a diff on it only restates the status.
  return [
    { field: "status", left: a.status ?? incumbent?.committed?.new_status, right: b.status },
    { field: "next_eval_in_hours", left: a.next_eval_in_hours, right: b.next_eval_in_hours },
    { field: "request_re_enrichment", left: a.request_re_enrichment, right: b.request_re_enrichment },
    { field: "retirement_reason", left: a.retirement_reason, right: b.retirement_reason },
    {
      field: "tool sequence",
      left: seq(incumbent?.tool_calls),
      right: seq(candidate?.tool_calls),
      note: "from TOOL_CALLS_JSON — the fleet's only recorded trace",
    },
    { field: "reasoning", left: a.reasoning ?? incumbent?.committed?.reasoning, right: b.reasoning },
  ];
}

export default { name, summary, incumbentModel, ticket, cases, build, compareRows };
