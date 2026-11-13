-- One row per Gemini batch the attribution job submits; at most one is SUBMITTED.
-- A trend's last sweep is the newest SUBMITTED_AT of a COLLECTED row whose
-- TREND_IDS holds it (docs/prd/attribution-job.md, CRMA-1692). A failed or
-- cancelled batch is not a sweep, so its trends lead the next tick.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ATTRIBUTION_BATCHES (
  BATCH_NAME       VARCHAR(128)  NOT NULL PRIMARY KEY,  -- batches/<id> from Google, or none-<chain id>
  CHAIN_ID         VARCHAR(64)   NOT NULL,              -- atr-chain-<uuid>, also the displayName
  TREND_IDS        ARRAY         NOT NULL,              -- every selected trend, empty pools included
  POOLS            VARIANT       NOT NULL,              -- {trend_id: [candidate rows]} at submit
  BUDGET_EXHAUSTED BOOLEAN,                             -- the cap left out a trend not swept for 24 h
  SUBMITTED_AT     TIMESTAMP_NTZ NOT NULL,
  STATE            VARCHAR(16)   NOT NULL,              -- SUBMITTED | COLLECTED | FAILED | CANCELLED
  UPDATED_AT       TIMESTAMP_NTZ NOT NULL
);
