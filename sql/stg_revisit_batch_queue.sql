-- STG_REVISIT_BATCH_QUEUE
--
-- Per-chain batch queue for the distillation revisit pipeline.
-- The revisit lead processes one batch per workflow run (suspend/resume on
-- the cluster agent's callback) and chains to itself for the next batch.
-- Each chain has N PENDING rows on start; rows transition to DONE or FAILED
-- as batches complete.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE (
  CHAIN_ID         STRING       NOT NULL,
  AGENT_SESSION_ID STRING       NOT NULL,
  BATCH_INDEX      NUMBER       NOT NULL,
  TOTAL_BATCHES    NUMBER       NOT NULL,
  CLUSTER_ROWS     VARIANT      NOT NULL,
  SIGNAL_IDS_JSON  STRING       NOT NULL,
  SIGNAL_COUNT     NUMBER       NOT NULL,
  STATUS           STRING       NOT NULL,
  CANDIDATES_COUNT NUMBER,
  COST_USD         FLOAT,
  RUN_DURATION_MS  NUMBER,
  ERROR            STRING,
  CREATED_AT       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT       TIMESTAMP_NTZ,
  CONSTRAINT PK_RBQ PRIMARY KEY (CHAIN_ID, BATCH_INDEX)
);
