-- The poll's anti-join (CRMA-778, epic CRMA-772).
-- Spec: docs/prd/trend-to-product-sourcing.md
--
-- Answers one question: which trends does this tick claim? A trend qualifies
-- when it is live, genuinely enriched, and carries no header that still counts
-- as "already handled" for this tier.
--
-- This file is DOCUMENTARY and is the reference copy. The executable copy lives
-- in services/ecomm-agent/fetch_poll_batch.mjs, which differs only in bind
-- syntax (`?` positional there vs `:tier` / `:stale_minutes` / `:limit` here).
-- Keep the two in sync — test/sourcing_poll.test.sql exercises this shape and
-- is the thing that catches them drifting apart.
--
-- Three arms decide eligibility, and each is a decision worth stating:
--
--   1. LIVE. Everything except RETIRED, via the latest FCT_TREND_LIFECYCLE_LEDGER
--      row per trend. A trend with no lifecycle row yet is live — the lifecycle
--      agent sweeps hourly, so a freshly promoted trend routinely has none, and
--      excluding it would make the poll silently skip the newest work. Same
--      NVL(..., 'NEW') <> 'RETIRED' convention as sql/task_recompute_content_matches.sql.
--
--   2. ENRICHED FOR REAL. FCT_TREND_ENRICHMENT_LEDGER rows written by 'promotion'
--      are seeds carrying topic-only vectors, not enrichment, and sourcing
--      against one produces a match to the topic rather than the trend. The
--      same WRITTEN_BY <> 'promotion' AND TREND_VECTOR IS NOT NULL pair that
--      fetch_context.mjs uses to find a sourceable vector is used here to
--      decide sourceability, so the poll never claims a trend the run would
--      then have to fail.
--
--   3. NOT ALREADY HANDLED. A header blocks the trend only when it is terminal-
--      and-successful ('matched' / 'no_match') or genuinely in flight ('running'
--      inside the staleness window). Two exclusions carry the story's
--      self-healing requirement:
--        * 'failed' NEVER blocks. The next tick retries it. There is no
--          dead-letter table and no operator step.
--        * 'running' older than :stale_minutes never blocks either. A run
--          killed mid-flight (Cloud Run reclaiming the instance, a crash after
--          'open') leaves a 'running' header nothing will ever complete;
--          without this arm that trend is parked forever. PROC_SOURCING_APPLY's
--          own header comment explicitly assigns this guard here.
--
-- A freshness DECLINE writes no header at all, by design (see
-- services/ecomm-agent/run_sourcing.mjs). So a declined trend reads as "no
-- header" and is re-claimed next tick — which is the wanted behaviour: once a
-- catalog sync refreshes LAST_SEEN_AT, the backlog drains without intervention.
--
-- Ordering is oldest-enrichment-first so the backfill drains in the order the
-- trends were enriched, and a tick can never starve the oldest work by
-- repeatedly claiming whatever was enriched most recently.

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
  WHERE TIER = :tier
    AND (
          STATUS IN ('matched', 'no_match')
       OR (STATUS = 'running'
           AND STARTED_AT >= DATEADD('minute', -1 * :stale_minutes, CURRENT_TIMESTAMP()))
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
LIMIT :limit;
