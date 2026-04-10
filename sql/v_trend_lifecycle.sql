-- View: Trend lifecycle management — identifies trends needing action
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Surfaces trends that are stale, expiring, or showing lifecycle changes
-- since last enrichment. Used by ops to prioritize re-enrichment and by the
-- enrichment queue task.
--
-- Source-first shape: lifecycle stage now comes from
-- FCT_TREND_METRICS.VELOCITY_DIRECTION (computed by PROC_CLUSTER_TRENDS from
-- signal velocity) rather than from an LLM-classified LIFECYCLE_STAGE column
-- on DIM_TREND_ENRICHMENT. Once a trend arrives in FCT_TREND_METRICS the
-- clustering has already validated it, so there is no validity/confidence
-- judgment to carry forward from the enrichment layer.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_LIFECYCLE AS
WITH queue_latest AS (
    SELECT TREND_ID, STATUS, RETRY_COUNT, ERROR_MESSAGE
    FROM (
        SELECT TREND_ID, STATUS, RETRY_COUNT, ERROR_MESSAGE,
               ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY QUEUED_AT DESC NULLS LAST) AS rn
        FROM MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
    ) WHERE rn = 1
),
source_summary AS (
    SELECT
        TREND_ID,
        COUNT(*)         AS SOURCE_COVERAGE_BREADTH,
        MAX(ENRICHED_AT) AS SOURCES_ENRICHED_AT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
    WHERE HEADLINE_METRIC IS NOT NULL AND HEADLINE_METRIC > 0
    GROUP BY TREND_ID
),
trend_state AS (
    SELECT
        m.TREND_ID,
        COALESCE(d.TREND_NAME_B2B, m.TREND_TOPIC)  AS TREND_NAME,
        m.TREND_HEAT_INDEX,
        m.TOTAL_CLUSTER_SIZE,
        m.VELOCITY_DIRECTION                        AS LIFECYCLE_STAGE,
        m.VELOCITY_DIRECTION,
        m.DETECTED_AT,
        m.LAST_UPDATE_AT,

        d.ENRICHED_AT,
        d.ENRICHMENT_VERSION,
        ss.SOURCES_ENRICHED_AT,
        COALESCE(ss.SOURCE_COVERAGE_BREADTH, 0)     AS SOURCE_COVERAGE_BREADTH,

        DATEDIFF('hour', m.DETECTED_AT,       CURRENT_TIMESTAMP()) AS AGE_HOURS,
        DATEDIFF('hour', m.LAST_UPDATE_AT,    CURRENT_TIMESTAMP()) AS HOURS_SINCE_UPDATE,
        DATEDIFF('hour', d.ENRICHED_AT,       CURRENT_TIMESTAMP()) AS HOURS_SINCE_ENRICHMENT,
        DATEDIFF('hour', ss.SOURCES_ENRICHED_AT, CURRENT_TIMESTAMP()) AS HOURS_SINCE_SOURCE_REFRESH,

        -- Signal momentum score derived from VELOCITY_DIRECTION
        -- (NEW|GROWING|STABLE|DECLINING|STAGNANT|SUPERSEDED)
        CASE m.VELOCITY_DIRECTION
            WHEN 'NEW'        THEN 2
            WHEN 'GROWING'    THEN 2
            WHEN 'STABLE'     THEN 1
            WHEN 'STAGNANT'   THEN 0
            WHEN 'DECLINING'  THEN -1
            WHEN 'SUPERSEDED' THEN -2
            ELSE 0
        END                                          AS VELOCITY_SCORE,

        q.STATUS       AS QUEUE_STATUS,
        q.RETRY_COUNT,
        q.ERROR_MESSAGE

    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d
        ON m.TREND_ID = d.TREND_ID
    LEFT JOIN source_summary ss
        ON m.TREND_ID = ss.TREND_ID
    LEFT JOIN queue_latest q
        ON m.TREND_ID = q.TREND_ID
)
SELECT
    *,

    CASE
        WHEN VELOCITY_DIRECTION = 'SUPERSEDED'
            THEN 'SUPERSEDED'

        WHEN ENRICHED_AT IS NULL AND TOTAL_CLUSTER_SIZE >= 3
            THEN 'NEEDS_ENRICHMENT'

        WHEN QUEUE_STATUS = 'FAILED' AND COALESCE(RETRY_COUNT, 0) < 3
            THEN 'NEEDS_RETRY'

        -- High-heat active trend with stale enrichment
        WHEN TREND_HEAT_INDEX >= 50
             AND HOURS_SINCE_ENRICHMENT > 48
             AND VELOCITY_SCORE >= 1
            THEN 'NEEDS_REFRESH'

        WHEN HOURS_SINCE_SOURCE_REFRESH > 24
             AND HOURS_SINCE_UPDATE < 24
            THEN 'SOURCES_STALE'

        -- Trend going dormant (no updates in 72h, was previously active)
        WHEN HOURS_SINCE_UPDATE > 72
             AND AGE_HOURS > 72
             AND VELOCITY_SCORE <= 0
             AND VELOCITY_DIRECTION IN ('NEW', 'GROWING')
            THEN 'GOING_DORMANT'

        -- Newly accelerating — enrichment may be out of date
        WHEN VELOCITY_SCORE >= 2
             AND VELOCITY_DIRECTION = 'NEW'
             AND HOURS_SINCE_ENRICHMENT > 24
            THEN 'LIFECYCLE_CHANGE'

        ELSE 'OK'
    END                                         AS ACTION_NEEDED,

    CASE
        WHEN VELOCITY_DIRECTION = 'SUPERSEDED' THEN 0
        WHEN ENRICHED_AT IS NULL THEN 90 + LEAST(TREND_HEAT_INDEX, 10)
        WHEN QUEUE_STATUS = 'FAILED' THEN 80
        WHEN TREND_HEAT_INDEX >= 50 AND HOURS_SINCE_ENRICHMENT > 48 THEN 70
        WHEN VELOCITY_SCORE >= 2 AND VELOCITY_DIRECTION = 'NEW' THEN 60
        WHEN HOURS_SINCE_SOURCE_REFRESH > 24 THEN 50
        WHEN HOURS_SINCE_UPDATE > 72 AND VELOCITY_SCORE <= 0 THEN 20
        ELSE 0
    END                                         AS ACTION_PRIORITY

FROM trend_state
ORDER BY
    CASE WHEN ACTION_NEEDED != 'OK' THEN 0 ELSE 1 END,
    ACTION_PRIORITY DESC;
