-- Execute: Migration-era orphan trend purge (2026-05-26)
--
-- DESTRUCTIVE. Run sql/orphan_purge_preview_2026_05_26.sql FIRST and eyeball
-- the 22-trend list before this one. Both scripts share the same orphan
-- detection criterion (TOTAL_LINKED > 0 AND MATCHED_IN_FCT_SIGNALS = 0).
--
-- See /home/marty/.claude/plans/serialized-forging-marshmallow.md for design
-- rationale. Treats the 22 migration-era trends as "never happened" via a
-- single-transaction cascade DELETE across 9 tables (~3,232 rows).
--
-- Recovery (within Time Travel window):
--   TREND_AGENT tables — 21 days. Example:
--     INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
--     SELECT * FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS BEFORE(STATEMENT => '<delete_stmt_id>');
--   STG_TREND_CANDIDATES — 1 day only. Move fast if needed.
--
-- Operator note: verify SELECTs at the end must each return 0. If any return
-- nonzero, the cascade is incomplete — recover via Time Travel and investigate.

USE DATABASE MCC_PRESENTATION;
USE SCHEMA TREND_AGENT;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Materialize the orphan trend_id set BEFORE the transaction.
--    DDL inside BEGIN/COMMIT auto-commits the txn in Snowflake, so do
--    the CREATE TEMP TABLE outside. Temp tables vanish at session end.
--
--    Freezing the set into a temp table also means every DELETE below
--    references the SAME 22 trend_ids — no risk of the set shifting mid-run
--    if a concurrent process touches FCT_TREND_SIGNALS.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE TEMPORARY TABLE _orphan_purge_targets AS
SELECT ts.TREND_ID
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
  ON s.SIGNAL_ID = ts.SIGNAL_ID
GROUP BY ts.TREND_ID
HAVING COUNT(*) > 0 AND COUNT(s.SIGNAL_ID) = 0;

-- Capture candidate_ids before FCT_TRENDS gets deleted — they're the
-- breadcrumb to the STG_TREND_CANDIDATES rows we also need to drop.
CREATE OR REPLACE TEMPORARY TABLE _orphan_purge_candidate_ids AS
SELECT CANDIDATE_ID
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

-- Sanity check before the transaction. Must be 22.
SELECT 'targets_count' AS check_name, COUNT(*) AS n FROM _orphan_purge_targets;
SELECT 'candidate_ids_count' AS check_name, COUNT(*) AS n FROM _orphan_purge_candidate_ids;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Single transaction — all 9 DELETEs commit together or none commit.
--    Order: leaf-dependent tables first, then the FCT_TRENDS root, then
--    STG_TREND_CANDIDATES (which references via CANDIDATE_ID, not TREND_ID).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

DELETE FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
WHERE CANDIDATE_ID IN (SELECT CANDIDATE_ID FROM _orphan_purge_candidate_ids);

-- ════════════════════════════════════════════════════════════════════════
-- 3. Verify — each of these must return 0. Inspect the output before
--    committing. If any returns > 0, type `ROLLBACK;` manually instead
--    of letting the COMMIT below run.
-- ════════════════════════════════════════════════════════════════════════
SELECT 'FCT_TRENDS_remaining'                  AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_SIGNALS_remaining'           AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_LIFECYCLE_LEDGER_remaining'  AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_ENRICHMENT_LEDGER_remaining' AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_GTRENDS_DAILY_remaining'     AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_SOURCE_METRICS_remaining'    AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'FCT_TREND_PREDICTION_LEDGER_remaining' AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'MAP_TREND_MACROTRENDS_remaining'       AS check_name,
       COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
WHERE TREND_ID IN (SELECT TREND_ID FROM _orphan_purge_targets);

SELECT 'STG_TREND_CANDIDATES_remaining'        AS check_name,
       COUNT(*) AS n
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
WHERE CANDIDATE_ID IN (SELECT CANDIDATE_ID FROM _orphan_purge_candidate_ids);

-- ════════════════════════════════════════════════════════════════════════
-- 4. Commit. If any verify above returned > 0, the operator should have
--    aborted with ROLLBACK already. Running this commits the cascade.
-- ════════════════════════════════════════════════════════════════════════
COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Post-commit confirmation — these queries hit the live tables (no
--    longer the transactional view). Should match the verify SELECTs above.
-- ════════════════════════════════════════════════════════════════════════
SELECT 'post_commit_FCT_TRENDS_orphans' AS check_name, COUNT(*) AS n
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN _orphan_purge_targets o ON o.TREND_ID = t.TREND_ID;

-- DT_TREND_DASHBOARD is a dynamic table — wait ~15 min for refresh before
-- expecting the orphan-zero-publisher count to drop. Re-run this after:
--   SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
--   WHERE DISTINCT_PUBLISHER_COUNT = 0 AND LIFECYCLE_STATUS != 'RETIRED';
