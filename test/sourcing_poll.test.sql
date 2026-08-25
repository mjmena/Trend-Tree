-- Fixture tests for the poll anti-join (CRMA-778, epic CRMA-772).
-- Run: ./test/run_sourcing_poll_tests.sh
--   (or: snow sql -c claude -f test/sourcing_poll.test.sql --enable-templating NONE)
--
-- Under test: sql/sourcing_poll_query.sql — which trends a tick claims. The
-- query is pure SQL over real columns, so this file follows
-- test/sourcing_retrieval.test.sql's approach: seed real rows, run the
-- production query verbatim, assert on the actual output.
--
-- The three eligibility arms each get fixtures that would be claimed if the arm
-- were missing, so a regression that deletes an arm fails here rather than
-- silently re-sourcing (or silently skipping) trends in production.
--
-- All fixture ids are prefixed 'zztest-poll-' so this file is idempotent
-- (self-cleans every run) and can never collide with real trends. Real rows are
-- never written to — but they ARE read, and there are 400+ live trends that
-- would swamp any LIMIT under test. The production query below therefore
-- carries ONE test-only clause, `e.TREND_ID LIKE 'zztest-poll-%'` (see the
-- inline comment where it appears): it narrows WHICH ROWS ARE ELIGIBLE to this
-- file's own fixtures and changes nothing about the eligibility arms, the
-- ordering, or the cap — every semantic under test is byte-for-byte production.
--
-- Self-asserting: each check yields PASS/FALSE; the final statement forces a
-- divide-by-zero (non-zero exit) if any check fails, so CI catches regressions.

USE SCHEMA MCC_PRESENTATION.TREND_AGENT;

-- ---------------------------------------------------------------------------
-- Leading cleanup — children before parents, so a previous aborted run cannot
-- leave fixtures behind that change this run's answers.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID LIKE 'zztest-poll-%';

-- ---------------------------------------------------------------------------
-- Vector fixture helper — session-scoped, dropped at the end of this file.
-- The poll query only tests TREND_VECTOR IS NOT NULL (it never scores), so any
-- valid 1024-dim vector serves. Same construction as
-- test/sourcing_retrieval.test.sql's _zz_vec2, because a VECTOR(FLOAT,1024)
-- cannot be written as a float literal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY FUNCTION _zz_poll_vec()
RETURNS VECTOR(FLOAT, 1024)
AS
$$
  (SELECT ARRAY_AGG(CASE WHEN i = 0 THEN 1.0 ELSE 0.0 END) WITHIN GROUP (ORDER BY i)
   FROM (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 1024))))::VECTOR(FLOAT, 1024)
$$;

-- ---------------------------------------------------------------------------
-- Trend identities. Every fixture except 'noidentity' gets an FCT_TRENDS row;
-- that one is the control proving the query's inner JOIN drops an enrichment
-- row whose trend has no identity.
-- ---------------------------------------------------------------------------
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS (TREND_ID, CANDIDATE_ID)
            SELECT 'zztest-poll-nolifecycle', 'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-stable',      'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-seedonly',    'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-retired',     'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-matched',     'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-nomatch',     'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-failed',      'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-running',     'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-stalerun',    'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-novector',    'zztest-poll-cand'
  UNION ALL SELECT 'zztest-poll-othertier',   'zztest-poll-cand';

-- ---------------------------------------------------------------------------
-- Enrichment rows. WRITTEN_AT values are deliberately distinct and out of
-- alphabetical order, so the oldest-enrichment-first assertion below proves
-- real ORDER BY behaviour rather than an incidental insertion order.
--
--   nolifecycle 2026-01-01   stalerun 2026-01-04
--   failed      2026-01-02   othertier 2026-01-05
--   stable      2026-01-03
-- ---------------------------------------------------------------------------
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  (ENRICHMENT_ID, TREND_ID, WRITTEN_AT, WRITTEN_BY, TREND_VECTOR)
            SELECT 'zztest-poll-e1',  'zztest-poll-nolifecycle', '2026-01-01 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e2',  'zztest-poll-failed',      '2026-01-02 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e3',  'zztest-poll-stable',      '2026-01-03 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e4',  'zztest-poll-stalerun',    '2026-01-04 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e5',  'zztest-poll-othertier',   '2026-01-05 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e6',  'zztest-poll-retired',     '2026-01-06 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e7',  'zztest-poll-matched',     '2026-01-07 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e8',  'zztest-poll-nomatch',     '2026-01-08 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  UNION ALL SELECT 'zztest-poll-e9',  'zztest-poll-running',     '2026-01-09 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec()
  -- A promotion SEED is not enrichment: topic-only vector, must never be claimed.
  UNION ALL SELECT 'zztest-poll-e10', 'zztest-poll-seedonly',    '2026-01-10 00:00:00'::TIMESTAMP_NTZ, 'promotion',  _zz_poll_vec()
  -- A real enrichment row that never got a vector is not sourceable.
  UNION ALL SELECT 'zztest-poll-e11', 'zztest-poll-novector',    '2026-01-11 00:00:00'::TIMESTAMP_NTZ, 'enrichment', NULL
  -- No FCT_TRENDS row exists for this one — the inner JOIN must drop it.
  UNION ALL SELECT 'zztest-poll-e12', 'zztest-poll-noidentity',  '2026-01-12 00:00:00'::TIMESTAMP_NTZ, 'enrichment', _zz_poll_vec();

-- ---------------------------------------------------------------------------
-- Lifecycle rows. 'retired' carries two evaluations to prove the query reads
-- the LATEST one: an older STABLE that would qualify it, and a newer RETIRED
-- that must exclude it.
-- ---------------------------------------------------------------------------
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  (LIFECYCLE_EVAL_ID, TREND_ID, EVALUATED_AT, NEW_STATUS)
            SELECT 'zztest-poll-l1', 'zztest-poll-stable',  '2026-02-01 00:00:00'::TIMESTAMP_NTZ, 'STABLE'
  UNION ALL SELECT 'zztest-poll-l2', 'zztest-poll-retired', '2026-02-01 00:00:00'::TIMESTAMP_NTZ, 'STABLE'
  UNION ALL SELECT 'zztest-poll-l3', 'zztest-poll-retired', '2026-02-02 00:00:00'::TIMESTAMP_NTZ, 'RETIRED';

-- ---------------------------------------------------------------------------
-- Sourcing headers. STARTED_AT for the two 'running' rows is relative to NOW,
-- not a literal, because staleness is measured against CURRENT_TIMESTAMP().
-- ---------------------------------------------------------------------------
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
  (SOURCING_RUN_ID, TREND_ID, TIER, STARTED_AT, STATUS)
            SELECT 'zztest-poll-h1', 'zztest-poll-matched',   'shopify', '2026-03-01 00:00:00'::TIMESTAMP_NTZ, 'matched'
  UNION ALL SELECT 'zztest-poll-h2', 'zztest-poll-nomatch',   'shopify', '2026-03-01 00:00:00'::TIMESTAMP_NTZ, 'no_match'
  -- A failed header must NOT block: the next tick retries it. No dead-letter.
  UNION ALL SELECT 'zztest-poll-h3', 'zztest-poll-failed',    'shopify', '2026-03-01 00:00:00'::TIMESTAMP_NTZ, 'failed'
  -- In flight 5 minutes ago — inside the 30-minute window, must block.
  UNION ALL SELECT 'zztest-poll-h4', 'zztest-poll-running',   'shopify', DATEADD('minute', -5,  CURRENT_TIMESTAMP()), 'running'
  -- 'running' 90 minutes ago is a crashed run: stale, re-takeable, must NOT block.
  UNION ALL SELECT 'zztest-poll-h5', 'zztest-poll-stalerun',  'shopify', DATEADD('minute', -90, CURRENT_TIMESTAMP()), 'running'
  -- A terminal header on a DIFFERENT tier must not block the shopify tier.
  UNION ALL SELECT 'zztest-poll-h6', 'zztest-poll-othertier', 'zztest-tier', '2026-03-01 00:00:00'::TIMESTAMP_NTZ, 'matched';

-- ---------------------------------------------------------------------------
-- The production query, verbatim from sql/sourcing_poll_query.sql, with the
-- LIMIT raised past the fixture count so membership and ordering are both
-- observable in one result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _poll_claimed AS
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
  WHERE TIER = 'shopify'
    AND (
          STATUS IN ('matched', 'no_match')
       OR (STATUS = 'running'
           AND STARTED_AT >= DATEADD('minute', -1 * 30, CURRENT_TIMESTAMP()))
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
  -- TEST-ONLY CLAUSE, not present in sql/sourcing_poll_query.sql. There are
  -- 400+ real live trends that qualify; without this they would fill any LIMIT
  -- and make every assertion below nondeterministic. It narrows only WHICH
  -- ROWS COMPETE — the three eligibility arms above, the ORDER BY and the
  -- LIMIT are byte-for-byte the production query.
  AND e.TREND_ID LIKE 'zztest-poll-%'
ORDER BY e.ENRICHED_AT ASC
LIMIT 100;

-- The same query capped at 2, proving the cap takes the OLDEST two rather than
-- an arbitrary two — the property that makes the backfill drain fairly.
CREATE OR REPLACE TEMPORARY TABLE _poll_capped AS
SELECT TREND_ID, ENRICHED_AT
FROM _poll_claimed
ORDER BY ENRICHED_AT ASC
LIMIT 2;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _poll_results AS
SELECT 'exactly the five eligible fixtures are claimed' AS check_name,
       (SELECT COUNT(*) FROM _poll_claimed) = 5 AS pass

UNION ALL SELECT 'a trend with NO lifecycle row yet is live and claimed (a freshly promoted trend must not be skipped)',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-nolifecycle') = 1

UNION ALL SELECT 'a STABLE trend is claimed',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-stable') = 1

UNION ALL SELECT 'a RETIRED trend is excluded, and the LATEST lifecycle row decides it (its older row said STABLE)',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-retired') = 0

UNION ALL SELECT 'a trend whose only enrichment row is a promotion SEED is excluded — a topic-only vector is not sourceable',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-seedonly') = 0

UNION ALL SELECT 'a real enrichment row with a NULL TREND_VECTOR is excluded',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-novector') = 0

UNION ALL SELECT 'an enrichment row whose trend has no FCT_TRENDS identity is dropped by the inner JOIN',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-noidentity') = 0

UNION ALL SELECT 'a matched header blocks its trend — a sourced trend is not re-sourced',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-matched') = 0

UNION ALL SELECT 'a no_match header blocks its trend just as a matched one does',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-nomatch') = 0

UNION ALL SELECT 'a FAILED header does NOT block: the next tick retries it, which is the whole self-healing requirement',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-failed') = 1

UNION ALL SELECT 'a running header 5 minutes old BLOCKS — this is the in-flight guard that stops two ticks double-firing one trend',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-running') = 0

UNION ALL SELECT 'a running header 90 minutes old does NOT block — a crashed run must never park a trend forever',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-stalerun') = 1

UNION ALL SELECT 'a terminal header on a DIFFERENT tier does not block the shopify tier',
       (SELECT COUNT(*) FROM _poll_claimed WHERE TREND_ID = 'zztest-poll-othertier') = 1

UNION ALL SELECT 'claims come back oldest-enrichment-first, so the backfill drains in order and never starves the oldest work',
       (SELECT ARRAY_AGG(TREND_ID) WITHIN GROUP (ORDER BY ENRICHED_AT ASC) FROM _poll_claimed)
         = ARRAY_CONSTRUCT('zztest-poll-nolifecycle', 'zztest-poll-failed', 'zztest-poll-stable',
                           'zztest-poll-stalerun', 'zztest-poll-othertier')

UNION ALL SELECT 'the cap takes the OLDEST two, not an arbitrary two',
       (SELECT ARRAY_AGG(TREND_ID) WITHIN GROUP (ORDER BY ENRICHED_AT ASC) FROM _poll_capped)
         = ARRAY_CONSTRUCT('zztest-poll-nolifecycle', 'zztest-poll-failed')
;

-- Print the report (visible in snow sql output).
SELECT check_name, pass FROM _poll_results ORDER BY check_name;

-- ---------------------------------------------------------------------------
-- Cleanup. Runs BEFORE the forced-failure trigger below, not after — snow sql
-- -f stops at the first error, so if cleanup were the last statements a failing
-- assertion would abort the script before they ever ran, leaving zztest-* rows
-- stuck in the real tables.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID LIKE 'zztest-poll-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID LIKE 'zztest-poll-%';
DROP FUNCTION IF EXISTS _zz_poll_vec();

SELECT CASE WHEN (SELECT COUNT_IF(NOT pass OR pass IS NULL) FROM _poll_results) = 0
            THEN 'ALL SOURCING POLL TESTS PASS'
            ELSE TO_VARCHAR(1/0)  -- deliberate error -> snow sql exits non-zero
       END AS result;
