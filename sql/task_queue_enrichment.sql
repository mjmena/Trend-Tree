-- Task: Queue trends for enrichment when new/updated
-- Database: MCC_RAW.MARKETING_DEV
-- Runs: after TASK_CLUSTER_TRENDS (chained)
--
-- Policy (2026-04-10):
--   Every trend in FCT_TREND_METRICS must have DIM enrichment data.
--   Velocity direction no longer affects the initial enrichment type —
--   even DECLINING/STAGNANT trends get a full DIM row on first pass.
--   SOURCES_ONLY is only used as a cheap refresh for trends that already
--   have a DIM row but whose source metrics are stale (>24h old).
--
-- Detects trends that need enrichment based on:
-- 1. NEW:           no DIM row yet → FULL
-- 2. UPDATED:       new signals since last enrichment → FULL
-- 3. STALE_SOURCES: already enriched but source data >24h old → SOURCES_ONLY

CREATE OR REPLACE TASK MCC_RAW.MARKETING_DEV.TASK_QUEUE_ENRICHMENT
    WAREHOUSE = MARKETING_WH
    AFTER MCC_RAW.MARKETING_DEV.TASK_CLUSTER_TRENDS
AS
MERGE INTO MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE AS target
USING (
    WITH ENRICHMENT_STATUS AS (
        SELECT
            m.TREND_ID,
            m.TREND_TOPIC,
            m.TOTAL_CLUSTER_SIZE,
            m.TREND_HEAT_INDEX,
            m.VELOCITY_DIRECTION,
            m.LAST_UPDATE_AT,
            m.DETECTED_AT,
            e.ENRICHED_AT AS LAST_ENRICHED_AT,
            s.ENRICHED_AT AS LAST_SOURCE_ENRICHED_AT,
            CASE
                -- Never enriched
                WHEN e.TREND_ID IS NULL THEN 'NEW'
                -- New signals since last enrichment
                WHEN m.LAST_UPDATE_AT > e.ENRICHED_AT THEN 'UPDATED'
                -- Source data stale (>24h)
                WHEN s.ENRICHED_AT IS NULL
                     OR TIMESTAMPDIFF(HOUR, s.ENRICHED_AT, CURRENT_TIMESTAMP()) > 24
                THEN 'STALE_SOURCES'
                ELSE 'CURRENT'
            END AS CHANGE_REASON
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
        LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT e
            ON m.TREND_ID = e.TREND_ID
        LEFT JOIN (
                SELECT TREND_ID, MAX(ENRICHED_AT) AS ENRICHED_AT
                FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
                GROUP BY TREND_ID
            ) s ON m.TREND_ID = s.TREND_ID
        WHERE m.TOTAL_CLUSTER_SIZE >= 3
          AND m.VELOCITY_DIRECTION != 'SUPERSEDED'
    )
    SELECT
        TREND_ID,
        TREND_TOPIC,
        CASE
            -- STALE_SOURCES can only happen when a DIM row already exists
            -- (the NEW / UPDATED branches above take precedence otherwise),
            -- so this is the only case where we cheap-out to sources only.
            WHEN CHANGE_REASON = 'STALE_SOURCES' THEN 'SOURCES_ONLY'
            -- Everything else (NEW, UPDATED) runs through the full LLM chain.
            ELSE 'FULL'
        END AS ENRICHMENT_TYPE,
        -- Priority: heat index + log(cluster_size) * 10, boosted for never-enriched
        ROUND(
            LEAST(TREND_HEAT_INDEX + LN(GREATEST(TOTAL_CLUSTER_SIZE, 1)) * 10
                  + CASE WHEN CHANGE_REASON = 'NEW' THEN 20 ELSE 0 END, 100)
        ) AS PRIORITY,
        CHANGE_REASON
    FROM ENRICHMENT_STATUS
    WHERE CHANGE_REASON != 'CURRENT'
) AS source
ON target.TREND_ID = source.TREND_ID
WHEN MATCHED AND target.STATUS IN ('COMPLETED', 'FAILED') THEN
    UPDATE SET
        target.TREND_TOPIC = source.TREND_TOPIC,
        target.ENRICHMENT_TYPE = source.ENRICHMENT_TYPE,
        target.PRIORITY = source.PRIORITY,
        target.QUEUED_AT = CURRENT_TIMESTAMP(),
        target.STARTED_AT = NULL,
        target.COMPLETED_AT = NULL,
        target.STATUS = 'PENDING',
        target.ERROR_MESSAGE = NULL,
        target.RETRY_COUNT = 0
WHEN NOT MATCHED THEN
    INSERT (TREND_ID, TREND_TOPIC, ENRICHMENT_TYPE, PRIORITY)
    VALUES (source.TREND_ID, source.TREND_TOPIC, source.ENRICHMENT_TYPE, source.PRIORITY);
