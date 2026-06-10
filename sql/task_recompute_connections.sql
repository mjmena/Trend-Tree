-- TASK_RECOMPUTE_CONNECTIONS (issue #51) — the deterministic, no-LLM scheduled
-- runner for the Connections edge set. Replaces the planned prediction-agent
-- clone: the recompute is pure SQL, so a native Snowflake task runs it in-
-- warehouse with no Pipedream workflow / lambda / UI-created shell.
--
-- Each fire recomputes the FULL pairwise matrix from current latest-vectors and
-- appends one generation (tagged with a fresh CHAIN_ID + COMPUTED_AT) to
-- FCT_TREND_CONNECTIONS_LEDGER. DT_TREND_CONNECTIONS flips to the newest
-- generation on its next refresh. Because every run reads the latest vector per
-- trend, this inherently covers newly promoted trends AND trends whose vector
-- drifted via re-enrichment — no event wiring needed for v1 (issue #48 US 11/12).
--
-- This is the EDGE-SELECTION RULE (M1) + its calibrated thresholds (issue #50);
-- the task body is the single source of truth for the rule.
--
-- Edge-selection (generalizes dt_trend_dashboard.sql's pairwise_similarity CTE):
--   1. latest non-null TREND_VECTOR per trend from FCT_TREND_ENRICHMENT_LEDGER
--      (the issue's FCT_TRENDS.TREND_VECTOR fallback is moot — that column was
--      dropped in the 2026-04-28 refactor; all live trends carry a ledger vector);
--   2. cross join -> VECTOR_COSINE_SIMILARITY, undirected dedupe (a_id < b_id);
--   3. category-aware threshold (frozen FCT_TRENDS.CATEGORY);
--   4. per-trend cap MAX_EDGES_PER_TREND = 8 via MUTUAL top-8 (only formulation
--      that strictly guarantees "no trend exceeds 8 edges").
--
-- Thresholds calibrated for snowflake-arctic-embed-l-v2 (1024-dim), NOT Atlas's
-- MiniLM-384 constants (0.55/0.38):
--   * CROSS = 0.45 (between cross-cat cosine p95=0.416 / p99=0.501; admits the
--     prized Fibermaxxing<->Crock Awakening pair @ 0.5915, cuts the p90=0.38 floor)
--   * SAME  = 0.62 (between same-cat p95=0.558 / p99=0.713; higher bar so same-cat
--     noise is suppressed). Live sample: ~454 edges / 211 trends / ~79% cross-cat.
--
-- CHAIN_ID: CURRENT_TIMESTAMP() is constant within a statement, so every row of
-- one run shares the same generation tag (UUID_STRING() would NOT — it is
-- evaluated per row).
--
-- Manual run / backfill: `EXECUTE TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONNECTIONS;`
--
-- OWNERSHIP: the task MUST end up owned by MARKETING_ENGINEER — that is the only
-- role here holding BOTH the account-level EXECUTE TASK privilege AND USAGE on
-- MARKETING_WH. CREATE TASK lands ownership on the schema-owning role
-- MCC_PRESENTATION_TREND_AGENT_SFULL regardless of USE ROLE (and a task it owns
-- fails at runtime: "EXECUTE TASK privilege must be granted to owner role" /
-- "USAGE privilege on the task's warehouse must be granted to owner role"). So
-- we transfer ownership while the task is still SUSPENDED, then resume as the
-- new owner. This matches the live MARKETING_TASK_* tasks here (see the
-- secondary-roles-mask-grants gotcha). Warehouse MARKETING_WH matches them too.

CREATE OR REPLACE TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONNECTIONS
  WAREHOUSE = MARKETING_WH
  SCHEDULE  = 'USING CRON 0 16 * * * UTC'   -- daily 16:00 UTC (clear of audit 13:00 / prediction 14:00)
  COMMENT   = 'issue #51 — daily full-matrix Connections recompute -> FCT_TREND_CONNECTIONS_LEDGER'
AS
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONNECTIONS_LEDGER (
  CHAIN_ID, TREND_ID_A, TREND_ID_B, SCORE, CATEGORY_A, CATEGORY_B,
  INPUT_SAME_THRESHOLD, INPUT_CROSS_THRESHOLD
)
WITH params AS (
  SELECT 0.62::FLOAT AS same_cat_threshold,
         0.45::FLOAT AS cross_cat_threshold,
         8           AS max_edges_per_trend
),
latest_vectors AS (
  SELECT e.TREND_ID, e.TREND_VECTOR, t.CATEGORY
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER e
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = e.TREND_ID
  WHERE e.TREND_VECTOR IS NOT NULL
    AND t.CATEGORY IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY e.TREND_ID ORDER BY e.WRITTEN_AT DESC) = 1
),
scored AS (
  SELECT a.TREND_ID AS a_id, b.TREND_ID AS b_id,
         a.CATEGORY AS cat_a, b.CATEGORY AS cat_b,
         ROUND(VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR)::FLOAT, 4) AS score
  FROM latest_vectors a
  JOIN latest_vectors b ON a.TREND_ID < b.TREND_ID
),
edges AS (
  SELECT s.* FROM scored s, params p
  WHERE (s.cat_a =  s.cat_b AND s.score >= p.same_cat_threshold)
     OR (s.cat_a <> s.cat_b AND s.score >= p.cross_cat_threshold)
),
directed AS (
  SELECT a_id AS node, b_id AS other, score FROM edges
  UNION ALL
  SELECT b_id AS node, a_id AS other, score FROM edges
),
node_top AS (
  SELECT node, other
  FROM directed d, params p
  QUALIFY ROW_NUMBER() OVER (PARTITION BY node ORDER BY score DESC, other) <= p.max_edges_per_trend
)
SELECT
  'conn-task-' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDDHH24MISSFF3') AS CHAIN_ID,
  e.a_id                AS TREND_ID_A,
  e.b_id                AS TREND_ID_B,
  e.score               AS SCORE,
  e.cat_a               AS CATEGORY_A,
  e.cat_b               AS CATEGORY_B,
  p.same_cat_threshold  AS INPUT_SAME_THRESHOLD,
  p.cross_cat_threshold AS INPUT_CROSS_THRESHOLD
FROM edges e, params p
WHERE EXISTS (SELECT 1 FROM node_top n WHERE n.node = e.a_id AND n.other = e.b_id)
  AND EXISTS (SELECT 1 FROM node_top n WHERE n.node = e.b_id AND n.other = e.a_id);

-- Transfer ownership to MARKETING_ENGINEER while the task is still suspended
-- (CREATE leaves it suspended). COPY CURRENT GRANTS preserves any existing grants.
USE ROLE MCC_PRESENTATION_TREND_AGENT_SFULL;
GRANT OWNERSHIP ON TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONNECTIONS
  TO ROLE MARKETING_ENGINEER COPY CURRENT GRANTS;

-- Resume as the new owner to activate the daily schedule.
USE SECONDARY ROLES NONE;
USE ROLE MARKETING_ENGINEER;
ALTER TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONNECTIONS RESUME;
