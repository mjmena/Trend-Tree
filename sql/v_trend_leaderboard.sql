-- View: Trend leaderboard — ranked by heat index (source-first)
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Quick-reference ranking of active, enriched trends sorted by
-- FCT_TREND_METRICS.TREND_HEAT_INDEX. Designed for editorial standups
-- and content prioritization. Surfaces names, short summary, source
-- coverage, and top signals for fast scanning. Source breadth (live
-- count from FCT_TREND_SOURCE_METRICS) is a secondary tiebreaker.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_LEADERBOARD AS
WITH source_agg AS (
    SELECT
        TREND_ID,
        ARRAY_AGG(SOURCE_NAME)     AS SOURCE_NAMES,
        COUNT(*)                   AS SOURCE_COUNT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
    WHERE HEADLINE_METRIC IS NOT NULL AND HEADLINE_METRIC > 0
    GROUP BY TREND_ID
),
signal_evidence AS (
    -- Top 3 signal titles per trend by PageRank
    SELECT
        TREND_ID,
        ARRAY_AGG(TITLE) WITHIN GROUP (ORDER BY PAGERANK_SCORE DESC) AS TOP_SIGNAL_TITLES
    FROM (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC NULLS LAST) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
    )
    WHERE rn <= 3
    GROUP BY TREND_ID
)
SELECT
    -- Identity & description
    m.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, m.TREND_TOPIC) AS TREND_NAME,
    d.TREND_NAME_B2B,
    d.TREND_NAME_B2C,
    d.SUMMARY_SHORT,
    d.CATEGORY,
    d.SUBCATEGORY,

    -- Scores
    m.TREND_HEAT_INDEX,

    -- Pipeline metrics
    m.VELOCITY_DIRECTION,
    m.TOTAL_CLUSTER_SIZE,
    m.DISTINCT_SOURCE_COUNT,

    -- Source evidence (live count from FCT_TREND_SOURCE_METRICS)
    sa.SOURCE_NAMES,
    COALESCE(sa.SOURCE_COUNT, 0)                     AS SOURCE_COVERAGE_BREADTH,
    sig.TOP_SIGNAL_TITLES,

    -- Temporal
    m.DETECTED_AT,
    m.LAST_UPDATE_AT,
    DATEDIFF('hour', m.DETECTED_AT, m.LAST_UPDATE_AT)  AS TREND_AGE_HOURS,

    -- Rank within category
    ROW_NUMBER() OVER (
        PARTITION BY d.CATEGORY
        ORDER BY m.TREND_HEAT_INDEX DESC
    )                                                AS CATEGORY_RANK

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d
    ON m.TREND_ID = d.TREND_ID
LEFT JOIN source_agg sa
    ON m.TREND_ID = sa.TREND_ID
LEFT JOIN signal_evidence sig
    ON m.TREND_ID = sig.TREND_ID
WHERE d.ENRICHED_AT IS NOT NULL
ORDER BY m.TREND_HEAT_INDEX DESC, COALESCE(sa.SOURCE_COUNT, 0) DESC;
