-- Window cursor for the distillation lead agent. One row per cursor name
-- (we currently only use 'distillation_main' but the schema allows multiple
-- concurrent cursors for shadow/canary runs). The lead reads LAST_SIGNAL_TS
-- on every wake-up to decide its query window, then writes back the highest
-- signal timestamp it observed plus run telemetry.
--
-- Seed row needs to be inserted once after table creation:
--   INSERT INTO MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR
--     (CURSOR_NAME, LAST_RUN_AT, LAST_SIGNAL_TS)
--   VALUES ('distillation_main', NULL, DATEADD(hour, -24, CURRENT_TIMESTAMP()));

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR (
  CURSOR_NAME       VARCHAR(64)   NOT NULL PRIMARY KEY,
  LAST_RUN_AT       TIMESTAMP_NTZ,
  LAST_SIGNAL_TS    TIMESTAMP_NTZ,
  RUN_DURATION_MS   NUMBER,
  SIGNAL_COUNT      NUMBER,
  CANDIDATE_COUNT   NUMBER,
  COST_USD          FLOAT
);
