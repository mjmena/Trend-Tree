// Audit Agent — tiktok ingester freshness grading (CRMA-1338)
//
// Pure helper, sibling-imported by ./entry.mjs, like ./catalog_freshness.mjs
// (see that file's header for why the grade is deterministic and folded in
// after the Gemini loop). It imports no other sibling.
//
// The grade reads FCT_SIGNALS.EMBEDDED_AT — when the row landed — not
// SIGNAL_TIMESTAMP, which q_pipeline_freshness reads. A backfill keeps each
// row's original publish time in SIGNAL_TIMESTAMP, so that column hides an
// outage (the 2026-08-27 promote-task outage looked healthy there).
//
// services/tiktok-ingest/schedule.sh starts the ingester at 09:00 UTC. A
// normal run lands in under 30 minutes. The worst case is a run that hits the
// 1h job timeout and then a retry, which lands by 11:00. If today's run fails,
// the newest row at the 13:00 UTC audit is then at least 26h old, so a 25h
// window grades RED. A manual audit just before 09:00 still sees yesterday's
// normal run inside the window.
//
// A run that succeeds but writes zero rows (every video already ingested, or
// the filter keeps none) also grades RED. The ticket asks for exactly that
// rule, and a zero-row day from 24 seeds is not expected.

export const WINDOW_HOURS = 25;

/**
 * rows: q_tiktok_freshness output — one aggregate row:
 *   { MINUTES_SINCE_LAST_EMBEDDED, EMBEDDED_24H }
 * RED when no tiktok row embedded in the last WINDOW_HOURS. A NULL, missing
 * or negative age fails safe to RED, never to "0 minutes ago".
 */
export function gradeTiktokFreshness(rows) {
  const r = (Array.isArray(rows) ? rows : [])[0] || {};
  const raw = r.MINUTES_SINCE_LAST_EMBEDDED;
  const minutes = raw === null || raw === undefined ? NaN : Number(raw);
  const validAge = Number.isFinite(minutes) && minutes >= 0;
  const status = validAge && minutes <= WINDOW_HOURS * 60 ? "GREEN" : "RED";
  return {
    status,
    hours_since_last_embedded: validAge ? Math.round((minutes / 60) * 100) / 100 : null,
    embedded_24h: Number(r.EMBEDDED_24H || 0),
    window_hours: WINDOW_HOURS,
  };
}

/**
 * Fold the grade into the agent's report: adds report.tiktok, and when RED
 * adds one alert, a slack_summary_md line (post_to_slack renders only that
 * field) and escalates overall_status. Returns a new object.
 */
export function applyTiktokFinding(report, graded) {
  const base = report || {};
  const tiktok = { ...graded };
  if (graded.status === "GREEN") return { ...base, tiktok };

  const age = graded.hours_since_last_embedded === null
    ? "no tiktok row has ever embedded"
    : `newest tiktok row embedded ${graded.hours_since_last_embedded}h ago`;
  const alert = {
    severity: "RED",
    area: "tiktok",
    summary: `TikTok ingester stale: ${age}`,
    evidence: `FCT_SIGNALS SOURCE_NAME='tiktok' MAX(EMBEDDED_AT) age_hours=${graded.hours_since_last_embedded} ` +
      `embedded_24h=${graded.embedded_24h} (RED when no row embedded in ${WINDOW_HOURS}h)`,
  };
  const line = `🔴 *TikTok*: ${age} (window ${WINDOW_HOURS}h)`;

  return {
    ...base,
    tiktok,
    alerts: [...(Array.isArray(base.alerts) ? base.alerts : []), alert],
    slack_summary_md: base.slack_summary_md ? `${base.slack_summary_md}\n\n${line}` : line,
    overall_status: "RED",
  };
}
