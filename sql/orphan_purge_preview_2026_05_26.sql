-- Preview: Migration-era orphan trend purge (2026-05-26)
--
-- Read-only. Pair with orphan_purge_2026_05_26.sql. Run this first, eyeball
-- the 22-trend list, then run the destructive script.
--
-- Background: 22 trends in FCT_TRENDS have all their FCT_TREND_SIGNALS rows
-- pointing at legacy SIGNAL_IDs (wiki_*, gdelt_<hash>, amazon_trends_*,
-- URL-as-ID) that don't resolve to today's UUID-keyed FCT_SIGNALS — fallout
-- from the 2026-04-28 agent-owned-ledgers refactor. Their evidence base is
-- permanently broken; cascade-delete them. See
-- /home/marty/.claude/plans/serialized-forging-marshmallow.md.
--
-- All 8 TREND_AGENT tables have 21-day Time Travel; STG_TREND_CANDIDATES
-- has 1-day. AT(OFFSET => -3600) etc. recovers if needed.

USE DATABASE MCC_PRESENTATION;
USE SCHEMA TREND_AGENT;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Header — quick sanity check before reading the lists below
-- ════════════════════════════════════════════════════════════════════════
SELECT 'orphan_purge_preview' AS script,
       CURRENT_TIMESTAMP() AS run_at,
       'about to delete the trends below + their cascade rows (next query)' AS note;

-- ════════════════════════════════════════════════════════════════════════
-- 2. The 22 trends — current status, promoted date, orphan footprint
--    Sorted by status then promoted-desc so the eyeball check is fast.
-- ════════════════════════════════════════════════════════════════════════
WITH all_orphan_trends AS (
  SELECT ts.TREND_ID,
         COUNT(*) AS total_linked,
         ARRAY_AGG(DISTINCT ts.SIGNAL_ID) WITHIN GROUP (ORDER BY ts.SIGNAL_ID) AS sample_signal_ids
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID
  HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
),
latest_lifecycle AS (
  SELECT TREND_ID, NEW_STATUS,
         ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
)
SELECT
  COALESCE(ll.NEW_STATUS, 'NEW') AS current_status,
  t.TREND_TOPIC,
  t.PROMOTED_AT::DATE            AS promoted,
  ao.total_linked                AS n_orphan_links,
  ARRAY_SLICE(ao.sample_signal_ids, 0, 2) AS first_two_signal_ids
FROM all_orphan_trends ao
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = ao.TREND_ID
LEFT JOIN latest_lifecycle ll ON ll.TREND_ID = ao.TREND_ID AND ll.rn = 1
ORDER BY current_status, promoted DESC;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Cascade row counts — live numbers from each affected table.
--    Compare against the plan's "Affected scope" table; drift means
--    something changed since 2026-05-26 and the plan needs a refresh.
--
--    UNION ALL not supported by the Snowflake MCP this was authored in;
--    eight standalone counts instead. Each block is one query; snowsql
--    runs them sequentially.
-- ════════════════════════════════════════════════════════════════════════

-- 3a. FCT_TRENDS (expected: 22)
SELECT 'FCT_TRENDS' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3b. FCT_TREND_SIGNALS (expected: 1393)
SELECT 'FCT_TREND_SIGNALS' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3c. FCT_TREND_LIFECYCLE_LEDGER (expected: 1545)
SELECT 'FCT_TREND_LIFECYCLE_LEDGER' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3d. FCT_TREND_ENRICHMENT_LEDGER (expected: 41)
SELECT 'FCT_TREND_ENRICHMENT_LEDGER' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3e. FCT_TREND_GTRENDS_DAILY (expected: 151)
SELECT 'FCT_TREND_GTRENDS_DAILY' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3f. FCT_TREND_SOURCE_METRICS (expected: 35)
SELECT 'FCT_TREND_SOURCE_METRICS' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3g. FCT_TREND_PREDICTION_LEDGER (expected: 22)
SELECT 'FCT_TREND_PREDICTION_LEDGER' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3h. MAP_TREND_MACROTRENDS (expected: 1)
SELECT 'MAP_TREND_MACROTRENDS' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
WHERE TREND_ID IN (
  SELECT ts.TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
  GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
);

-- 3i. STG_TREND_CANDIDATES (by CANDIDATE_ID via FCT_TRENDS) (expected: 22)
SELECT 'STG_TREND_CANDIDATES' AS table_name, COUNT(*) AS rows_to_delete
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
WHERE CANDIDATE_ID IN (
  SELECT CANDIDATE_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
  WHERE TREND_ID IN (
    SELECT ts.TREND_ID
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
    GROUP BY ts.TREND_ID HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0
  )
);
