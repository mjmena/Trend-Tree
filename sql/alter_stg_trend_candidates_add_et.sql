-- Adds the ET corroboration decision-record columns to STG_TREND_CANDIDATES
-- (ADR-0004, issue #60). Written by PROC_PROMOTION_APPLY when the promotion
-- agent acts on Exploding Topics for an ET-rescue candidate:
--
--   ET_CORROBORATION      the agent's ET snapshot at decision time —
--                         { matched, keyword, absolute_volume, classifications,
--                           growth, queried } (nullable; NULL when ET was not
--                           consulted).
--   ET_WAS_SECOND_SOURCE  TRUE when ET's independent recognition supplied the
--                         missing second source family and the candidate was
--                         promoted on that basis. Drives lift measurement
--                         (join to trend survival) and the FCT_TREND_ET_LEDGER
--                         seed (slice 3).
--
-- Additive and idempotent. Safe to run live ahead of the proc that writes them.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS ET_CORROBORATION VARIANT
    COMMENT 'ET snapshot at decision time { matched, keyword, absolute_volume, classifications, growth, queried } (ADR-0004); NULL when ET not consulted';

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS ET_WAS_SECOND_SOURCE BOOLEAN
    COMMENT 'TRUE when Exploding Topics supplied the missing second source family and the candidate was promoted on that basis (ADR-0004)';
