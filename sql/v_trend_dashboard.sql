-- View: Dashboard — one row per trend with all fields needed for the UI
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Stable schema for the Trend Agent dashboard. Each row powers one trend card.
-- KEY_DATA_POINTS is populated from per-source headline metrics in
-- FCT_TREND_SOURCE_METRICS. ENGAGEMENT_METRICS remains a placeholder empty
-- array and will be populated as social integrations mature.
--
-- Usage:
--   SELECT * FROM V_TREND_DASHBOARD ORDER BY HEAT_INDEX DESC LIMIT 25;
--   SELECT * FROM V_TREND_DASHBOARD WHERE CATEGORY = 'Wellness';

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_DASHBOARD AS
WITH top_signals AS (
    SELECT TREND_ID,
           ARRAY_AGG(OBJECT_CONSTRUCT(
               'title', TITLE,
               'url', URL,
               'source', SIGNAL_NAME,
               'pagerank_score', ROUND(PAGERANK_SCORE, 3)
           )) WITHIN GROUP (ORDER BY PAGERANK_SCORE DESC) AS TOP_SIGNALS
    FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
        WHERE PAGERANK_SCORE IS NOT NULL
    )
    WHERE rn <= 5
    GROUP BY TREND_ID
),
macro_tags AS (
    SELECT TREND_ID,
           ARRAY_AGG(MACROTREND_NAME) WITHIN GROUP (ORDER BY RELEVANCE_SCORE DESC) AS MACROTREND_TAGS
    FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
    GROUP BY TREND_ID
),
related AS (
    SELECT TREND_ID, RELATED_TRENDS
    FROM MCC_PRESENTATION.TREND_AGENT.V_TREND_TAXONOMY
)
SELECT
    -- Card header
    m.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, m.TREND_TOPIC) AS TREND_NAME,
    d.CATEGORY,
    d.SUBCATEGORY,
    mt.MACROTREND_TAGS,
    d.SUMMARY_SHORT,
    d.SUMMARY_LONG,
    ROUND(m.TREND_HEAT_INDEX, 1)                 AS HEAT_INDEX,
    m.TOTAL_CLUSTER_SIZE,
    m.VELOCITY_DIRECTION,

    -- Key data points (per-source headline metrics)
    (SELECT ARRAY_AGG(
         OBJECT_CONSTRUCT(
             'source', sm.SOURCE_NAME,
             'metric_name', sm.HEADLINE_METRIC_NAME,
             'metric_value', sm.HEADLINE_METRIC
         )
     ) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS sm
       WHERE sm.TREND_ID = m.TREND_ID
         AND sm.HEADLINE_METRIC IS NOT NULL
         AND sm.HEADLINE_METRIC > 0
    )                                            AS KEY_DATA_POINTS,

    -- Engagement metrics (placeholder — populate as social integrations mature)
    PARSE_JSON('[]')                             AS ENGAGEMENT_METRICS,

    -- Top 5 signals by PageRank
    ts.TOP_SIGNALS,

    -- Related trends (vector similarity from taxonomy view)
    r.RELATED_TRENDS

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d ON m.TREND_ID = d.TREND_ID
LEFT JOIN top_signals ts  ON m.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt   ON m.TREND_ID = mt.TREND_ID
LEFT JOIN related r       ON m.TREND_ID = r.TREND_ID;
