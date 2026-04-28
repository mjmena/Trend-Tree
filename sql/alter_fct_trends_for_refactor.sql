-- Adds the four "set-once-by-first-enrichment" categorical columns to FCT_TRENDS
-- as part of the agent-owned-ledgers refactor. These migrate down from
-- DIM_TREND_ENRICHMENT (which is being dropped) and become part of FCT_TRENDS'
-- pure identity surface.
--
-- Contract (enforced by PROC_ENRICHMENT_APPLY): set once by first enrichment,
-- frozen thereafter. Re-enrichment never touches these. Lifecycle never writes
-- to FCT_TRENDS.
--
-- Idempotent.

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
  ADD COLUMN IF NOT EXISTS TREND_NAME_B2B  VARCHAR  COMMENT 'set once by first enrichment, frozen',
                           TREND_NAME_B2C  VARCHAR  COMMENT 'set once by first enrichment, frozen',
                           CATEGORY        VARCHAR  COMMENT 'set once by first enrichment, frozen',
                           SUBCATEGORY     VARCHAR  COMMENT 'set once by first enrichment, frozen';
