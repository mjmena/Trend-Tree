-- One row per Gemini batch the lifecycle job (services/lifecycle) submits.
-- The job collects the newest SUBMITTED row before it submits another, so at
-- most one batch is in flight. Nothing moves NEXT_EVAL_AT at submit: if the
-- insert fails after a successful submit, the batch is orphaned and its
-- trends stay due for the next tick.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_LIFECYCLE_BATCHES (
  BATCH_NAME    VARCHAR(128)  NOT NULL PRIMARY KEY,  -- batches/<id> from Google
  CHAIN_ID      VARCHAR(64)   NOT NULL,              -- lcy-chain-<uuid>, also the displayName
  TREND_IDS     ARRAY         NOT NULL,
  SUBMITTED_AT  TIMESTAMP_NTZ NOT NULL,
  STATE         VARCHAR(16)   NOT NULL,              -- SUBMITTED | COLLECTED | FAILED | CANCELLED
  UPDATED_AT    TIMESTAMP_NTZ NOT NULL
);
