// Audit Agent — editorial nomination counts (CRMA-1670, spec CRMA-1660)
//
// Pure helper, sibling-imported by ./entry.mjs, like ./tiktok_freshness.mjs
// (same grade-and-fold shape). It imports no other sibling.
//
// Both counts come from two extra q_et_rescue columns:
//   EDITORIAL_PROMOTIONS_24H   — editorial candidates (AGENT_SESSION_ID =
//                                CANDIDATE_ID = nomination_id) whose
//                                PROMOTED_AT is in the last 24h.
//   EDITORIAL_STUCK_CANDIDATES — editorial candidates older than 1h with
//                                PROMOTED_AT NULL: a Cloud Task that exhausted
//                                its retries, or the inert candidate from
//                                ADR-0011.
// Any stuck candidate grades RED deterministically; there is no dead-letter
// queue, so this audit is the only place such a nomination gets noticed.

/**
 * rows: q_et_rescue output — one aggregate row. A missing row or NULL stuck
 * count fails safe to RED, never to "0 stuck".
 */
export function gradeEditorialCounts(rows) {
  const r = (Array.isArray(rows) ? rows : [])[0] || {};
  const raw = r.EDITORIAL_STUCK_CANDIDATES;
  const stuck = raw === null || raw === undefined ? NaN : Number(raw);
  return {
    status: stuck === 0 ? "GREEN" : "RED",
    promotions_24h: Number(r.EDITORIAL_PROMOTIONS_24H || 0),
    stuck_candidates: Number.isFinite(stuck) ? stuck : null,
  };
}

/**
 * Fold the grade into the agent's report: always adds report.editorial (so
 * both counts reach FCT_AUDIT_LEDGER.REPORT), and when RED adds one alert, a
 * slack_summary_md line and escalates overall_status. Returns a new object.
 */
export function applyEditorialFinding(report, graded) {
  const base = report || {};
  const editorial = { ...graded };
  if (graded.status === "GREEN") return { ...base, editorial };

  const what = graded.stuck_candidates === null
    ? "stuck-candidate count unavailable"
    : `${graded.stuck_candidates} editorial candidate(s) not applied after 1h`;
  const alert = {
    severity: "RED",
    area: "editorial",
    summary: `Editorial nominations stuck: ${what}`,
    evidence: `STG_TREND_CANDIDATES editorial (AGENT_SESSION_ID = CANDIDATE_ID) with PROMOTED_AT NULL AND CREATED_AT < now-1h: ` +
      `${graded.stuck_candidates}; EDITORIAL promotions 24h: ${graded.promotions_24h}`,
  };
  const line = `🔴 *Editorial*: ${what}`;

  return {
    ...base,
    editorial,
    alerts: [...(Array.isArray(base.alerts) ? base.alerts : []), alert],
    slack_summary_md: base.slack_summary_md ? `${base.slack_summary_md}\n\n${line}` : line,
    overall_status: "RED",
  };
}
