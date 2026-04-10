-- Staging: Enrichment work queue
-- Database: MCC_RAW.MARKETING_DEV
--
-- Populated by TASK_QUEUE_ENRICHMENT when new/updated trends are detected.
-- Polled by Pipedream source_trend_changes.mjs to trigger enrichment workflows.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE (
    TREND_ID VARCHAR NOT NULL,
    TREND_TOPIC VARCHAR,
    ENRICHMENT_TYPE VARCHAR DEFAULT 'FULL',  -- FULL | SOURCES_ONLY | REFRESH
    PRIORITY NUMBER DEFAULT 50,              -- higher = process first (derived from heat + cluster size)
    QUEUED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ,
    STATUS VARCHAR DEFAULT 'PENDING',        -- PENDING | IN_PROGRESS | COMPLETED | FAILED
    ERROR_MESSAGE VARCHAR,
    RETRY_COUNT NUMBER DEFAULT 0,

    -- Completion tracking (populated by enrich_write_snowflake.mjs on completion)
    ENRICHMENT_TIER VARCHAR,                 -- FULL | GATED | SOURCES_ONLY — what actually ran
    LLM_TOTAL_TOKENS NUMBER,                 -- total tokens used in this run
    LLM_COST_ESTIMATE FLOAT,                 -- estimated USD cost for this run
    DURATION_SECONDS NUMBER,                 -- wall-clock time from STARTED_AT to COMPLETED_AT

    PRIMARY KEY (TREND_ID)
);
