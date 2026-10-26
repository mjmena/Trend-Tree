// Audit Agent — lifecycle overdue grading
//
// Pure helper, sibling-imported by ./entry.mjs, same grade-and-fold shape as
// ./tiktok_freshness.mjs. It imports no other sibling.
//
// Reads the q_pipeline_freshness row AREA='lifecycle', KEY='overdue_6h':
// COUNT_24H is the count of live, non-RETIRED trends more than 6h past
// COALESCE(NEXT_EVAL_AT, PROMOTED_AT + 24h) — the lifecycle due query's own
// definition — and MINUTES_SINCE_LAST is the worst lateness past that time.

export const GRACE_HOURS = 6;

/**
 * Any overdue trend grades YELLOW. A missing row or NULL count fails safe to
 * YELLOW, never to "0 overdue".
 */
export function gradeLifecycleOverdue(rows) {
  const r = (Array.isArray(rows) ? rows : [])
    .find((x) => x.AREA === "lifecycle" && x.KEY === "overdue_6h") || {};
  const count = r.COUNT_24H === null || r.COUNT_24H === undefined ? NaN : Number(r.COUNT_24H);
  const minutes = r.MINUTES_SINCE_LAST === null || r.MINUTES_SINCE_LAST === undefined
    ? NaN : Number(r.MINUTES_SINCE_LAST);
  return {
    status: count === 0 ? "GREEN" : "YELLOW",
    overdue_count: Number.isFinite(count) ? count : null,
    max_hours_past_due: Number.isFinite(minutes) ? Math.round((minutes / 60) * 100) / 100 : null,
    grace_hours: GRACE_HOURS,
  };
}

/**
 * Fold the grade into the agent's report: always adds report.lifecycle_overdue,
 * and when YELLOW adds one alert and a slack_summary_md line, and raises a
 * GREEN overall_status to YELLOW (never lowers RED). Returns a new object.
 */
export function applyLifecycleOverdueFinding(report, graded) {
  const base = report || {};
  const lifecycle_overdue = { ...graded };
  if (graded.status === "GREEN") return { ...base, lifecycle_overdue };

  const what = graded.overdue_count === null
    ? "overdue count unavailable"
    : `${graded.overdue_count} live trend(s) more than ${GRACE_HOURS}h past NEXT_EVAL_AT` +
      (graded.max_hours_past_due === null ? "" : ` (worst ${graded.max_hours_past_due}h)`);
  const alert = {
    severity: "YELLOW",
    area: "lifecycle",
    summary: `Lifecycle evaluations overdue: ${what}`,
    evidence: `FCT_TRENDS non-RETIRED with COALESCE(NEXT_EVAL_AT, PROMOTED_AT + 24h) < now-${GRACE_HOURS}h: ` +
      `${graded.overdue_count}; max hours past due: ${graded.max_hours_past_due}`,
  };
  const line = `🟡 *Lifecycle*: ${what}`;

  return {
    ...base,
    lifecycle_overdue,
    alerts: [...(Array.isArray(base.alerts) ? base.alerts : []), alert],
    slack_summary_md: base.slack_summary_md ? `${base.slack_summary_md}\n\n${line}` : line,
    overall_status: base.overall_status === "RED" ? "RED" : "YELLOW",
  };
}
