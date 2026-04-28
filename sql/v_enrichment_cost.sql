-- View: Enrichment cost monitoring (per day, derived from the ledger).
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-28 refactor: previously aggregated FCT_TREND_ENRICHMENT_HISTORY
-- (one row per trend per day). The history table was dropped in favor of
-- FCT_TREND_ENRICHMENT_LEDGER (one row per enrichment event, full payload).
-- This view bucket-aggregates the ledger by DATE_TRUNC('day', WRITTEN_AT)
-- to preserve the daily-cost shape consumers expect.
--
-- Excludes promotion_seed rows (no LLM cost) so the daily counts reflect
-- real enrichment runs only.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_ENRICHMENT_COST AS
WITH daily_costs AS (
    SELECT
        DATE_TRUNC('day', WRITTEN_AT)::DATE AS SNAPSHOT_DATE,
        COUNT(*)                            AS ENRICHMENTS,
        SUM(COALESCE(LLM_INPUT_TOKENS, 0)
            + COALESCE(LLM_OUTPUT_TOKENS, 0)) AS TOTAL_TOKENS,
        SUM(LLM_COST_ESTIMATE)              AS TOTAL_COST,
        AVG(COALESCE(LLM_INPUT_TOKENS, 0)
            + COALESCE(LLM_OUTPUT_TOKENS, 0)) AS AVG_TOKENS_PER_TREND,
        AVG(LLM_COST_ESTIMATE)              AS AVG_COST_PER_TREND
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE LLM_COST_ESTIMATE IS NOT NULL
      AND ENRICHMENT_KIND IN ('initial', 'refinement')
    GROUP BY 1
)
SELECT
    SNAPSHOT_DATE,
    ENRICHMENTS,
    TOTAL_TOKENS,
    ROUND(TOTAL_COST, 4)                             AS TOTAL_COST_USD,
    ROUND(AVG_TOKENS_PER_TREND, 0)                   AS AVG_TOKENS_PER_TREND,
    ROUND(AVG_COST_PER_TREND, 4)                     AS AVG_COST_PER_TREND_USD,
    SUM(TOTAL_COST) OVER (ORDER BY SNAPSHOT_DATE)    AS CUMULATIVE_COST_USD,
    SUM(TOTAL_TOKENS) OVER (ORDER BY SNAPSHOT_DATE)  AS CUMULATIVE_TOKENS
FROM daily_costs
ORDER BY SNAPSHOT_DATE DESC;
