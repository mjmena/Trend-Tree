-- Append-only ledger for the prediction-agent. One row per (trend, eval).
-- Latest row per TREND_ID is the current PREDICTION_SCORE / FLAG / ELIGIBLE
-- the dashboard reads. Mirrors the conventions of FCT_TREND_LIFECYCLE_LEDGER
-- (PROMOTION / ENRICHMENT / LIFECYCLE pattern — each agent owns one ledger).
--
-- Score isolation: prediction columns are NEVER read by HEAT_INDEX,
-- LIFECYCLE_STATUS, or any other trend-scoring path. Read by
-- DT_TREND_DASHBOARD only as additive columns.
--
-- INPUT_* columns store the per-trend scoring inputs at eval time so the
-- score is fully reconstructable from the ledger (auditability + future
-- weight tuning over Approve/Dismiss history).

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER (
  PREDICTION_EVAL_ID     VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  TREND_ID               VARCHAR       NOT NULL,
  EVALUATED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CHAIN_ID               VARCHAR                                COMMENT 'pred-chain-{8-char random}, set by sweeper for one cron tick',

  PREDICTION_SCORE       NUMBER(5,1)                            COMMENT '0-100, NULL when trend too young for WoW math (<14d)',
  PREDICTION_FLAG        VARCHAR(32)                            COMMENT 'Emerging|Watchlist|High Potential|NULL',
  PREDICTION_ELIGIBLE    BOOLEAN       DEFAULT FALSE            COMMENT 'top-30%-by-score AND positive deltas AND heat<60 AND age>=14d',

  -- Scoring inputs (audit trail + future tuning)
  INPUT_HEAT_NOW         FLOAT                                  COMMENT 'NEW_HEAT_SMOOTHED of latest lifecycle ledger row',
  INPUT_HEAT_7D          FLOAT                                  COMMENT 'NEW_HEAT_SMOOTHED of lifecycle ledger row closest to NOW-7d',
  INPUT_HEAT_14D         FLOAT                                  COMMENT 'NEW_HEAT_SMOOTHED of lifecycle ledger row closest to NOW-14d',
  INPUT_ACCELERATION     FLOAT                                  COMMENT '(heat_now - heat_7d) - (heat_7d - heat_14d)',
  INPUT_INVERSE_HEAT     FLOAT                                  COMMENT '100 - heat_now (low-base-volume signal)',
  INPUT_SOURCES_LAST_7D  NUMBER                                 COMMENT 'COUNT(DISTINCT domain) in FCT_TREND_SIGNALS WHERE LINKED_AT >= NOW-7d',
  INPUT_SOURCES_PRIOR_7D NUMBER                                 COMMENT 'same metric in the NOW-14d..NOW-7d window',
  INPUT_SOURCE_DELTA     FLOAT                                  COMMENT 'sources_last_7d - sources_prior_7d',
  INPUT_SIGNALS_LAST_7D  NUMBER                                 COMMENT 'COUNT(DISTINCT SIGNAL_ID) in FCT_TREND_SIGNALS WHERE LINKED_AT >= NOW-7d',
  INPUT_SIGNALS_PRIOR_7D NUMBER                                 COMMENT 'same metric in the NOW-14d..NOW-7d window',
  INPUT_SIGNAL_DELTA     FLOAT                                  COMMENT 'signals_last_7d - signals_prior_7d (proxy for cluster formation)',
  INPUT_SCORE_PERCENTILE FLOAT                                  COMMENT 'PERCENT_RANK over all scored trends at this eval; eligibility gate uses >= 0.70',
  DAYS_SINCE_PROMOTION   NUMBER                                 COMMENT 'DATEDIFF(day, FCT_TRENDS.PROMOTED_AT, NOW)',

  COMPUTATION_VERSION    VARCHAR       DEFAULT 'v1'             COMMENT 'bump when formula changes; auditable lineage'
);
