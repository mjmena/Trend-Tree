-- Generate via run_promotion_lifecycle_tests.sh; every write is session-local.
-- LIKE copies live column definitions, never rows. Cortex output is deterministic.
-- FIXTURE_TABLES

CREATE OR REPLACE TEMPORARY FUNCTION _zz_apply_complete(model VARCHAR, prompt VARCHAR)
RETURNS VARCHAR AS $$ 'fixture keyword' $$;
CREATE OR REPLACE TEMPORARY FUNCTION _zz_apply_embed(model VARCHAR, topic VARCHAR)
RETURNS VECTOR(FLOAT, 1024) AS $$
  (SELECT ARRAY_AGG(IFF(i = 0, 1.0, 0.0)) WITHIN GROUP (ORDER BY i)
   FROM (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 1024))))::VECTOR(FLOAT, 1024)
$$;

INSERT INTO _zz_apply_candidates
  (CANDIDATE_ID, TOPIC, SUPPORTING_SIGNAL_IDS, SOURCE_BREAKDOWN, CONFIDENCE, AGENT_SESSION_ID, CHAIN_ID)
SELECT column1, 'fixture topic', PARSE_JSON('["signal-a","signal-b","signal-c"]'),
       PARSE_JSON('{"news":2,"social":1}'), 0.8, 'fixture-session', 'fixture-chain'
FROM VALUES ('leader'), ('follower'), ('reject-leader'), ('reject-follower'),
            ('defer-leader'), ('defer-follower'), ('undecided'), ('unresolved-follower'), ('missing-leader-follower');

-- Followers precede leaders to exercise the procedure's dependency ordering.
-- PROMOTION_UNDER_TEST
CALL promotion_fixture(PARSE_JSON('[
  {"candidate_id":"follower","decision":"MERGE_INTO_CANDIDATE","target_candidate_id":"leader"},
  {"candidate_id":"reject-follower","decision":"MERGE_INTO_CANDIDATE","target_candidate_id":"reject-leader"},
  {"candidate_id":"defer-follower","decision":"MERGE_INTO_CANDIDATE","target_candidate_id":"defer-leader"},
  {"candidate_id":"leader","decision":"PROMOTE_NEW","et_was_second_source":true,"et_corroboration":{"matched":true,"keyword":"fixture","absolute_volume":100}},
  {"candidate_id":"reject-leader","decision":"REJECT","rejection_reason":"too broad"},
  {"candidate_id":"defer-leader","decision":"DEFER","defer_reason":"needs evidence"}
]'), 'promotion-first', 1);
CREATE OR REPLACE TEMPORARY TABLE _zz_apply_first AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

CREATE OR REPLACE TEMPORARY TABLE _zz_apply_checks (check_name VARCHAR, pass BOOLEAN) AS
SELECT 'all leader/follower decisions succeed' AS check_name,
       (SELECT receipt:applied_count::INT = 6 AND receipt:error_count::INT = 0 FROM _zz_apply_first) AS pass
UNION ALL SELECT 'promoted follower shares leader identity and dedup link',
  (SELECT COUNT(*) FROM _zz_apply_candidates f JOIN _zz_apply_candidates l
   ON f.PROMOTED_TO = l.PROMOTED_TO AND f.DEDUP_OF_TREND_ID = l.PROMOTED_TO
   WHERE f.CANDIDATE_ID = 'follower' AND l.CANDIDATE_ID = 'leader' AND f.PROMOTED_AT IS NOT NULL) = 1
UNION ALL SELECT 'a rejected leader causes a rejected follower, without promoting it',
  (SELECT COUNT(*) FROM _zz_apply_candidates WHERE CANDIDATE_ID = 'reject-follower'
   AND REJECTED_AT IS NOT NULL AND PROMOTED_AT IS NULL
   AND REJECTION_REASON = 'leader_reject-leader_rejected: too broad') = 1
UNION ALL SELECT 'a deferred leader causes a deferred follower, without promoting it',
  (SELECT COUNT(*) FROM _zz_apply_candidates WHERE CANDIDATE_ID = 'defer-follower'
   AND DEFERRED_UNTIL > CURRENT_TIMESTAMP() AND PROMOTED_AT IS NULL AND REJECTED_AT IS NULL
   AND DEFER_REASON = 'leader_defer-leader_deferred: needs evidence') = 1;

-- PROMOTION_UNDER_TEST
CALL promotion_fixture(PARSE_JSON('[{"candidate_id":"leader","decision":"PROMOTE_NEW","et_was_second_source":true,"et_corroboration":{"matched":true,"keyword":"fixture","absolute_volume":100}}]'), 'promotion-retry', 2);
CREATE OR REPLACE TEMPORARY TABLE _zz_apply_retry AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- PROMOTION_UNDER_TEST
CALL promotion_fixture(PARSE_JSON('[{"candidate_id":"missing","decision":"PROMOTE_NEW"}]'), 'promotion-missing', 3);
CREATE OR REPLACE TEMPORARY TABLE _zz_apply_missing AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

-- PROMOTION_UNDER_TEST
CALL promotion_fixture(PARSE_JSON('[
  {"candidate_id":"unresolved-follower","decision":"MERGE_INTO_CANDIDATE","target_candidate_id":"undecided"},
  {"candidate_id":"missing-leader-follower","decision":"MERGE_INTO_CANDIDATE","target_candidate_id":"absent"}
]'), 'promotion-unresolved', 4);
CREATE OR REPLACE TEMPORARY TABLE _zz_apply_unresolved AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

INSERT INTO _zz_apply_checks
SELECT 'second PROMOTE_NEW reports a decision error',
  (SELECT receipt:results[0]:status::VARCHAR = 'error' AND receipt:promote_count::INT = 0 FROM _zz_apply_retry)
UNION ALL SELECT 'double promotion creates exactly one trend',
  (SELECT COUNT(*) FROM _zz_apply_trends WHERE CANDIDATE_ID = 'leader') = 1
UNION ALL SELECT 'candidate retains the first promoted identity',
  (SELECT c.PROMOTED_TO = r.receipt:results[0]:target_trend_id::VARCHAR
   FROM _zz_apply_candidates c CROSS JOIN _zz_apply_first r WHERE c.CANDIDATE_ID = 'leader')
UNION ALL SELECT 'promotion seeds lifecycle exactly once',
  (SELECT COUNT(*) FROM _zz_apply_lifecycle) = 1
  AND (SELECT COUNT(*) FROM _zz_apply_lifecycle WHERE NEW_STATUS = 'NEW' AND AGENT_SESSION_ID = 'promotion') = 1
UNION ALL SELECT 'promotion seeds enrichment exactly once',
  (SELECT COUNT(*) FROM _zz_apply_enrichment) = 1
  AND (SELECT COUNT(*) FROM _zz_apply_enrichment WHERE WRITTEN_BY = 'promotion' AND TREND_VECTOR IS NOT NULL) = 1
UNION ALL SELECT 'promotion seeds ET exactly once',
  (SELECT COUNT(*) FROM _zz_apply_et) = 1
  AND (SELECT COUNT(*) FROM _zz_apply_et WHERE CANDIDATE_ID = 'leader' AND MATCHED) = 1
UNION ALL SELECT 'missing candidate reports an error and creates no trend',
  (SELECT receipt:results[0]:status::VARCHAR = 'error' FROM _zz_apply_missing)
  AND (SELECT COUNT(*) FROM _zz_apply_trends WHERE CANDIDATE_ID = 'missing') = 0
UNION ALL SELECT 'missing and undecided leaders report errors and leave followers pending',
  (SELECT receipt:error_count::INT = 2 AND receipt:applied_count::INT = 0 FROM _zz_apply_unresolved)
  AND (SELECT COUNT(*) FROM _zz_apply_candidates
       WHERE CANDIDATE_ID IN ('unresolved-follower', 'missing-leader-follower')
         AND PROMOTED_AT IS NULL AND REJECTED_AT IS NULL AND DEFERRED_UNTIL IS NULL) = 2
UNION ALL SELECT 'every decision including errors is audited',
  (SELECT COUNT(*) FROM _zz_apply_audit) = 10;

INSERT INTO _zz_apply_lifecycle (TREND_ID, EVALUATED_AT, NEW_STATUS, NEW_HEAT, NEW_HEAT_SMOOTHED)
VALUES ('retire-twice', '2000-01-01'::TIMESTAMP_NTZ, 'DORMANT', 10, 10),
       ('interrupted', '2000-01-01'::TIMESTAMP_NTZ, 'STABLE', 50, 50);

-- LIFECYCLE_UNDER_TEST
CALL lifecycle_fixture(PARSE_JSON('[
  {"trend_id":"retire-twice","heat_base":10,"lifecycle_decision":{"status":"RETIRED","retirement_reason":"quiet","next_eval_in_hours":1}},
  {"trend_id":"interrupted","heat_base":50,"lifecycle_decision":{"status":"RETIRED","retirement_reason":"quiet","next_eval_in_hours":1}}
]'), 'lifecycle-first', TRUE);
CREATE OR REPLACE TEMPORARY TABLE _zz_lifecycle_first AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

INSERT INTO _zz_apply_checks
SELECT 'first retirement proposals are recorded without retiring either trend',
  (SELECT receipt:applied_count::INT = 2 AND receipt:retire_proposals::INT = 2
          AND receipt:retire_committed::INT = 0 FROM _zz_lifecycle_first)
  AND (SELECT COUNT(*) FROM _zz_apply_lifecycle WHERE CHAIN_ID = 'lifecycle-first'
       AND NEW_STATUS = PRIOR_STATUS AND RETIREMENT_PROPOSAL IS NOT NULL
       AND NEXT_EVAL_AT IS NOT NULL) = 2;

-- Make the prior ordering independent of the warehouse clock's precision.
UPDATE _zz_apply_lifecycle SET EVALUATED_AT = '2001-01-01'::TIMESTAMP_NTZ
WHERE CHAIN_ID = 'lifecycle-first';

-- LIFECYCLE_UNDER_TEST
CALL lifecycle_fixture(PARSE_JSON('[
  {"trend_id":"retire-twice","heat_base":10,"lifecycle_decision":{"status":"RETIRED","retirement_reason":"still quiet","next_eval_in_hours":1}},
  {"trend_id":"interrupted","heat_base":50,"lifecycle_decision":{"status":"STABLE","next_eval_in_hours":1}}
]'), 'lifecycle-second', TRUE);
CREATE OR REPLACE TEMPORARY TABLE _zz_lifecycle_second AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

INSERT INTO _zz_apply_checks
SELECT 'two consecutive proposals commit RETIRED and stop scheduling',
  (SELECT receipt:applied_count::INT = 2 AND receipt:retire_committed::INT = 1
          AND receipt:retire_proposals::INT = 0 FROM _zz_lifecycle_second)
  AND (SELECT COUNT(*) FROM _zz_apply_lifecycle WHERE TREND_ID = 'retire-twice'
       AND CHAIN_ID = 'lifecycle-second' AND NEW_STATUS = 'RETIRED'
       AND PRIOR_STATUS = 'DORMANT' AND NEXT_EVAL_AT IS NULL) = 1
UNION ALL SELECT 'an intervening non-retirement clears the proposal',
  (SELECT COUNT(*) FROM _zz_apply_lifecycle WHERE TREND_ID = 'interrupted'
   AND CHAIN_ID = 'lifecycle-second' AND NEW_STATUS = 'STABLE'
   AND RETIREMENT_PROPOSAL IS NULL) = 1;

UPDATE _zz_apply_lifecycle SET EVALUATED_AT = '2002-01-01'::TIMESTAMP_NTZ
WHERE CHAIN_ID = 'lifecycle-second';

-- LIFECYCLE_UNDER_TEST
CALL lifecycle_fixture(PARSE_JSON('[{"trend_id":"interrupted","heat_base":50,"lifecycle_decision":{"status":"RETIRED","next_eval_in_hours":1}}]'), 'lifecycle-third', TRUE);
CREATE OR REPLACE TEMPORARY TABLE _zz_lifecycle_third AS
SELECT $1 AS receipt FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

INSERT INTO _zz_apply_checks
SELECT 'nonconsecutive retirement proposals do not retire the trend',
  (SELECT receipt:applied_count::INT = 1 AND receipt:retire_proposals::INT = 1
          AND receipt:retire_committed::INT = 0 FROM _zz_lifecycle_third)
  AND (SELECT COUNT(*) FROM _zz_apply_lifecycle WHERE TREND_ID = 'interrupted'
       AND CHAIN_ID = 'lifecycle-third' AND NEW_STATUS = 'STABLE'
       AND RETIREMENT_PROPOSAL IS NOT NULL) = 1;

SELECT check_name, pass FROM _zz_apply_checks ORDER BY check_name;
SELECT 1 / IFF(COUNT_IF(NOT pass OR pass IS NULL) = 0, 1, 0) AS all_checks_passed
FROM _zz_apply_checks;
