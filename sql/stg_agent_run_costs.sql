-- Per-run cost & token telemetry across all agent workflows (lead, subagent,
-- and any future enrichment/lifecycle agents in Phase 2/3). Each row captures
-- one Pipedream run; aggregation queries can roll up by chain_id, workflow,
-- day, etc.
--
-- THINKING_TOKENS is broken out separately so we can track interleaved
-- thinking spend independently from input/output. INPUT_TOKENS for cached
-- prompt content also tracked separately under INPUT_TOKENS_CACHED so we can
-- measure cache hit rate after enabling prompt caching.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS (
  RUN_ID              VARCHAR(64)   NOT NULL PRIMARY KEY,
  AGENT_SESSION_ID    VARCHAR(64),
  CHAIN_ID            VARCHAR(64),
  ITERATION           NUMBER,
  WORKFLOW_NAME       VARCHAR(64),
  STARTED_AT          TIMESTAMP_NTZ,
  ENDED_AT            TIMESTAMP_NTZ,
  DURATION_MS         NUMBER,
  MODEL               VARCHAR(64),
  INPUT_TOKENS        NUMBER,
  INPUT_TOKENS_CACHED NUMBER,
  OUTPUT_TOKENS       NUMBER,
  THINKING_TOKENS     NUMBER,
  TOOL_CALL_COUNT     NUMBER,
  TURN_COUNT          NUMBER,
  COST_USD            FLOAT,
  STATUS              VARCHAR(32)   COMMENT 'OK | TIMEOUT | BUDGET_EXHAUSTED | ERROR',
  ERROR_MESSAGE       VARCHAR(2000)
);
