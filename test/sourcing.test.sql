-- Sourcing-ledger tests (CRMA-774, epic CRMA-772). Exercises
-- PROC_SOURCING_APPLY's full run lifecycle (open -> complete) against the
-- real MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER /
-- FCT_TREND_SOURCING_CANDIDATES tables.
--   ./test/run_sourcing_tests.sh   (or: snow sql -c claude -f test/sourcing.test.sql)
--
-- Unlike test/connections.test.sql (which replays pure SQL logic against a
-- fixture temp table, no live object under test), this proc's validation
-- and branching lives in Python inside PROC_SOURCING_APPLY itself, so
-- there's no equivalent pure-SQL transform to replay — these fixtures CALL
-- the real, deployed proc and assert on both its receipts and the rows it
-- actually wrote. All fixture TREND_IDs are prefixed 'zztest-sourcing-' so
-- this file is idempotent (self-cleans on every run) and its rows are easy
-- to spot in the target tables.
--
-- Self-asserting: each check yields PASS/FALSE; the final statement forces
-- a divide-by-zero (non-zero exit) if any check fails, so CI catches
-- regressions.

USE SCHEMA MCC_PRESENTATION.TREND_AGENT;

-- ---------------------------------------------------------------------------
-- Cleanup any leftovers from a prior run of this file.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
WHERE TREND_ID LIKE 'zztest-sourcing-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
WHERE TREND_ID LIKE 'zztest-sourcing-%';

-- ---------------------------------------------------------------------------
-- Case 0: OPEN-ONLY — a run that is opened and never completed, proving the
-- 'running' in-flight state is durably visible (a crash mid-run is visibly
-- stuck, not silently absent — see fct_trend_sourcing_ledger.sql). Every
-- other case below immediately follows its 'open' with a 'complete', so this
-- is the only fixture where STATUS='running' is still true once all the
-- CALLs in this script have finished and the assertions run. Also omits
-- COMPUTATION_VERSION (passes NULL) to prove the proc backfills the DDL
-- default ('v1') itself rather than writing an explicit NULL over it.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'open', NULL, 'zztest-sourcing-trend-openonly', 'shopify',
  0.40, 'gemini-3.7-flash', 'v1', NULL, 'zzsess-test-openonly',
  NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_open_openonly AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SET run_id_openonly = (
  SELECT SOURCING_RUN_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  WHERE TREND_ID = 'zztest-sourcing-trend-openonly' AND STATUS = 'running'
  ORDER BY STARTED_AT DESC LIMIT 1
);

-- ---------------------------------------------------------------------------
-- Case 1: MATCHED — header + candidate rows, some selected some not.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'open', NULL, 'zztest-sourcing-trend-matched', 'shopify',
  0.40, 'gemini-3.7-flash', 'v1', 'v1', 'zzsess-test-matched',
  NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_open_matched AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SET run_id_matched = (
  SELECT SOURCING_RUN_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  WHERE TREND_ID = 'zztest-sourcing-trend-matched' AND STATUS = 'running'
  ORDER BY STARTED_AT DESC LIMIT 1
);

CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_matched, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'matched', NULL, 'two strong tallow matches, one adjacent reject',
  PARSE_JSON('[
    {"catalog_product_id":"tallow-balm","product_handle":"tallow-balm","product_title":"Whipped Tallow Balm","product_type":"Skincare","vendor":"Homestead Co","product_url":"https://example-store.myshopify.com/products/tallow-balm","price_at_match":24.00,"image_url_at_match":"https://cdn.example.com/tallow-balm.jpg","available_at_match":true,"semantic_score":0.71,"selected":true,"reasoned_fit":"strong","reasoned_fit_rationale":"Direct tallow-based skincare match for the trend.","catalog_payload":{"tags":"skincare,tallow"}},
    {"catalog_product_id":"beef-tallow-candle","product_handle":"beef-tallow-candle","product_title":"Beef Tallow Candle","product_type":"Home","vendor":"Homestead Co","product_url":"https://example-store.myshopify.com/products/beef-tallow-candle","price_at_match":18.00,"image_url_at_match":"https://cdn.example.com/candle.jpg","available_at_match":true,"semantic_score":0.55,"selected":true,"reasoned_fit":"partial","reasoned_fit_rationale":"Shares the tallow ingredient but a different ritual object.","catalog_payload":{}},
    {"catalog_product_id":"shea-butter-lotion","product_handle":"shea-butter-lotion","product_title":"Shea Butter Lotion","product_type":"Skincare","vendor":"Homestead Co","product_url":"https://example-store.myshopify.com/products/shea-butter-lotion","price_at_match":16.00,"image_url_at_match":"https://cdn.example.com/shea.jpg","available_at_match":true,"semantic_score":0.42,"selected":false,"reasoned_fit":null,"reasoned_fit_rationale":null,"catalog_payload":{}}
  ]')
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_matched AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Case 1b: DOUBLE-COMPLETION RACE — completing the SAME already-completed
-- run_id_matched a second time must be rejected (applied=false), and must
-- NOT touch the header again or duplicate/append candidate rows. Guards the
-- UPDATE-rowcount check in PROC_SOURCING_APPLY's 'complete' branch.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_matched, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'no_match', NULL, 'second completion attempt on an already-terminal run', NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_matched_again AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Case 2: NO_MATCH — zero candidate rows, populated SELECTOR_NOTE.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'open', NULL, 'zztest-sourcing-trend-nomatch', 'shopify',
  0.40, 'gemini-3.7-flash', 'v1', 'v1', 'zzsess-test-nomatch',
  NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_open_nomatch AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SET run_id_nomatch = (
  SELECT SOURCING_RUN_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  WHERE TREND_ID = 'zztest-sourcing-trend-nomatch' AND STATUS = 'running'
  ORDER BY STARTED_AT DESC LIMIT 1
);

CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_nomatch, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'no_match', NULL, 'no product in the catalog shares this trend''s core ritual', NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_nomatch AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Case 3: FAILED — ERROR_MESSAGE set.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'open', NULL, 'zztest-sourcing-trend-failed', 'shopify',
  0.40, 'gemini-3.7-flash', 'v1', 'v1', 'zzsess-test-failed',
  NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_open_failed AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SET run_id_failed = (
  SELECT SOURCING_RUN_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  WHERE TREND_ID = 'zztest-sourcing-trend-failed' AND STATUS = 'running'
  ORDER BY STARTED_AT DESC LIMIT 1
);

CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_failed, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'failed', 'selector call timed out after 3 retries', NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_failed AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Case 4: INVALID PAYLOAD — receipt says applied:false, nothing written.
-- Opens a throwaway run, then attempts an invalid completion against it
-- (a selected candidate with no reasoned_fit), plus a second, standalone
-- invalid call with an unrecognized MODE.
-- ---------------------------------------------------------------------------
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'open', NULL, 'zztest-sourcing-trend-invalid', 'shopify',
  0.40, 'gemini-3.7-flash', 'v1', 'v1', 'zzsess-test-invalid',
  NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_open_invalid AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

SET run_id_invalid = (
  SELECT SOURCING_RUN_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  WHERE TREND_ID = 'zztest-sourcing-trend-invalid' AND STATUS = 'running'
  ORDER BY STARTED_AT DESC LIMIT 1
);

CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_invalid, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'matched', NULL, NULL,
  PARSE_JSON('[
    {"catalog_product_id":"bad-candidate","semantic_score":0.6,"selected":true,"reasoned_fit":null,"reasoned_fit_rationale":null}
  ]')
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_invalid AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'bogus_mode', NULL, 'zztest-sourcing-trend-badmode', 'shopify',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_bad_mode AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- A candidate with SELECTED=false but a non-NULL REASONED_FIT_RATIONALE —
-- rejected candidates only carry a score, never a rationale (the emit tool
-- only grades picks). Reuses run_id_invalid, still 'running' at this point.
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_invalid, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'matched', NULL, NULL,
  PARSE_JSON('[
    {"catalog_product_id":"picked-one","semantic_score":0.7,"selected":true,"reasoned_fit":"strong","reasoned_fit_rationale":"fine"},
    {"catalog_product_id":"rejected-with-rationale","semantic_score":0.5,"selected":false,"reasoned_fit":null,"reasoned_fit_rationale":"should not be allowed"}
  ]')
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_invalid_rationale AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- A 'complete' call whose caller-supplied TREND_ID doesn't match the run's
-- actual header — must be rejected rather than silently ignored. Reuses
-- run_id_invalid, still 'running' (both prior invalid attempts above failed
-- validation and wrote nothing).
CALL MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
  'complete', $run_id_invalid, 'zztest-sourcing-trend-WRONG', NULL, NULL, NULL, NULL, NULL, NULL,
  'no_match', NULL, 'trend id should not match', NULL
);
CREATE OR REPLACE TEMPORARY TABLE _recv_complete_invalid_trendid AS
  SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _sourcing_results AS
SELECT 'open(openonly) applied=true' AS check_name,
       (SELECT receipt:applied::BOOLEAN FROM _recv_open_openonly) = TRUE AS pass
UNION ALL SELECT 'open-only run stays STATUS=running, COMPLETED_AT NULL (never completed)',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_openonly AND STATUS = 'running'
          AND COMPLETED_AT IS NULL) = 1
UNION ALL SELECT 'open with COMPUTATION_VERSION=NULL backfills the v1 default, not a literal NULL',
       (SELECT COMPUTATION_VERSION = 'v1'
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_openonly)

UNION ALL SELECT 'open(matched) applied=true',
       (SELECT receipt:applied::BOOLEAN FROM _recv_open_matched) = TRUE
UNION ALL SELECT 'open(matched) returned a sourcing_run_id',
       $run_id_matched IS NOT NULL

UNION ALL SELECT 'complete(matched) applied=true',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_matched) = TRUE
UNION ALL SELECT 'matched header reaches STATUS=matched with COMPLETED_AT set',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_matched AND STATUS = 'matched' AND COMPLETED_AT IS NOT NULL) = 1
UNION ALL SELECT 'matched header CANDIDATE_COUNT=3, SELECTED_COUNT=2',
       (SELECT CANDIDATE_COUNT = 3 AND SELECTED_COUNT = 2
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_matched)
UNION ALL SELECT 'matched run wrote exactly 3 candidate rows',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_matched) = 3
UNION ALL SELECT 'matched run: 2 selected, 1 rejected',
       (SELECT COUNT_IF(SELECTED) = 2 AND COUNT_IF(NOT SELECTED) = 1
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_matched)
UNION ALL SELECT 'matched run: selected rows carry REASONED_FIT, rejects are NULL',
       (SELECT COUNT_IF(SELECTED AND REASONED_FIT IS NULL) = 0
            AND COUNT_IF(NOT SELECTED AND REASONED_FIT IS NOT NULL) = 0
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_matched)
UNION ALL SELECT 'matched run: TREND_ID/TIER denormalized onto every candidate row',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_matched
          AND TREND_ID = 'zztest-sourcing-trend-matched' AND TIER = 'shopify') = 3

UNION ALL SELECT 'double-completion race: second complete() on an already-terminal run is rejected',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_matched_again) = FALSE
UNION ALL SELECT 'double-completion race: header STATUS stays matched (not overwritten to no_match)',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_matched AND STATUS = 'matched') = 1
UNION ALL SELECT 'double-completion race: candidate rows still exactly 3 (no duplicate insert)',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_matched) = 3

UNION ALL SELECT 'open(nomatch) returned a sourcing_run_id',
       $run_id_nomatch IS NOT NULL
UNION ALL SELECT 'complete(no_match) applied=true',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_nomatch) = TRUE
UNION ALL SELECT 'no_match header reaches STATUS=no_match with SELECTOR_NOTE set',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_nomatch AND STATUS = 'no_match'
          AND SELECTOR_NOTE IS NOT NULL) = 1
UNION ALL SELECT 'no_match header CANDIDATE_COUNT=0, SELECTED_COUNT=0',
       (SELECT CANDIDATE_COUNT = 0 AND SELECTED_COUNT = 0
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_nomatch)
UNION ALL SELECT 'no_match run wrote zero candidate rows',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_nomatch) = 0

UNION ALL SELECT 'open(failed) returned a sourcing_run_id',
       $run_id_failed IS NOT NULL
UNION ALL SELECT 'complete(failed) applied=true',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_failed) = TRUE
UNION ALL SELECT 'failed header reaches STATUS=failed with ERROR_MESSAGE set',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_failed AND STATUS = 'failed'
          AND ERROR_MESSAGE IS NOT NULL) = 1
UNION ALL SELECT 'failed run wrote zero candidate rows',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_failed) = 0

UNION ALL SELECT 'open(invalid) returned a sourcing_run_id',
       $run_id_invalid IS NOT NULL
UNION ALL SELECT 'invalid completion: applied=false',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_invalid) = FALSE
UNION ALL SELECT 'invalid completion: header untouched, still running',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_invalid AND STATUS = 'running'
          AND COMPLETED_AT IS NULL) = 1
UNION ALL SELECT 'invalid completion: wrote zero candidate rows',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
        WHERE SOURCING_RUN_ID = $run_id_invalid) = 0
UNION ALL SELECT 'invalid completion (rejected candidate w/ rationale): applied=false',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_invalid_rationale) = FALSE
UNION ALL SELECT 'invalid completion (rejected candidate w/ rationale): header still running',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_invalid AND STATUS = 'running') = 1
UNION ALL SELECT 'invalid completion (mismatched TREND_ID): applied=false',
       (SELECT receipt:applied::BOOLEAN FROM _recv_complete_invalid_trendid) = FALSE
UNION ALL SELECT 'invalid completion (mismatched TREND_ID): header still running, untouched',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = $run_id_invalid AND STATUS = 'running') = 1
UNION ALL SELECT 'unknown MODE: applied=false, no header written',
       (SELECT receipt:applied::BOOLEAN FROM _recv_bad_mode) = FALSE
       AND (SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
            WHERE TREND_ID = 'zztest-sourcing-trend-badmode') = 0
;

-- Print the report (visible in snow sql output).
SELECT check_name, pass FROM _sourcing_results ORDER BY check_name;

-- Force a non-zero exit if anything failed.
SELECT CASE WHEN (SELECT COUNT_IF(NOT pass OR pass IS NULL) FROM _sourcing_results) = 0
            THEN 'ALL SOURCING TESTS PASS'
            ELSE TO_VARCHAR(1/0)  -- deliberate error -> snow sql exits non-zero
       END AS result;

-- ---------------------------------------------------------------------------
-- Cleanup this file's own fixtures so re-runs stay idempotent and the
-- table doesn't accumulate test rows across CI runs.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES
WHERE TREND_ID LIKE 'zztest-sourcing-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
WHERE TREND_ID LIKE 'zztest-sourcing-%';
