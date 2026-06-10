-- Connections-agent tests. Pure-SQL logic -> SQL fixture tests (run via snowsql).
--   ./test/run_connections_tests.sh   (or: snowsql -f test/connections.test.sql)
--
-- M1 — edge-selection rule (threshold / cap / dedupe / many-to-many). The
--      cosine step is Snowflake's VECTOR_COSINE_SIMILARITY; the branching logic
--      lives downstream of `scored`, so the fixture supplies a precomputed
--      scored matrix and we run the IDENTICAL threshold+cap+dedupe chain from
--      sql/connections_edge_selection.sql against it.
-- M4 — read-surface contract: five-column shape/types + latest-run-only.
--
-- Self-asserting: each check yields PASS/FALSE; the final statement forces a
-- divide-by-zero (non-zero exit) if any check fails, so CI catches regressions.

USE SCHEMA MCC_PRESENTATION.TREND_AGENT;

-- ---------------------------------------------------------------------------
-- M1 fixture: a precomputed `scored` matrix (a_id < b_id, no self-pairs).
-- Thresholds under test match production: SAME = 0.62, CROSS = 0.45.
--   * same-cat above/below 0.62  -> kept / dropped
--   * cross-cat above/below 0.45 -> kept / dropped
--   * 'hub' has 12 same-cat qualifying neighbours (h01..h12) -> cap keeps 8
--   * leaf nodes connect only to 'hub' (each appears in exactly 1 edge)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _scored_fixture (
  a_id STRING, b_id STRING, cat_a STRING, cat_b STRING, score FLOAT
) AS
SELECT * FROM VALUES
  -- same-cat kept (>= 0.62) and dropped (< 0.62)
  ('aa01','aa02','X','X',0.70),
  ('aa01','aa03','X','X',0.55),
  -- cross-cat kept (>= 0.45) and dropped (< 0.45)
  ('aa01','zz20','X','Y',0.50),
  ('aa01','zz21','X','Y',0.40),
  -- hub with 12 qualifying same-cat neighbours (all >= 0.62, descending)
  ('h01','hub','X','X',0.95),
  ('h02','hub','X','X',0.94),
  ('h03','hub','X','X',0.93),
  ('h04','hub','X','X',0.92),
  ('h05','hub','X','X',0.91),
  ('h06','hub','X','X',0.90),
  ('h07','hub','X','X',0.89),
  ('h08','hub','X','X',0.88),
  ('h09','hub','X','X',0.87),
  ('h10','hub','X','X',0.86),
  ('h11','hub','X','X',0.85),
  ('h12','hub','X','X',0.84)
AS v(a_id,b_id,cat_a,cat_b,score);

-- The rule under test (mirrors sql/connections_edge_selection.sql post-`scored`).
CREATE OR REPLACE TEMPORARY TABLE _edges_out AS
WITH params AS (SELECT 0.62::FLOAT same_thr, 0.45::FLOAT cross_thr, 8 max_edges),
edges AS (
  SELECT s.* FROM _scored_fixture s, params p
  WHERE (s.cat_a =  s.cat_b AND s.score >= p.same_thr)
     OR (s.cat_a <> s.cat_b AND s.score >= p.cross_thr)
),
directed AS (
  SELECT a_id node, b_id other, score FROM edges
  UNION ALL SELECT b_id, a_id, score FROM edges
),
node_top AS (
  SELECT node, other FROM directed d, params p
  QUALIFY ROW_NUMBER() OVER (PARTITION BY node ORDER BY score DESC, other) <= p.max_edges
)
SELECT e.a_id, e.b_id, e.cat_a, e.cat_b, e.score
FROM edges e
WHERE EXISTS (SELECT 1 FROM node_top n WHERE n.node=e.a_id AND n.other=e.b_id)
  AND EXISTS (SELECT 1 FROM node_top n WHERE n.node=e.b_id AND n.other=e.a_id);

-- ---------------------------------------------------------------------------
-- M4 fixture: two ledger generations; latest-only must return only chain 'newB'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _ledger_fixture (
  CHAIN_ID STRING, COMPUTED_AT TIMESTAMP_NTZ,
  TREND_ID_A STRING, TREND_ID_B STRING, SCORE FLOAT, CATEGORY_A STRING, CATEGORY_B STRING
) AS
SELECT * FROM VALUES
  ('oldA','2026-06-01 00:00:00'::TIMESTAMP_NTZ,'t1','t2',0.7,'X','X'),
  ('oldA','2026-06-01 00:00:00'::TIMESTAMP_NTZ,'t1','t3',0.6,'X','Y'),
  ('newB','2026-06-02 00:00:00'::TIMESTAMP_NTZ,'t4','t5',0.8,'Y','Y'),
  ('newB','2026-06-02 00:00:00'::TIMESTAMP_NTZ,'t4','t6',0.5,'Y','X'),
  ('newB','2026-06-02 00:00:00'::TIMESTAMP_NTZ,'t5','t6',0.46,'Y','X')
AS v(CHAIN_ID,COMPUTED_AT,TREND_ID_A,TREND_ID_B,SCORE,CATEGORY_A,CATEGORY_B);

CREATE OR REPLACE TEMPORARY TABLE _latest_out AS
SELECT TREND_ID_A, TREND_ID_B, SCORE, CATEGORY_A, CATEGORY_B
FROM _ledger_fixture
WHERE CHAIN_ID = (SELECT CHAIN_ID FROM _ledger_fixture QUALIFY ROW_NUMBER() OVER (ORDER BY COMPUTED_AT DESC)=1);

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE _results AS
SELECT 'M1 same-cat above-threshold kept'      AS check_name,
       (SELECT COUNT(*) FROM _edges_out WHERE a_id='aa01' AND b_id='aa02')=1 AS pass
UNION ALL SELECT 'M1 same-cat below-threshold dropped',
       (SELECT COUNT(*) FROM _edges_out WHERE a_id='aa01' AND b_id='aa03')=0
UNION ALL SELECT 'M1 cross-cat above-threshold kept',
       (SELECT COUNT(*) FROM _edges_out WHERE a_id='aa01' AND b_id='zz20')=1
UNION ALL SELECT 'M1 cross-cat below-threshold dropped',
       (SELECT COUNT(*) FROM _edges_out WHERE a_id='aa01' AND b_id='zz21')=0
UNION ALL SELECT 'M1 per-trend cap = 8 (hub had 12 qualifying)',
       (SELECT COUNT(*) FROM _edges_out WHERE 'hub' IN (a_id,b_id))=8
UNION ALL SELECT 'M1 cap kept the 8 highest-scoring (h01..h08)',
       (SELECT COUNT(*) FROM _edges_out WHERE 'hub' IN (a_id,b_id) AND score < 0.88)=0
UNION ALL SELECT 'M1 no trend exceeds 8 edges (global)',
       (SELECT MAX(d) FROM (SELECT COUNT(*) d FROM (
          SELECT a_id n FROM _edges_out UNION ALL SELECT b_id FROM _edges_out) GROUP BY n)) <= 8
UNION ALL SELECT 'M1 dedupe: no self-pairs, a<b enforced',
       (SELECT COUNT_IF(a_id >= b_id) FROM _edges_out)=0
UNION ALL SELECT 'M1 dedupe: each undirected pair once',
       (SELECT COUNT(*) FROM (SELECT a_id,b_id FROM _edges_out GROUP BY 1,2 HAVING COUNT(*)>1))=0
UNION ALL SELECT 'M1 many-to-many: a trend appears in >1 edge',
       (SELECT MAX(d) FROM (SELECT COUNT(*) d FROM (
          SELECT a_id n FROM _edges_out UNION ALL SELECT b_id FROM _edges_out) GROUP BY n)) > 1
UNION ALL SELECT 'M4 latest-run-only: only newest generation returned',
       (SELECT COUNT(*) FROM _latest_out)=3
       AND (SELECT COUNT(*) FROM _ledger_fixture WHERE CHAIN_ID='oldA' AND (TREND_ID_A,TREND_ID_B) IN (SELECT TREND_ID_A,TREND_ID_B FROM _latest_out))=0
UNION ALL SELECT 'M4 contract: DT exposes exactly the 5 Atlas columns',
       (SELECT LISTAGG(COLUMN_NAME,',') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
        FROM MCC_PRESENTATION.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA='TREND_AGENT' AND TABLE_NAME='DT_TREND_CONNECTIONS')
       = 'TREND_ID_A,TREND_ID_B,SCORE,CATEGORY_A,CATEGORY_B'
UNION ALL SELECT 'M4 contract: SCORE is FLOAT, ids/categories are text',
       (SELECT COUNT(*) FROM MCC_PRESENTATION.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA='TREND_AGENT' AND TABLE_NAME='DT_TREND_CONNECTIONS'
          AND ((COLUMN_NAME='SCORE' AND DATA_TYPE='FLOAT')
            OR (COLUMN_NAME IN ('TREND_ID_A','TREND_ID_B','CATEGORY_A','CATEGORY_B') AND DATA_TYPE='TEXT')))=5;

-- Print the report (visible in snowsql output).
SELECT check_name, pass FROM _results ORDER BY check_name;

-- Force a non-zero exit if anything failed.
SELECT CASE WHEN (SELECT COUNT_IF(NOT pass OR pass IS NULL) FROM _results)=0
            THEN 'ALL CONNECTIONS TESTS PASS'
            ELSE TO_VARCHAR(1/0)  -- deliberate error -> snowsql exits non-zero
       END AS result;
