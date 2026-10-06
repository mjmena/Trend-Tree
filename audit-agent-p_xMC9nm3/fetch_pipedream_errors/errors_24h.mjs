// Audit Agent — true 24h error count (CRMA-1031)
//
// Pure helper, sibling-imported by ./entry.mjs. No `defineComponent` here, so
// a plain Node test can import it.
//
// Before CRMA-1031 the step asked for 10 errors per workflow, and the rubric
// graded RED at 10. RED then meant "the first page is full".
//
// The $errors stream keeps only the newest 100 events per workflow, and one
// request returns at most 100 (measured 2026-10-06: limit=1000 returns 100,
// and a request after the 100th id returns no row). One request of PAGE_LIMIT
// is therefore the whole stream, and 100 is the highest count this step can
// report. When all 100 rows sit inside the window, older errors of the same
// day are gone from the stream: the count is then a floor, flagged truncated.
//
// The count comes from rows fetched WITHOUT expand=event. Those rows hold an
// id and a timestamp only, so a stack trace cannot break the JSON. The detail
// rows (expand=event) are optional and cover only the newest errors.

export const PAGE_LIMIT = 100;
export const DETAIL_LIMIT = 10;

/**
 * summaries: $errors/event_summaries rows, newest first — { id, indexed_at_ms }.
 * detailed:  the same stream with expand=event, newest DETAIL_LIMIT rows.
 * A row with no timestamp counts as inside the window.
 */
export function buildErrors24h({ summaries, detailed, sinceMs }) {
  const rows = Array.isArray(summaries) ? summaries : [];
  const detailById = new Map((Array.isArray(detailed) ? detailed : []).map((d) => [d.id, d]));

  const errors_24h = rows
    .map((row) => {
      const event = detailById.get(row.id)?.event || {};
      const err = event.error || {};
      const ts = row.indexed_at_ms ? Number(row.indexed_at_ms) : null;
      return {
        event_id: row.id,
        ts_ms: ts,
        ts_iso: ts ? new Date(ts).toISOString() : null,
        recent_24h: ts ? ts >= sinceMs : false,
        cell_id: event.original_context?.cell_id || null,
        code: err.code || null,
        msg: typeof err.msg === "string" ? err.msg.slice(0, 400) : null,
      };
    })
    .filter((e) => e.ts_ms === null || e.recent_24h);

  return {
    errors_24h_count: errors_24h.length,
    errors_24h_truncated: rows.length >= PAGE_LIMIT && errors_24h.length === rows.length,
    errors_24h,
  };
}
