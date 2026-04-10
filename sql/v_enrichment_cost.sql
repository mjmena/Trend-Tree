-- View: Enrichment cost monitoring
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Aggregates LLM token usage and cost estimates from enrichment history.
-- Useful for tracking spend over time and identifying expensive trends.
--
-- Note: the valid/invalid cost split was removed in the source-first
-- cutover — clustering in FCT_TREND_METRICS is now the sole validator,
-- so every enriched trend is a valid trend by definition and there is
-- no "waste" category to track.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_ENRICHMENT_COST AS
WITH daily_costs AS (
    SELECT
        SNAPSHOT_DATE,
        COUNT(*)                                     AS ENRICHMENTS,
        SUM(LLM_TOTAL_TOKENS)                        AS TOTAL_TOKENS,
        SUM(LLM_COST_ESTIMATE)                       AS TOTAL_COST,
        AVG(LLM_TOTAL_TOKENS)                        AS AVG_TOKENS_PER_TREND,
        AVG(LLM_COST_ESTIMATE)                       AS AVG_COST_PER_TREND
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_HISTORY
    WHERE LLM_COST_ESTIMATE IS NOT NULL
    GROUP BY SNAPSHOT_DATE
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
