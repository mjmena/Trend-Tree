-- Adds NOMINATION to FCT_PROMOTION_LEDGER (CRMA-1668, spec
-- docs/prd/editorial-trend-ingest-endpoint.md "Schema and SQL changes").
--
--   NOMINATION  {nominated_by, brief} on an EDITORIAL decision, the brief
--               verbatim; NULL on every other row. The time is DECIDED_AT.
--               nominated_by is ATLAS's claim, stored as sent. Never read by
--               DT_TREND_DASHBOARD (only TREND_ORIGIN reaches the dashboard).
--
-- RUN THIS BEFORE redeploying sql/proc_promotion_apply.sql. The proc's
-- log_audit swallows its own insert errors, so the new proc against a ledger
-- without this column silently stops writing ledger rows for every caller.
--
-- Additive and idempotent.

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
  ADD COLUMN IF NOT EXISTS NOMINATION VARIANT
    COMMENT '{nominated_by, brief} on an EDITORIAL decision (CRMA-1668), brief verbatim; NULL otherwise';
