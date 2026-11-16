// CRMA-1687 step 1: freeze the attribution subagent's input for a sample of
// eligible trends, once, so every run (tool loop and one request, Pro and
// Flash) prices the same requests.
//
// The SQL is the workflow's own: lib/workflow.mjs reads the four per-trend
// snowflake steps out of lifecycle-attribution-subagent-p_PACe77B/workflow.yaml.
// The prompt assembly below is a copy of run_subagent/entry.js run(), because
// it lives inside run() and cannot be imported. If that block changes, re-copy it.
//
// Sample: the first N eligible trends (same eligibility as the sweep's
// q_select_active_trends) in a fixed hash order, so a re-run picks the same set.
// Trends with an empty pool are kept: production skips the LLM for them, and
// the report counts them at $0.
//
// Read-only. Resumable: trends already in out/snapshot.jsonl are skipped.
//
//   node docs/wayfinder/assets/crma-1687/snapshot.mjs [--n=50]

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runStep } from "./lib/workflow.mjs";
import { query } from "./lib/snowflake.mjs";
import { loadPrompts, provenance } from "./lib/prompts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const WF_DIR = join(REPO_ROOT, "lifecycle-attribution-subagent-p_PACe77B");
const OUT = join(HERE, "out", "snapshot.jsonl");
const LOOKBACK_HOURS = 72; // handle_request default; the sweeper sends none
const SIMILARITY_THRESHOLD = "0.35";

const n = Number(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] || 50);

const sample = query(`
WITH latest_lifecycle AS (
  SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER) WHERE rn = 1),
tv AS (
  SELECT DISTINCT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL)
SELECT t.TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN tv ON tv.TREND_ID = t.TREND_ID
LEFT JOIN latest_lifecycle lc ON lc.TREND_ID = t.TREND_ID
WHERE COALESCE(lc.LIFECYCLE_STATUS, 'NEW') NOT IN ('RETIRED', 'DORMANT')
ORDER BY HASH(t.TREND_ID || 'crma-1687')
LIMIT ${n}`).map((r) => r.TREND_ID);

const done = new Set(
  existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).trend_id) : [],
);
const todo = sample.filter((id) => !done.has(id));

const wf = readWorkflow(join(WF_DIR, "workflow.yaml"));
const loaded = loadPrompts(["signal.attribution.system", "signal.attribution.rubric"]);
const systemPrompt = loaded["signal.attribution.system"];
const rubric = loaded["signal.attribution.rubric"];
console.error(`${sample.length} sampled, ${done.size} frozen, ${todo.length} to fetch; prompts ${JSON.stringify(provenance(loaded))}`);

function render(template, vars) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

for (const trend_id of todo) {
  const b = { trend_id, lookback_hours: LOOKBACK_HOURS };
  const rows = {
    q_trend_context: runStep(wf, "q_trend_context", b),
    q_existing_signal_sources: runStep(wf, "q_existing_signal_sources", b),
    q_candidate_signals: runStep(wf, "q_candidate_signals", b),
  };
  const snapshot_at = new Date().toISOString();

  // ── run_subagent/entry.js run(), apart from the this.* row props ─────────
  const contextRow = rows.q_trend_context[0];
  if (!contextRow) throw new Error(`attr-sub: no FCT_TRENDS row for trend_id ${trend_id}`);
  const trend = {
    trend_id: contextRow.TREND_ID,
    trend_topic: contextRow.TREND_TOPIC,
    trend_name_b2c: contextRow.TREND_NAME_B2C,
    trend_name_b2b: contextRow.TREND_NAME_B2B,
    category: contextRow.CATEGORY,
    subcategory: contextRow.SUBCATEGORY,
    promoted_at: contextRow.PROMOTED_AT,
    summary_short: contextRow.SUMMARY_SHORT,
    summary_long: contextRow.SUMMARY_LONG,
  };
  const existing_source_types = (rows.q_existing_signal_sources || []).map((r) => r.LINK_TYPE).filter(Boolean);
  const candidate_signals = (rows.q_candidate_signals || []).map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  const trend_block =
    `TREND_ID: ${trend.trend_id}
TREND_TOPIC: ${trend.trend_topic}
TREND_NAME_B2B / B2C: ${trend.trend_name_b2b || "(unenriched)"} / ${trend.trend_name_b2c || "(unenriched)"}
CATEGORY: ${trend.category || "?"} / ${trend.subcategory || "?"}
PROMOTED_AT: ${trend.promoted_at}
SUMMARY: ${trend.summary_short || "(no summary yet)"}
EXISTING SIGNAL SOURCE TYPES: ${existing_source_types.length ? existing_source_types.join(", ") : "(none yet)"}`;

  const candidate_signals_block = candidate_signals
    .map((s, i) =>
      `${i + 1}. [${s.signal_id}] sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp}\n` +
      `   Title: "${(s.signal_title || "").slice(0, 120)}"\n` +
      `   Text: ${(s.signal_text || "").slice(0, 250)}`
    )
    .join("\n\n");

  const renderedSystem = render(systemPrompt.template, {
    trend_block,
    candidate_signals_block,
    similarity_threshold: SIMILARITY_THRESHOLD,
    attribution_rubric: rubric.template,
  });

  const userMessage =
    `Evaluate ${candidate_signals.length} candidate signals for trend ${trend_id} ("${trend.trend_topic}"). ` +
    `Apply the attribution rubric to each candidate. ` +
    `Call commit_attributions exactly once with the confirmed list (empty array is a valid outcome).`;
  // ── end of the entry.js copy ─────────────────────────────────────────────

  appendFileSync(OUT, JSON.stringify({
    trend_id, snapshot_at, trend_topic: trend.trend_topic,
    candidate_count: candidate_signals.length,
    prompt_versions: { system: systemPrompt.version, rubric: rubric.version },
    model_params: systemPrompt.params,
    system: renderedSystem, user_message: userMessage,
    context: { candidate_signals },
  }) + "\n");
  console.error(`frozen ${trend_id} candidates=${candidate_signals.length} "${(trend.trend_topic || "").slice(0, 60)}"`);
}
