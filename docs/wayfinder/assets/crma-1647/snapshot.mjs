// CRMA-1647 step 2: freeze the lifecycle subagent's input for every sampled
// trend, once, so Pro run A, Pro run B and the candidate all see the same
// snapshot (CRMA-1646's standing constraint).
//
// The SQL is the workflow's own: lib/workflow.mjs reads the six per-trend
// snowflake steps out of lifecycle-subagent-p_gYC562o/workflow.yaml. heat_base
// comes from the deployed computeHeatBase(). The prompt assembly below is a
// line-for-line copy of run_subagent/entry.js:496-690, because it lives inside
// run() and cannot be imported. If that block changes, re-copy it.
//
// Each line of out/snapshot.jsonl holds the raw rows, the rendered system
// prompt, the user message, and the tool context. snapshot_at is the "now"
// the run step pins Date.now() to, so the velocity tool counts the same
// windows the prompt was rendered with.
//
// Resumable: trends already in the file are skipped.
//
//   node docs/wayfinder/assets/crma-1647/snapshot.mjs [--limit=N]

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runStep } from "./lib/workflow.mjs";
import { loadStep } from "./lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "./lib/prompts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const WF_DIR = join(REPO_ROOT, "lifecycle-subagent-p_gYC562o");
const OUT = join(HERE, "out", "snapshot.jsonl");
const STEPS = ["q_metrics", "q_signal_domains", "q_lifecycle_history", "q_recent_signals", "q_candidate_signals", "q_neighbors"];

const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || Infinity);
const sample = JSON.parse(readFileSync(join(HERE, "out", "sample.json"), "utf8")).trends;
const done = new Set(
  existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).trend_id) : [],
);
const todo = sample.filter((t) => !done.has(t.trend_id)).slice(0, limit);

const wf = readWorkflow(join(WF_DIR, "workflow.yaml"));
const { computeHeatBase, fmtJson, parseVariant } = await loadStep(join(WF_DIR, "run_subagent", "entry.js"), [
  "computeHeatBase", "fmtJson", "parseVariant",
]);
const loaded = loadPrompts(["lifecycle.subagent.system", "lifecycle.subagent.decision_rubric"]);
const systemPrompt = loaded["lifecycle.subagent.system"];
const rubric = loaded["lifecycle.subagent.decision_rubric"];
console.error(`${sample.length} sampled, ${done.size} already frozen, ${todo.length} to fetch; prompts ${JSON.stringify(provenance(loaded))}`);

for (const t of todo) {
  const trend_id = t.trend_id;
  const rows = Object.fromEntries(STEPS.map((s) => [s, runStep(wf, s, { trend_id })]));
  const snapshot_at = new Date().toISOString();
  const metricsRow = rows.q_metrics[0];
  if (!metricsRow) throw new Error(`lifecycle: no FCT_TRENDS row for trend_id ${trend_id}`);

  // ── entry.js:496-690, verbatim apart from the this.* row props ─────────
  const metrics = {
    trend_id: metricsRow.TREND_ID,
    trend_topic: metricsRow.TREND_TOPIC,
    lifecycle_status: metricsRow.LIFECYCLE_STATUS,
    total_cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
    distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
    confidence: metricsRow.CONFIDENCE,
    specificity_score: metricsRow.SPECIFICITY_SCORE,
    trend_heat_index: metricsRow.TREND_HEAT_INDEX,
    trend_heat_index_smoothed: metricsRow.TREND_HEAT_INDEX_SMOOTHED,
    promoted_at: metricsRow.PROMOTED_AT,
    last_update_at: metricsRow.LAST_UPDATE_AT,
    last_lifecycle_eval_at: metricsRow.LAST_LIFECYCLE_EVAL_AT,
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
    (rows.q_signal_domains || [])
      .filter((r) => r.DOMAIN && Number(r.SIGNAL_COUNT) > 0)
      .map((r) => [r.DOMAIN, Number(r.SIGNAL_COUNT)])
  );

  const lifecycle_history = (rows.q_lifecycle_history || []).map((r) => ({
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

  const recent_signals = (rows.q_recent_signals || []).map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
  }));

  const candidate_signals = (rows.q_candidate_signals || []).map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  const neighbor_pool = (rows.q_neighbors || []).map((r) => ({
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

  const { heat_base, components } = computeHeatBase({
    metrics, signal_domain_counts, recent_signals,
  });

  const _now = Date.now();
  const _7d = 7 * 24 * 3600 * 1000;
  const _24h = 24 * 3600 * 1000;
  const linkedTs = recent_signals
    .map(s => (s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0))
    .filter(ts => ts > 0);
  const last7dCount = linkedTs.filter(ts => (_now - ts) <= _7d).length;
  const priorWeekCount = linkedTs.filter(ts => (_now - ts) > _7d).length;
  const last24hCount = linkedTs.filter(ts => (_now - ts) <= _24h).length;
  const newestLinkedTs = linkedTs.length ? Math.max(...linkedTs) : null;
  const daysSilent = newestLinkedTs !== null
    ? ((_now - newestLinkedTs) / (24 * 3600 * 1000)).toFixed(1)
    : null;
  const activeDomains = Object.values(signal_domain_counts).filter(v => v > 0).length;
  const priorHeatBase = lifecycle_history.length && lifecycle_history[0].heat_base != null
    ? Number(lifecycle_history[0].heat_base) : null;
  const heatDelta = priorHeatBase !== null ? (heat_base - priorHeatBase).toFixed(1) : null;
  const heatTrajectory = lifecycle_history.length
    ? lifecycle_history.slice(0, 5).map(h => `${h.evaluated_at}: ${h.new_heat}`).join(" → ")
    : null;

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
    ? lifecycle_history.map((h, i) =>
        `${i + 1}. ${h.evaluated_at} — ${h.prior_status} → ${h.new_status} | heat ${h.prior_heat} → ${h.new_heat} ` +
        `${h.retirement_proposal ? "[RETIREMENT_PROPOSED] " : ""}` +
        `reason: ${(h.reasoning || "").slice(0, 200)}`
      ).join("\n")
    : "(no prior lifecycle evaluations)";

  const recent_signals_block = recent_signals.length
    ? recent_signals.slice(0, 20).map((s, i) =>
        `${i + 1}. [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
      ).join("\n")
    : "(no signals in last 14d)";

  const neighbor_block = neighbor_pool.length
    ? neighbor_pool.slice(0, 10).map((n, i) =>
        `${i + 1}. sim=${n.similarity.toFixed(2)} | ${n.lifecycle_status} | "${n.trend_name_b2c || n.trend_topic}" (heat ${n.heat})`
      ).join("\n")
    : "(no neighbors in pool)";

  const candidate_signals_block = candidate_signals.length
    ? candidate_signals.map((s, i) =>
        `${i + 1}. sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
      ).join("\n")
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

  const renderedSystem = render(systemPrompt.template, {
    decision_rubric: rubric.template,
    trend_state_block,
    metrics_block,
    lifecycle_history_block,
    recent_signals_block,
    candidate_signals_block,
    neighbor_block,
    heat_baseline_block,
  });

  const userMessage = `Evaluate trend ${trend_id}. Current status is ${metrics.lifecycle_status}. ` +
    `Use the prefetched context to decide the new status, heat modifier, and any description update. ` +
    `Call propose_lifecycle_decision exactly once with your final answer.`;
  // ── end of the entry.js copy ─────────────────────────────────────────────

  appendFileSync(OUT, JSON.stringify({
    trend_id, stratum: t.stratum, snapshot_at, current_status: metrics.lifecycle_status, heat_base,
    prompt_versions: { system: systemPrompt.version, rubric: rubric.version },
    model_params: systemPrompt.params,
    system: renderedSystem, user_message: userMessage,
    context: { neighbor_pool, recent_signals, lifecycle_history },
    rows,
  }) + "\n");
  console.error(`frozen ${trend_id} [${t.stratum}] status=${metrics.lifecycle_status} heat_base=${heat_base}`);
}
