// Audit Agent — workflow_health severity (CRMA-1031)
//
// Pure helper, sibling-imported by ./entry.mjs, like ./catalog_freshness.mjs.
// It imports no other sibling.
//
// The count rule (INFO 1-2, WARN 3-9, RED 10 and above) ignores run volume.
// lifecycle-subagent runs about 588 times a day, so 10 transient Gemini
// failures is 1.7% of its runs. The same 10 errors on a workflow that runs 4
// times a day is a total outage. The two fan-out subagents therefore grade on
// the error rate. Every other workflow keeps the count rule.
//
// entry.mjs puts the grade into the PIPEDREAM WORKFLOW HEALTH block, and the
// audit.report_rubric prompt tells the agent to use it as given. The agent
// still writes the alert; it no longer derives the severity from a count.

export const FAN_OUT_SUBAGENTS = ["lifecycle-subagent", "lifecycle-attribution-subagent"];
export const RATE_RED_PCT = 5;
export const COUNT_WARN_MIN = 3;
export const COUNT_RED_MIN = 10;

/**
 * workflow: one fetch_pipedream_errors row —
 *   { workflow_name, errors_24h_count, errors_24h_truncated }
 * runs24h: the workflow's total runs in the same 24h. Only the fan-out
 *   subagents use it. A NULL, missing, zero or negative value means the volume
 *   is unavailable, never "0 runs": the grade then falls back to the count rule.
 * Returns { severity: null | INFO | WARN | RED, rule, error_rate_pct, note }.
 */
export function gradeWorkflowErrors(workflow, runs24h) {
  const errors = Number(workflow?.errors_24h_count || 0);
  if (errors <= 0) return { severity: null, rule: null, error_rate_pct: null, note: null };

  const fanOut = FAN_OUT_SUBAGENTS.includes(workflow.workflow_name);
  const runs = runs24h === null || runs24h === undefined ? NaN : Number(runs24h);

  if (fanOut && Number.isFinite(runs) && runs > 0) {
    const rate = (errors / runs) * 100;
    const error_rate_pct = Math.round(rate * 10) / 10;
    // A truncated count is a floor, so the rate is a floor too. It cannot
    // prove the workflow is below the RED line.
    if (workflow.errors_24h_truncated === true) {
      return {
        severity: "RED",
        rule: "rate",
        error_rate_pct,
        note: `at least ${errors} errors over ${runs} runs; the count is truncated, so the true rate is unknown`,
      };
    }
    return {
      severity: rate >= RATE_RED_PCT ? "RED" : "WARN",
      rule: "rate",
      error_rate_pct,
      note: `${errors} errors over ${runs} runs = ${error_rate_pct}% (RED at >= ${RATE_RED_PCT}%)`,
    };
  }

  const severity = errors >= COUNT_RED_MIN ? "RED" : errors >= COUNT_WARN_MIN ? "WARN" : "INFO";
  return {
    severity,
    rule: "count",
    error_rate_pct: null,
    note: fanOut ? "run volume unavailable — count rule applied" : null,
  };
}

// lifecycle-subagent writes one FCT_TREND_LIFECYCLE_LEDGER row per successful
// run, and a failed run writes none: its runs are the inserts plus the errors.
// lifecycle-attribution-subagent leaves no per-run record (a run that links
// no signal writes nothing), so no source counts its runs yet.
function runs24hFor(workflow, { lifecycleInserts24h }) {
  if (workflow.workflow_name !== "lifecycle-subagent") return null;
  if (lifecycleInserts24h === null || lifecycleInserts24h === undefined) return null;
  return Number(lifecycleInserts24h) + Number(workflow.errors_24h_count || 0);
}

/**
 * The per-workflow rows of the PIPEDREAM WORKFLOW HEALTH block. A workflow
 * with errors carries its severity; the optional fields appear only when set,
 * to keep the block short for the 30 or so workflows with nothing to report.
 */
export function buildWorkflowHealthRows(workflows, volumes) {
  return (Array.isArray(workflows) ? workflows : []).map((w) => {
    const grade = gradeWorkflowErrors(w, runs24hFor(w, volumes || {}));
    return {
      workflow_name: w.workflow_name,
      workflow_id: w.workflow_id,
      errors_24h_count: w.errors_24h_count,
      ...(w.errors_24h_truncated === true ? { errors_24h_truncated: true } : {}),
      ...(grade.severity
        ? { severity: grade.severity, severity_rule: grade.rule, ...(grade.note ? { severity_note: grade.note } : {}) }
        : {}),
      top_errors: (w.errors_24h || []).slice(0, 3).map((e) => ({
        ts_iso: e.ts_iso, code: e.code, msg: e.msg, cell_id: e.cell_id,
      })),
      fetch_error: w.fetch_error,
      ...(w.detail_error ? { detail_error: w.detail_error } : {}),
    };
  });
}
