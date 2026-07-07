-- Adds the atomic candidate QUERY column to STG_TREND_CANDIDATES (ADR-0004,
-- issue #59). QUERY is the [candidate query] — a single atomic,
-- consumer-vernacular search term (the ATOMIC_QUERY_RULE from
-- agents/lib/descriptor.mjs) authored by the distillation lead alongside each
-- candidate TOPIC. It is the candidate-lineage precursor to descriptor.query
-- (ADR-0003), authored at candidate time so a corroboration oracle
-- (Exploding Topics, slice 2) can be looked up *before the trend exists*.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS). Safe to run live ahead
-- of the commit_candidates INSERT that populates it.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS QUERY VARCHAR
    COMMENT 'atomic consumer-vernacular search term (ATOMIC_QUERY_RULE, ADR-0004); candidate-lineage precursor to descriptor.query, authored at candidate time as the ET corroboration-oracle join key';
