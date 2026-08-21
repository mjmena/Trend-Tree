// Lane: the lifecycle-attribution subagent (CRMA-734, second half).
//
// Decides which newly-ingested signals belong to an existing trend, and so
// grows a trend's evidence pool over time. Its errors are asymmetric and
// worth naming before anyone reads a diff: a FALSE POSITIVE silently
// pollutes a trend's evidence and inflates its heat through the breadth
// term, while a false negative merely leaves a signal unlinked until a
// later sweep. Judge precision harder than recall here.
//
// It also has the tightest per-call budget in the fleet (budget_usd 0.04,
// per_call_max_tokens 2048), so it is the second place the budget-gate trap
// would bite after promotion.
//
// A structural caveat: the candidate pool comes from an anti-join against
// FCT_TREND_SIGNALS, so signals the incumbent already attributed are now
// EXCLUDED from the replay's pool. The candidate model is therefore judged
// on today's leftovers, not on the incumbent's original slate. Read the
// counts, not a row-by-row match.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "lifecycle-attribution-subagent-p_PACe77B";
const ENTRY = join(REPO_ROOT, WF_DIR, "run_subagent", "entry.js");
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");

export const name = "attribution";
export const summary =
  "Links newly-ingested signals to existing trends. Asymmetric errors — a false positive silently inflates heat.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-734";

// The stored incumbent record is NOT comparable, so the left column must be a
// re-run. This lane is not grounded — the reason is a pool mismatch. cases()
// reports the signals a trend has EVER had attributed, while build() assembles
// the pool production would see now: signals from the last 24 hours that are
// not yet linked (q_candidate_signals, lookback_hours 24, anti-joined against
// FCT_TREND_SIGNALS). The two sides are different signals over different
// windows, so "12 attributed historically vs 3 of 9 today" compares nothing —
// not even as a rate, since the incumbent's original pool size was never
// recorded. Firing both models at today's identical pool is the only sound
// comparison this lane supports.
export const requiresRerun = true;

/** Trends that recently received attributed links, and so have a live pool. */
export async function cases({ limit = 3, caseId = null }) {
  const where = caseId ? `AND ts.TREND_ID = ${sqlStr(caseId)}` : "";
  const rows = query(`
    SELECT ts.TREND_ID,
           COUNT(*)                        AS ATTRIBUTED_COUNT,
           MAX(ts.LINKED_AT)               AS LAST_LINKED_AT,
           ARRAY_AGG(ts.SIGNAL_ID)         AS SIGNAL_IDS,
           ANY_VALUE(t.TREND_TOPIC)        AS TREND_TOPIC
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
      JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
     WHERE ts.LINK_KIND = 'attributed'
       ${where}
     GROUP BY ts.TREND_ID
     ORDER BY MAX(ts.LINKED_AT) DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => ({
    id: r.TREND_ID,
    label: `${r.TREND_TOPIC ?? r.TREND_ID} · ${r.ATTRIBUTED_COUNT} attributed by ${String(r.LAST_LINKED_AT).slice(0, 16)}`,
    incumbentAt: String(r.LAST_LINKED_AT).slice(0, 10),
    incumbent: {
      emission: {
        attributions: (variant(r.SIGNAL_IDS) || []).map((id) => ({ signal_id: id })),
      },
      telemetry: { model: incumbentModel, attributed_count: r.ATTRIBUTED_COUNT },
    },
  }));
}

export async function build(c) {
  const wf = readWorkflow(WORKFLOW);
  // handle_request defaults lookback_hours to 24 (entry.js:35).
  const b = { trend_id: c.id, lookback_hours: 24 };

  const trend_context_rows = runStep(wf, "q_trend_context", b);
  const existing_sources_rows = runStep(wf, "q_existing_signal_sources", b);
  const candidate_signal_rows = runStep(wf, "q_candidate_signals", b);

  const contextRow = trend_context_rows[0];
  if (!contextRow) throw new Error(`no FCT_TRENDS row for trend_id ${c.id}`);

  const { ALL_TOOL_NAMES, TOOL_SCHEMAS, toFunctionDeclarations, dispatchTool, SIMILARITY_THRESHOLD } =
    await loadStep(ENTRY, [
      "ALL_TOOL_NAMES",
      "TOOL_SCHEMAS",
      "toFunctionDeclarations",
      "dispatchTool",
      "SIMILARITY_THRESHOLD",
    ]);

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

  const existing_source_types = existing_sources_rows.map((r) => r.LINK_TYPE).filter(Boolean);

  const candidate_signals = candidate_signal_rows.map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  if (candidate_signals.length === 0) {
    throw new Error(
      `trend ${c.id} has no candidate signals today — production would skip the LLM entirely. ` +
        `Pick another case with --case, or raise --limit.`,
    );
  }

  const trend_block = `TREND_ID: ${trend.trend_id}
TREND_TOPIC: ${trend.trend_topic}
TREND_NAME_B2B / B2C: ${trend.trend_name_b2b || "(unenriched)"} / ${trend.trend_name_b2c || "(unenriched)"}
CATEGORY: ${trend.category || "?"} / ${trend.subcategory || "?"}
PROMOTED_AT: ${trend.promoted_at}
SUMMARY: ${trend.summary_short || "(no summary yet)"}
EXISTING SIGNAL SOURCE TYPES: ${existing_source_types.length ? existing_source_types.join(", ") : "(none yet)"}`;

  const candidate_signals_block = candidate_signals
    .map(
      (s, i) =>
        `${i + 1}. [${s.signal_id}] sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp}\n` +
        `   Title: "${(s.signal_title || "").slice(0, 120)}"\n` +
        `   Text: ${(s.signal_text || "").slice(0, 250)}`,
    )
    .join("\n\n");

  const loaded = loadPrompts(["signal.attribution.system", "signal.attribution.rubric"]);
  const sys = loaded["signal.attribution.system"];

  const system = render(sys.template, {
    trend_block,
    candidate_signals_block,
    similarity_threshold: SIMILARITY_THRESHOLD,
    attribution_rubric: loaded["signal.attribution.rubric"].template,
  });

  const userMessage =
    `Evaluate ${candidate_signals.length} candidate signals for trend ${c.id} ("${trend.trend_topic}"). ` +
    `Apply the attribution rubric to each candidate. ` +
    `Call commit_attributions exactly once with the confirmed list (empty array is a valid outcome).`;

  const p = sys.params || {};
  return {
    mode: "loop",
    system,
    userMessage,
    tools: [{ functionDeclarations: toFunctionDeclarations(ALL_TOOL_NAMES) }],
    toolNames: ALL_TOOL_NAMES,
    terminalTool: "commit_attributions",
    terminalSchema: TOOL_SCHEMAS.commit_attributions?.input_schema ?? null,
    dispatchTool,
    context: { candidate_signals, proposed_attributions: [] },
    maxIterations: Number(p.max_iterations) || 6,
    budgetUsd: Number(p.budget_usd) || 0.04,
    perCallMaxTokens: Number(p.per_call_max_tokens) || 2048,
    thinkingLevel: p.thinking_level || "medium",
    promptProvenance: provenance(loaded),
    notes: {
      candidates_today: candidate_signals.length,
      similarity_threshold: SIMILARITY_THRESHOLD,
      pool_caveat:
        "signals the incumbent already attributed are excluded by the anti-join — compare acceptance RATE, not row identity",
      budget_usd: Number(p.budget_usd) || 0.04,
    },
  };
}

export function compareRows(incumbent, candidate, result) {
  const a = incumbent?.emission?.attributions ?? [];
  const b = candidate?.emission?.attributions ?? [];
  const pool = result?.built?.input_notes?.candidates_today ?? null;
  const ids = (x) => (Array.isArray(x) ? x : []).map((r) => r.signal_id).join("\n") || "—";
  const rate = (n) => (pool ? `${n} of ${pool} (${Math.round((100 * n) / pool)}%)` : String(n));
  const agreement = (x, y) => {
    const sx = new Set((Array.isArray(x) ? x : []).map((r) => r.signal_id));
    const sy = new Set((Array.isArray(y) ? y : []).map((r) => r.signal_id));
    const both = [...sx].filter((id) => sy.has(id)).length;
    return `${both} shared · ${sx.size - both} incumbent-only · ${sy.size - both} candidate-only`;
  };

  return [
    {
      field: "attributions accepted",
      left: rate(a.length),
      right: rate(b.length),
      note: "both sides fired at the SAME pool today (requiresRerun) — directly comparable",
    },
    { field: "signal_ids", left: ids(a), right: ids(b) },
    {
      field: "agreement",
      left: "—",
      right: agreement(a, b),
      note: "same pool, so row identity is meaningful here — read the disagreements",
    },
    {
      field: "rejected",
      left: pool != null ? pool - a.length : "—",
      right: pool != null ? pool - b.length : "—",
      note: "precision matters more than recall — a false positive inflates heat",
    },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
