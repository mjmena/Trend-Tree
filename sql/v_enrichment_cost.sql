-- View: Enrichment cost monitoring
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Aggregates LLM token usage and cost estimates from enrichment history.
-- Useful for tracking spend over time, identifying expensive trends,
-- and optimizing the enrichment pipeline (e.g., gating low-value trends).

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_ENRICHMENT_COST AS
WITH daily_costs AS (
    SELECT
        SNAPSHOT_DATE,
        COUNT(*)                                     AS ENRICHMENTS,
        SUM(LLM_TOTAL_TOKENS)                        AS TOTAL_TOKENS,
        SUM(LLM_COST_ESTIMATE)                        AS TOTAL_COST,
        AVG(LLM_TOTAL_TOKENS)                        AS AVG_TOKENS_PER_TREND,
        AVG(LLM_COST_ESTIMATE)                        AS AVG_COST_PER_TREND,
        SUM(CASE WHEN IS_VALID_TREND THEN LLM_COST_ESTIMATE ELSE 0 END)
                                                     AS VALID_TREND_COST,
        SUM(CASE WHEN NOT IS_VALID_TREND THEN LLM_COST_ESTIMATE ELSE 0 END)
                                                     AS INVALID_TREND_COST
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
    ROUND(VALID_TREND_COST, 4)                       AS VALID_TREND_COST_USD,
    ROUND(INVALID_TREND_COST, 4)                     AS INVALID_TREND_COST_USD,

    -- Running totals
    SUM(TOTAL_COST) OVER (ORDER BY SNAPSHOT_DATE)    AS CUMULATIVE_COST_USD,
    SUM(TOTAL_TOKENS) OVER (ORDER BY SNAPSHOT_DATE)  AS CUMULATIVE_TOKENS,

    -- Waste ratio: cost spent on invalid trends
    CASE WHEN TOTAL_COST > 0
         THEN ROUND(INVALID_TREND_COST / TOTAL_COST * 100, 1)
         ELSE 0
    END                                              AS WASTE_PCT

FROM daily_costs
ORDER BY SNAPSHOT_DATE DESC;
