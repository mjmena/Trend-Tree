-- Adds explicit REJECTED and DEFERRED state columns to STG_TREND_CANDIDATES.
-- Before this, NOISE/CATEGORY_TOO_BROAD candidates sat with PROMOTED_AT IS NULL
-- forever, with no observability on why they didn't promote. The promotion
-- agent uses these new columns to record its own decisions explicitly.
--
-- State machine (post-promotion-agent):
--   PENDING:  PROMOTED_AT IS NULL AND REJECTED_AT IS NULL AND (DEFERRED_UNTIL IS NULL OR DEFERRED_UNTIL <= NOW)
--   PROMOTED: PROMOTED_AT IS NOT NULL (DEDUP_OF_TREND_ID NULL = new trend; NOT NULL = merged onto existing)
--   REJECTED: REJECTED_AT IS NOT NULL
--   DEFERRED: DEFERRED_UNTIL IS NOT NULL AND DEFERRED_UNTIL > NOW
--
-- PROMOTION_DECIDED_BY records the chain_id that resolved the candidate, for
-- auditing which agent run made the call.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS REJECTED_AT          TIMESTAMP_NTZ COMMENT 'set by promotion agent when candidate rejected outright';

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS REJECTION_REASON     VARCHAR        COMMENT 'short rationale (LOW_QUALITY, DISTILLATION_REJECTED, OFF_TOPIC, etc.)';

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS DEFERRED_UNTIL       TIMESTAMP_NTZ COMMENT 'when set, candidate is re-evaluated after this time';

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS DEFER_REASON         VARCHAR        COMMENT 'why deferred (NEEDS_MORE_SIGNAL, AMBIGUOUS_TOPIC_JUDGMENT, etc.)';

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
  ADD COLUMN IF NOT EXISTS PROMOTION_DECIDED_BY VARCHAR        COMMENT 'chain_id of the promotion-agent run that resolved this candidate';
