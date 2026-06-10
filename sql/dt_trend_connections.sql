-- DT_TREND_CONNECTIONS (M4) — the Atlas-facing read surface.
--
-- Exposes ONLY the latest recompute generation from FCT_TREND_CONNECTIONS_LEDGER
-- in Atlas's exact connection-service contract:
--   (trend_id_a, trend_id_b, score, category_a, category_b)
-- This is the object Atlas's connection service queries directly — it replaces
-- their in-container MiniLM-384 `trend_correlations` Postgres table. The ledger
-- underneath is internal; Atlas never reconstructs "latest" itself.
--
-- "Latest" = all rows of the generation with the most recent COMPUTED_AT
-- (CURRENT_TIMESTAMP is constant within the agent's single INSERT...SELECT, so a
-- generation shares one COMPUTED_AT and maps 1:1 to its CHAIN_ID). A fresh cron
-- or manual run appends a new generation and this table flips to it on refresh.
--
-- Many-to-many is structural: a trend id appears as TREND_ID_A or TREND_ID_B in
-- up to MAX_EDGES_PER_TREND (8) rows.
--
-- Config mirrors DT_TREND_DASHBOARD (same warehouse, 15-min lag, AUTO refresh).

CREATE OR REPLACE DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_CONNECTIONS
  TARGET_LAG   = '15 minutes'
  WAREHOUSE    = TREND_AGENT_WH
  REFRESH_MODE = AUTO
  INITIALIZE   = ON_SCHEDULE
AS
SELECT
  TREND_ID_A AS TREND_ID_A,
  TREND_ID_B AS TREND_ID_B,
  SCORE      AS SCORE,
  CATEGORY_A AS CATEGORY_A,
  CATEGORY_B AS CATEGORY_B
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONNECTIONS_LEDGER
WHERE CHAIN_ID = (
  SELECT CHAIN_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONNECTIONS_LEDGER
  QUALIFY ROW_NUMBER() OVER (ORDER BY COMPUTED_AT DESC) = 1
);
