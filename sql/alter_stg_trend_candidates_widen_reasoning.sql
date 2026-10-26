-- Widens STG_TREND_CANDIDATES.REASONING from VARCHAR(2000) (CRMA-1668).
--
-- An editorial candidate's REASONING is the nominator's brief verbatim, and
-- the brief has no cap of its own (only the accept route's 64 KB body cap,
-- spec docs/prd/editorial-trend-ingest-endpoint.md). At 2000 a long brief
-- fails the candidate INSERT on every Cloud Tasks retry. Readers are
-- unaffected: promotion's neighbor recipe reads LEFT(REASONING, 800).
--
-- Widening a VARCHAR is an in-place metadata change in Snowflake; re-running
-- it is a no-op.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ALTER COLUMN REASONING SET DATA TYPE VARCHAR(16777216);
