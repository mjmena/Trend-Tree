// Promotion — fire_enrichment_chain target selection (CRMA-1032).
//
// Pure helpers, no defineComponent, so entry.mjs can import them and
// enrichment_targets.test.mjs can test them offline.
//
// A trend whose enrichment chain fails at promotion time used to stay
// unenriched forever. Each promotion run now also re-dispatches trends from
// the q_unenriched_trends step (promoted > 6h ago, no `initial` or
// `refinement` ledger row — the audit's q_stuck_trends set).
//
// A trend that fails every time must not burn an enrichment run (~$0.15)
// on every 3-hourly promotion run. There is no attempt log to count
// retries, so the cadence comes from the trend's age instead: a stuck trend
// is retry-due only while (hours since promotion - 6) mod 24 is in a
// 3-hour window. The promotion timer fires every 3 hours, so exactly one
// run per day lands in that window: first retry at hour 6, then daily.
// HOURS_SINCE_PROMOTED is fractional (minutes / 60), so the window does not
// shift by an hour when a run crosses a clock-hour boundary. The query runs
// after the lead agent, whose runtime varies by minutes; that jitter (or a
// manual HTTP run) can occasionally double a day's retry or skip one day.
// Both are bounded: one extra enrichment run, or a 24h delay.
//
// q_unenriched_trends orders youngest-first, and the per-run cap keeps that
// order: the trends with the fewest past retries go first, so a pile of
// trends that always fail cannot starve a newly failed one.

export const RETRY_FIRST_HOUR = 6;
export const RETRY_PERIOD_HOURS = 24;
export const RETRY_WINDOW_HOURS = 3;
export const MAX_RETRIES_PER_RUN = 5;

export function extractPromotedTrendIds(apply_result) {
  // PROC_PROMOTION_APPLY returns a single VARIANT row; the SQL action
  // wraps it in either an array or a single object with the proc name as
  // the column key. Defensive parsing matches eval_and_retrigger's pattern.
  let parsed = null;
  try {
    let row = null;
    if (Array.isArray(apply_result) && apply_result.length > 0) row = apply_result[0];
    else if (apply_result && typeof apply_result === "object" && !Array.isArray(apply_result)) row = apply_result;
    if (!row) return [];
    const value =
      row.PROC_PROMOTION_APPLY ??
      row.proc_promotion_apply ??
      Object.values(row)[0];
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (e) {
    console.log(`fire_enrichment_chain: could not parse apply_result: ${e.message}`);
    return [];
  }

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results
    .filter((r) => r && r.status === "ok" && r.decision === "PROMOTE_NEW" && r.target_trend_id)
    .map((r) => r.target_trend_id);
}

export function isRetryDue(hoursSincePromoted) {
  if (hoursSincePromoted === null || hoursSincePromoted === undefined || hoursSincePromoted === "") return false;
  const h = Number(hoursSincePromoted);
  if (!Number.isFinite(h) || h < RETRY_FIRST_HOUR) return false;
  return (h - RETRY_FIRST_HOUR) % RETRY_PERIOD_HOURS < RETRY_WINDOW_HOURS;
}

// unenrichedRows must arrive youngest-first (q_unenriched_trends' ORDER BY).
export function selectRetryTrendIds(unenrichedRows, { iteration = 1, dryRun = false } = {}) {
  // A self-retriggered iteration runs minutes after iteration 1, while the
  // chain iteration 1 fired is still running — retrying there double-fires.
  if (Number(iteration) > 1) return [];
  if (dryRun === true || dryRun === "true") return [];
  if (!Array.isArray(unenrichedRows)) return [];
  return unenrichedRows
    .filter((r) => r && r.TREND_ID && isRetryDue(r.HOURS_SINCE_PROMOTED))
    .map((r) => r.TREND_ID)
    .slice(0, MAX_RETRIES_PER_RUN);
}

export function buildDispatchTargets(promotedIds, retryIds) {
  const targets = [];
  const seen = new Set();
  for (const [ids, reason] of [[promotedIds, "promoted"], [retryIds, "retry"]]) {
    for (const trend_id of ids || []) {
      if (seen.has(trend_id)) continue;
      seen.add(trend_id);
      targets.push({ trend_id, reason });
    }
  }
  return targets;
}
