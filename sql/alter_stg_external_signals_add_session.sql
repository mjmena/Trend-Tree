-- Adds AGENT_SESSION_ID tag to STG_EXTERNAL_SIGNALS so we can distinguish
-- agent-fetched evidence (via the new ingest_search_* tool wrappers) from
-- batched cron ingestion. Existing rows and batch ingestion writes leave
-- this column NULL; tool-wrapper inserts populate it with the lead/subagent
-- session UUID.
--
-- Downstream clustering/distillation should JOIN/FILTER on AGENT_SESSION_ID IS NULL
-- whenever it doesn't want agent-fetched evidence to influence cluster volume
-- or pagerank counts.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
  ADD COLUMN IF NOT EXISTS AGENT_SESSION_ID VARCHAR(64) NULL
    COMMENT 'Agent run UUID for evidence fetched via ingest_search_* tools; NULL for batched ingestion';
