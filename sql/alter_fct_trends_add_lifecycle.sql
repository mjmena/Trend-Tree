-- Adds the columns the lifecycle agent needs to FCT_TRENDS.
--
-- LIFECYCLE_STATUS replaces VELOCITY_DIRECTION as the canonical state column.
-- New enum: NEW | GROWING | STABLE | DECLINING | DORMANT | RESURGENT | RETIRED
-- (legacy STAGNANT → DORMANT, legacy SUPERSEDED dropped — see plan).
--
-- VELOCITY_DIRECTION stays in FCT_TRENDS only until DT_TREND_DASHBOARD is
-- updated to surface `LIFECYCLE_STATUS AS VELOCITY_DIRECTION` and
-- PROC_PROMOTION_APPLY is updated to write LIFECYCLE_STATUS instead of
-- VELOCITY_DIRECTION. After both are in place, run the DROP COLUMN at the
-- bottom of this file.
--
-- All adds are idempotent; safe to re-run.

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
  ADD COLUMN IF NOT EXISTS LIFECYCLE_STATUS          VARCHAR(32)   DEFAULT 'NEW' COMMENT 'NEW|GROWING|STABLE|DECLINING|DORMANT|RESURGENT|RETIRED — written by lifecycle agent (and PROC_PROMOTION_APPLY for new rows)',
                           LAST_LIFECYCLE_EVAL_AT    TIMESTAMP_NTZ                COMMENT 'when the lifecycle subagent last evaluated this trend',
                           NEXT_LIFECYCLE_EVAL_AT    TIMESTAMP_NTZ                COMMENT 'sweeper picks rows where this <= NOW(); set by lifecycle commit step per status tier (NEW first +1h, GROWING/RESURGENT +6h, STABLE/DECLINING +24h, DORMANT +72h, RETIRED NULL)',
                           RETIREMENT_REASON         VARCHAR(500)                 COMMENT 'set when LIFECYCLE_STATUS=RETIRED — agent-supplied rationale',
                           TREND_HEAT_INDEX_SMOOTHED FLOAT                        COMMENT 'EWMA(α=0.3) over TREND_HEAT_INDEX history; what dashboards should display to avoid spike volatility';

-- One-time backfill from the legacy column. Maps the old enum forward:
--   STAGNANT   → DORMANT (renamed; same semantics in practice)
--   SUPERSEDED → RETIRED (no current rows have this in FCT_TRENDS but be safe)
--   NEW/GROWING/STABLE/DECLINING/RESURGENT → identity
-- Idempotent: only writes rows where LIFECYCLE_STATUS is still the default.
UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
   SET LIFECYCLE_STATUS = CASE VELOCITY_DIRECTION
                            WHEN 'STAGNANT'   THEN 'DORMANT'
                            WHEN 'SUPERSEDED' THEN 'RETIRED'
                            ELSE VELOCITY_DIRECTION
                          END
 WHERE LIFECYCLE_STATUS IS NULL
    OR LIFECYCLE_STATUS = 'NEW';

-- ════════════════════════════════════════════════════════════════════════
-- DO NOT RUN until BOTH of these have landed:
--   1. PROC_PROMOTION_APPLY writes LIFECYCLE_STATUS instead of VELOCITY_DIRECTION
--   2. DT_TREND_DASHBOARD exposes `t.LIFECYCLE_STATUS AS VELOCITY_DIRECTION`
--      and has been refreshed (otherwise the next refresh fails)
-- ════════════════════════════════════════════════════════════════════════
-- ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS DROP COLUMN VELOCITY_DIRECTION;
