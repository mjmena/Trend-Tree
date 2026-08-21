-- Sourcing retrieval-query tests (CRMA-776, epic CRMA-772). Exercises the
-- EXACT query shape in sql/sourcing_retrieval_query.sql (held verbatim as
-- Q_RETRIEVAL in services/ecomm-agent/fetch_context.mjs) against real
-- FCT_TREND_ENRICHMENT_LEDGER / DIM_CATALOG_PRODUCT fixture rows.
--   ./test/run_sourcing_retrieval_tests.sh
--   (or: snow sql -c claude -f test/sourcing_retrieval.test.sql --enable-templating NONE)
--
-- Unlike test/sourcing.test.sql (which calls a real Python proc),
-- VECTOR_COSINE_SIMILARITY is pure SQL against real columns, so this file
-- follows test/connections.test.sql's approach instead: seed real rows,
-- run the production query verbatim, assert on the actual output. Vectors
-- can't be handed to Snowflake as float literals for a VECTOR(FLOAT,1024)
-- column, so a session-scoped temporary SQL function (_zz_vec2) builds a
-- 1024-dim vector with only the first two components set — cosine
-- similarity against a unit vector on dimension 0 then equals exactly
-- whatever x0 was chosen, letting every fixture score be picked in advance
-- instead of computed.
--
-- All fixture ids are prefixed 'zztest-' (TREND_ID) / 'zztest-' (Handle) so
-- this file is idempotent (self-cleans every run) and never collides with
-- the real Shopify tier's ~187 seeded products. Real catalog rows are
-- never written to — but they ARE read: an earlier version of this file
-- assumed real embeddings would score near-zero against a sparse
-- axis-aligned probe vector and asserted on raw row counts. That assumption
-- was WRONG (measured live: several real products score >= 0.40 against an
-- e1/e2 fixture vector — Cortex embeddings are not isotropic around an
-- arbitrary axis), which nondeterministically pushed fixture rows out of
-- the real LIMIT 10. The retrieval CTEs below therefore add ONE test-only
-- clause, `p.CATALOG_PRODUCT_ID LIKE 'zztest-%'`, on top of the otherwise
-- byte-for-byte production query (see the inline comment at each CTE) —
-- every filter/order/cap semantic under test is unchanged, only which rows
-- are eligible to compete for the LIMIT 10 is scoped to this file's own
-- fixtures.
--
-- Self-asserting: each check yields PASS/FALSE; the final statement forces
-- a divide-by-zero (non-zero exit) if any check fails, so CI catches
-- regressions.

USE SCHEMA MCC_PRESENTATION.TREND_AGENT;

-- ---------------------------------------------------------------------------
-- Cleanup any leftovers from a prior run of this file.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID LIKE 'zztest-retrieval-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT
WHERE CATALOG_PRODUCT_ID LIKE 'zztest-%';

-- ---------------------------------------------------------------------------
-- Vector fixture helper — session-scoped, dropped at the end of this file.
-- A 1024-dim unit-ish vector with only dims 0/1 populated: cosine against
-- e1=(1,0,0,...) equals exactly x0. x0/x1 need not be a true unit pair for
-- the e1-similarity assertions below (VECTOR_COSINE_SIMILARITY normalizes
-- by both operands' norms), but pairs ARE chosen as (x0, sqrt(1-x0^2)) so
-- e1-similarity is clean to 4 decimals.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY FUNCTION _zz_vec2(x0 FLOAT, x1 FLOAT)
RETURNS VECTOR(FLOAT, 1024)
AS
$$
  (SELECT ARRAY_AGG(CASE WHEN i = 0 THEN x0 WHEN i = 1 THEN x1 ELSE 0.0 END) WITHIN GROUP (ORDER BY i)
   FROM (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 1024))))::VECTOR(FLOAT, 1024)
$$;

-- e1 = (1, 0, ...) is the trend-side probe vector for BOTH fixture trends.
-- e2 = (0, 1, ...) is a deliberately WRONG vector planted on trend A's
-- promotion-seed row and an older 'enrichment' row, to prove the retrieval
-- query picks the latest non-promotion row and nothing else.

-- ---------------------------------------------------------------------------
-- TREND A ('zztest-retrieval-trend-a') — floor inclusivity, floor
-- exclusion, delisted exclusion, and WRITTEN_BY/latest-row selection.
-- ---------------------------------------------------------------------------

-- Three enrichment ledger rows, oldest to newest: a promotion seed (wrong
-- vector, must be excluded by WRITTEN_BY<>'promotion'), an older real
-- enrichment row (also wrong vector, must be excluded by "latest only"),
-- and the current real enrichment row (correct vector, e1).
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  (TREND_ID, WRITTEN_AT, WRITTEN_BY, ENRICHMENT_KIND, TREND_VECTOR)
SELECT 'zztest-retrieval-trend-a', DATEADD('day', -3, CURRENT_TIMESTAMP()), 'promotion', 'promotion_seed', _zz_vec2(0.0, 1.0)
UNION ALL
SELECT 'zztest-retrieval-trend-a', DATEADD('day', -2, CURRENT_TIMESTAMP()), 'enrichment', 'initial', _zz_vec2(0.0, 1.0)
UNION ALL
SELECT 'zztest-retrieval-trend-a', DATEADD('hour', -1, CURRENT_TIMESTAMP()), 'enrichment', 'refinement', _zz_vec2(1.0, 0.0);

-- Four candidates: above floor, exactly at floor, just below floor, and a
-- high-scoring but DELISTED product (must be excluded regardless of score).
INSERT INTO MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT
  (TIER, CATALOG_PRODUCT_ID, TITLE, VENDOR, PRODUCT_TYPE, TAGS, EMBED_DOC, EMBED_DOC_HASH, EMBED_DOC_VERSION, PRODUCT_VECTOR, CATALOG_STATUS, LAST_SEEN_AT)
SELECT 'shopify', 'zztest-a-above',      'ZZ Above Floor',   'ZZ Vendor', 'Test', 'zztest', 'zztest above floor doc', 'zzhash', 'v1', _zz_vec2(0.60, 0.80),         'active',   CURRENT_TIMESTAMP()
UNION ALL
SELECT 'shopify', 'zztest-a-atfloor',    'ZZ At Floor',      'ZZ Vendor', 'Test', 'zztest', 'zztest at floor doc',    'zzhash', 'v1', _zz_vec2(0.40, 0.9165151390), 'active',   CURRENT_TIMESTAMP()
UNION ALL
SELECT 'shopify', 'zztest-a-belowfloor', 'ZZ Below Floor',   'ZZ Vendor', 'Test', 'zztest', 'zztest below floor doc', 'zzhash', 'v1', _zz_vec2(0.30, 0.9539392014), 'active',   CURRENT_TIMESTAMP()
UNION ALL
SELECT 'shopify', 'zztest-a-delisted',   'ZZ Delisted High', 'ZZ Vendor', 'Test', 'zztest', 'zztest delisted doc',    'zzhash', 'v1', _zz_vec2(0.95, 0.3122498999), 'delisted', CURRENT_TIMESTAMP();

-- ---------------------------------------------------------------------------
-- TREND B ('zztest-retrieval-trend-b') — TOP_N=10 cap + score-descending
-- order, with 12 active above-floor candidates (2 must be cut by the cap).
-- ---------------------------------------------------------------------------

INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  (TREND_ID, WRITTEN_AT, WRITTEN_BY, ENRICHMENT_KIND, TREND_VECTOR)
SELECT 'zztest-retrieval-trend-b', CURRENT_TIMESTAMP(), 'enrichment', 'initial', _zz_vec2(1.0, 0.0);

INSERT INTO MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT
  (TIER, CATALOG_PRODUCT_ID, TITLE, VENDOR, PRODUCT_TYPE, TAGS, EMBED_DOC, EMBED_DOC_HASH, EMBED_DOC_VERSION, PRODUCT_VECTOR, CATALOG_STATUS, LAST_SEEN_AT)
SELECT 'shopify', 'zztest-b-01', 'ZZ B01', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.90, SQRT(1-0.90*0.90)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-02', 'ZZ B02', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.85, SQRT(1-0.85*0.85)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-03', 'ZZ B03', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.80, SQRT(1-0.80*0.80)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-04', 'ZZ B04', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.75, SQRT(1-0.75*0.75)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-05', 'ZZ B05', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.70, SQRT(1-0.70*0.70)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-06', 'ZZ B06', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.65, SQRT(1-0.65*0.65)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-07', 'ZZ B07', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.60, SQRT(1-0.60*0.60)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-08', 'ZZ B08', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.55, SQRT(1-0.55*0.55)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-09', 'ZZ B09', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.50, SQRT(1-0.50*0.50)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-10', 'ZZ B10', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.45, SQRT(1-0.45*0.45)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-11', 'ZZ B11', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.42, SQRT(1-0.42*0.42)), 'active', CURRENT_TIMESTAMP()
UNION ALL SELECT 'shopify', 'zztest-b-12', 'ZZ B12', 'ZZ Vendor', 'Test', 'zztest', 'doc', 'zzhash', 'v1', _zz_vec2(0.41, SQRT(1-0.41*0.41)), 'active', CURRENT_TIMESTAMP();

-- ---------------------------------------------------------------------------
-- Run the PRODUCTION query verbatim (sql/sourcing_retrieval_query.sql),
-- once per fixture trend, capturing full output for assertions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TEMPORARY TABLE _retrieval_a AS
WITH t AS (
  SELECT TREND_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_ID = 'zztest-retrieval-trend-a'
    AND WRITTEN_BY <> 'promotion'
    AND TREND_VECTOR IS NOT NULL
  ORDER BY WRITTEN_AT DESC
  LIMIT 1
)
SELECT
  p.CATALOG_PRODUCT_ID,
  p.TITLE            AS PRODUCT_TITLE,
  p.VENDOR,
  p.PRODUCT_TYPE,
  p.EMBED_DOC,
  ROUND(VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR), 4) AS SEMANTIC_SCORE
FROM t
JOIN MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT p
  ON p.TIER = 'shopify'
 AND p.CATALOG_STATUS = 'active'
 -- Test-only scoping: the real ~187-product Shopify catalog is NOT
 -- isotropic around a synthetic axis-aligned probe vector (measured live —
 -- several real products score >= 0.40 against e1/e2 fixture vectors), so
 -- without this the LIMIT 10 below would nondeterministically mix real
 -- products into a fixture-only assertion. Every other clause (TIER,
 -- CATALOG_STATUS, WRITTEN_BY, the floor, the ordering, the cap) is
 -- identical to sql/sourcing_retrieval_query.sql — this is the ONE
 -- addition, and it narrows rows considered, it does not change how any
 -- row is scored, filtered by floor, ordered, or capped. Scoped to THIS
 -- trend's own fixture prefix (not the shared 'zztest-%') so trend A's and
 -- trend B's candidate pools can never cross-contaminate each other.
 AND p.CATALOG_PRODUCT_ID LIKE 'zztest-a-%'
WHERE VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR) >= 0.40
ORDER BY SEMANTIC_SCORE DESC
LIMIT 10;

CREATE OR REPLACE TEMPORARY TABLE _retrieval_b AS
WITH t AS (
  SELECT TREND_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_ID = 'zztest-retrieval-trend-b'
    AND WRITTEN_BY <> 'promotion'
    AND TREND_VECTOR IS NOT NULL
  ORDER BY WRITTEN_AT DESC
  LIMIT 1
)
SELECT
  p.CATALOG_PRODUCT_ID,
  p.TITLE            AS PRODUCT_TITLE,
  p.VENDOR,
  p.PRODUCT_TYPE,
  p.EMBED_DOC,
  ROUND(VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR), 4) AS SEMANTIC_SCORE
FROM t
JOIN MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT p
  ON p.TIER = 'shopify'
 AND p.CATALOG_STATUS = 'active'
 -- Test-only scoping: the real ~187-product Shopify catalog is NOT
 -- isotropic around a synthetic axis-aligned probe vector (measured live —
 -- several real products score >= 0.40 against e1/e2 fixture vectors), so
 -- without this the LIMIT 10 below would nondeterministically mix real
 -- products into a fixture-only assertion. Every other clause (TIER,
 -- CATALOG_STATUS, WRITTEN_BY, the floor, the ordering, the cap) is
 -- identical to sql/sourcing_retrieval_query.sql — this is the ONE
 -- addition, and it narrows rows considered, it does not change how any
 -- row is scored, filtered by floor, ordered, or capped. Scoped to THIS
 -- trend's own fixture prefix (not the shared 'zztest-%') so trend A's and
 -- trend B's candidate pools can never cross-contaminate each other.
 AND p.CATALOG_PRODUCT_ID LIKE 'zztest-b-%'
WHERE VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR) >= 0.40
ORDER BY SEMANTIC_SCORE DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _retrieval_results AS
SELECT 'trend A: above-floor zztest candidate present with correct score (proves latest non-promotion vector used)' AS check_name,
       (SELECT SEMANTIC_SCORE FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-above') = 0.6000 AS pass
UNION ALL SELECT 'trend A: at-floor candidate (score exactly 0.40) IS included — floor is inclusive',
       (SELECT COUNT(*) FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-atfloor') = 1
UNION ALL SELECT 'trend A: at-floor candidate score rounds to exactly 0.4000',
       (SELECT SEMANTIC_SCORE FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-atfloor') = 0.4000
UNION ALL SELECT 'trend A: below-floor candidate (0.30) is EXCLUDED',
       (SELECT COUNT(*) FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-belowfloor') = 0
UNION ALL SELECT 'trend A: delisted candidate (0.95, CATALOG_STATUS=delisted) is EXCLUDED despite the highest score',
       (SELECT COUNT(*) FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-delisted') = 0
UNION ALL SELECT 'trend A: exactly 2 zztest candidates qualify (above + atfloor)',
       (SELECT COUNT(*) FROM _retrieval_a WHERE CATALOG_PRODUCT_ID LIKE 'zztest-a-%') = 2
UNION ALL SELECT 'trend A: if the WRONG (promotion/older) vector had been used, zztest-a-above would score 0.8000, not 0.6000 — this proves it was not',
       (SELECT SEMANTIC_SCORE FROM _retrieval_a WHERE CATALOG_PRODUCT_ID = 'zztest-a-above') != 0.8000

UNION ALL SELECT 'trend B: exactly 10 zztest candidates returned (TOP_N cap enforced, 2 of 12 qualifying dropped)',
       (SELECT COUNT(*) FROM _retrieval_b WHERE CATALOG_PRODUCT_ID LIKE 'zztest-b-%') = 10
UNION ALL SELECT 'trend B: the two lowest-scoring qualifying candidates (b-11, b-12) are excluded by the cap',
       (SELECT COUNT(*) FROM _retrieval_b WHERE CATALOG_PRODUCT_ID IN ('zztest-b-11','zztest-b-12')) = 0
UNION ALL SELECT 'trend B: returned zztest rows are in strict score-descending order (b-01 highest ... b-10 lowest kept)',
       (SELECT ARRAY_AGG(CATALOG_PRODUCT_ID) WITHIN GROUP (ORDER BY SEMANTIC_SCORE DESC)
        FROM _retrieval_b WHERE CATALOG_PRODUCT_ID LIKE 'zztest-b-%')
       = ARRAY_CONSTRUCT('zztest-b-01','zztest-b-02','zztest-b-03','zztest-b-04','zztest-b-05',
                          'zztest-b-06','zztest-b-07','zztest-b-08','zztest-b-09','zztest-b-10')
UNION ALL SELECT 'trend B: highest-scoring candidate (b-01) score rounds to 0.9000',
       (SELECT SEMANTIC_SCORE FROM _retrieval_b WHERE CATALOG_PRODUCT_ID = 'zztest-b-01') = 0.9000
;

-- Print the report (visible in snow sql output).
SELECT check_name, pass FROM _retrieval_results ORDER BY check_name;

-- ---------------------------------------------------------------------------
-- Cleanup this file's own fixtures so re-runs stay idempotent and the real
-- Shopify catalog / enrichment ledger are never left polluted. Runs BEFORE
-- the forced-failure trigger below, not after — `snow sql -f` stops at the
-- first error, so if cleanup were the last statements, a failing assertion
-- would abort the script before they ever ran, leaving zztest-* rows stuck
-- in the real DIM_CATALOG_PRODUCT / FCT_TREND_ENRICHMENT_LEDGER tables.
-- ---------------------------------------------------------------------------
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID LIKE 'zztest-retrieval-%';
DELETE FROM MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT
WHERE CATALOG_PRODUCT_ID LIKE 'zztest-%';
DROP FUNCTION IF EXISTS _zz_vec2(FLOAT, FLOAT);

-- Force a non-zero exit if anything failed (cleanup above has already run).
SELECT CASE WHEN (SELECT COUNT_IF(NOT pass OR pass IS NULL) FROM _retrieval_results) = 0
            THEN 'ALL SOURCING RETRIEVAL TESTS PASS'
            ELSE TO_VARCHAR(1/0)  -- deliberate error -> snow sql exits non-zero
       END AS result;
