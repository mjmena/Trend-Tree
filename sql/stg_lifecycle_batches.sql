-- One row per Gemini batch the lifecycle job submits; at most one is SUBMITTED.
-- Submit moves no NEXT_EVAL_AT, so a batch orphaned by a failed insert leaves
-- its trends due for the next tick.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_LIFECYCLE_BATCHES (
  BATCH_NAME    VARCHAR(128)  NOT NULL PRIMARY KEY,  -- batches/<id> from Google
  CHAIN_ID      VARCHAR(64)   NOT NULL,              -- lcy-chain-<uuid>, also the displayName
  TREND_IDS     ARRAY         NOT NULL,
  HEAT_BASES    VARIANT,                             -- {trend_id: heat_base} computed at submit
  SUBMITTED_AT  TIMESTAMP_NTZ NOT NULL,
  STATE         VARCHAR(16)   NOT NULL,              -- SUBMITTED | COLLECTED | FAILED | CANCELLED
  UPDATED_AT    TIMESTAMP_NTZ NOT NULL
);
