// Ecomm Agent — the poll's claim read (CRMA-778, epic CRMA-772).
//
// One read: the anti-join that decides which trends this tick claims. The
// reference copy of this query, with the full rationale for each of its three
// eligibility arms, is sql/sourcing_poll_query.sql — read that file first. Only
// the bind syntax differs here (`?` positional vs that file's documentary
// `:tier` / `:stale_minutes` / `:limit`). Keep the two in sync.
//
// Read-only, and deliberately so: claiming does NOT write a marker. The
// 'running' header that PROC_SOURCING_APPLY('open') writes at the start of each
// trend's run IS the claim, which is what makes the guard survive a crash —
// there is no separate claim state that could leak if the process died between
// claiming and running.

import { runWithRetry } from "./snowflake.mjs";

const Q_POLL_BATCH = `
  WITH latest_lifecycle AS (
    SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    ) WHERE rn = 1
  ),
  enriched AS (
    SELECT TREND_ID, MAX(WRITTEN_AT) AS ENRICHED_AT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE WRITTEN_BY <> 'promotion'
      AND TREND_VECTOR IS NOT NULL
    GROUP BY TREND_ID
  ),
  blocking_header AS (
    SELECT DISTINCT TREND_ID
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
    WHERE TIER = ?
      AND (
            STATUS IN ('matched', 'no_match')
         OR (STATUS = 'running'
             AND STARTED_AT >= DATEADD('minute', -1 * ?, CURRENT_TIMESTAMP()))
      )
  )
  SELECT
    e.TREND_ID,
    e.ENRICHED_AT
  FROM enriched e
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    ON t.TREND_ID = e.TREND_ID
  LEFT JOIN latest_lifecycle lc
    ON lc.TREND_ID = e.TREND_ID
  LEFT JOIN blocking_header bh
    ON bh.TREND_ID = e.TREND_ID
  WHERE NVL(lc.LIFECYCLE_STATUS, 'NEW') <> 'RETIRED'
    AND bh.TREND_ID IS NULL
  ORDER BY e.ENRICHED_AT ASC
  LIMIT ?
`;

// -> [{ trend_id, enriched_at }], oldest enrichment first, at most `limit` long.
export async function fetchPollBatch({ connOpts, tier, staleMinutes, limit }) {
  const rows = await runWithRetry(connOpts, Q_POLL_BATCH, [tier, staleMinutes, limit]);
  return (rows || []).map((r) => ({
    trend_id: r.TREND_ID,
    enriched_at: r.ENRICHED_AT instanceof Date ? r.ENRICHED_AT.toISOString() : r.ENRICHED_AT,
  }));
}
