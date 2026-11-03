-- PROC_PROMOTION_APPLY must promote a candidate at most once, and must error
-- on a missing candidate. CALLs the live proc, so run it after deploying the
-- proc. Fixtures are 'zztest-promotion-%' and are deleted before the final
-- assertion, so no test trend lingers. The last statement divides by zero on
-- any failed check.
--   ./test/run_promotion_apply_tests.sh

USE SCHEMA MCC_PRESENTATION.TREND_AGENT;

-- ---------------------------------------------------------------------------
-- Cleanup leftovers from an earlier run that died before its own cleanup.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                   WHERE CANDIDATE_ID LIKE 'zztest-promotion-%');
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                   WHERE CANDIDATE_ID LIKE 'zztest-promotion-%');
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';
DELETE FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';

-- One pending candidate.
INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
    (CANDIDATE_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, TOPIC,
     SUPPORTING_SIGNAL_IDS, CONFIDENCE, SOURCE_BREAKDOWN)
SELECT 'zztest-promotion-double', 'zzsess-promotion', 'zztest-promotion-chain', 1,
       'zztest tallow skincare double-apply fixture',
       ARRAY_CONSTRUCT(), 0.5, PARSE_JSON('{}');

-- ---------------------------------------------------------------------------
-- Case 1: PROMOTE_NEW the same candidate twice (the cron-vs-retrigger race,
-- serialized). The first call mints the trend; the second must error.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(
  PARSE_JSON('[{"candidate_id":"zztest-promotion-double","decision":"PROMOTE_NEW","decision_category":"CONFIRM_NEW","rationale":"zztest first apply"}]'),
  'zztest-promotion-chain', 1);
CREATE OR REPLACE TEMPORARY TABLE _recv_first AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

CALL MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(
  PARSE_JSON('[{"candidate_id":"zztest-promotion-double","decision":"PROMOTE_NEW","decision_category":"CONFIRM_NEW","rationale":"zztest second apply"}]'),
  'zztest-promotion-chain', 2);
CREATE OR REPLACE TEMPORARY TABLE _recv_second AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Case 2: PROMOTE_NEW for a candidate_id that does not exist.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(
  PARSE_JSON('[{"candidate_id":"zztest-promotion-missing","decision":"PROMOTE_NEW","decision_category":"CONFIRM_NEW","rationale":"zztest missing candidate"}]'),
  'zztest-promotion-chain', 1);
CREATE OR REPLACE TEMPORARY TABLE _recv_missing AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _promotion_apply_results AS
SELECT 'first PROMOTE_NEW: status ok with a target_trend_id' AS check_name,
       (SELECT receipt:results[0]:status::STRING = 'ok'
               AND receipt:results[0]:target_trend_id IS NOT NULL FROM _recv_first) AS pass
UNION ALL SELECT 'second PROMOTE_NEW: status error',
       (SELECT receipt:results[0]:status::STRING = 'error'
               AND receipt:promote_count::INT = 0 FROM _recv_second)
UNION ALL SELECT 'exactly one FCT_TRENDS row for the candidate',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        WHERE CANDIDATE_ID = 'zztest-promotion-double') = 1
UNION ALL SELECT 'candidate PROMOTED_TO is the first call''s trend',
       (SELECT PROMOTED_TO FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
        WHERE CANDIDATE_ID = 'zztest-promotion-double')
       = (SELECT receipt:results[0]:target_trend_id::STRING FROM _recv_first)
UNION ALL SELECT 'trend has exactly one lifecycle seed row',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
        WHERE TREND_ID = (SELECT receipt:results[0]:target_trend_id::STRING FROM _recv_first)) = 1
UNION ALL SELECT 'missing candidate: status error, no target_trend_id',
       (SELECT receipt:results[0]:status::STRING = 'error'
               AND receipt:results[0]:target_trend_id IS NULL FROM _recv_missing)
UNION ALL SELECT 'missing candidate: no FCT_TRENDS row',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        WHERE CANDIDATE_ID = 'zztest-promotion-missing') = 0
;

SELECT check_name, pass FROM _promotion_apply_results ORDER BY check_name;

-- ---------------------------------------------------------------------------
-- Cleanup before the final assertion, so a failing run still removes its
-- zztest trend from the live tables.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                   WHERE CANDIDATE_ID LIKE 'zztest-promotion-%');
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                   WHERE CANDIDATE_ID LIKE 'zztest-promotion-%');
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';
DELETE FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
WHERE CANDIDATE_ID LIKE 'zztest-promotion-%';

SELECT CASE WHEN (SELECT COUNT_IF(NOT pass OR pass IS NULL) FROM _promotion_apply_results) = 0
            THEN 'ALL PROMOTION APPLY TESTS PASS'
            ELSE TO_VARCHAR(1/0)  -- deliberate error -> snow sql exits non-zero
       END AS result;
