-- The strategist calibration label tier (CRMA-768; strategy doc
-- docs/prediction-pillar-strategy.md §7.4, PRD user story 29).
--
--     "Strategist Approve/Dismiss decisions are retained as a calibration
--      label tier -- recorded now, regression-tuned against later, never
--      live-trained."
--
-- One row per human judgement. The decisions themselves are made in the
-- Insights Agent's Predictions Queue and stored in Insights Postgres
-- (`prediction_decisions`), which this repo does not own; this table is the
-- prediction service's retained copy, written on the daily sweep as it reads
-- the tier.
--
-- WRITE-ONLY AT RUNTIME. Nothing in the prediction service reads this table
-- back, and no code path may adjust CONFIDENCE, PREDICTION_STATUS,
-- MATCHED_TREND_ID or the dashboard's PREDICTION_SCORE / _FLAG / _ELIGIBLE
-- from it. That is enforced in code -- the writing module offers no read and
-- refuses any statement that is not a MERGE into this table (see
-- services/prediction/prediction_service/strategist/labels.py and
-- services/prediction/tests/test_strategist_isolation.py). "Regression-tuned
-- later" means an offline analysis reading these rows, deliberately outside
-- the live loop.
--
-- Not the same thing as the verdict a Dismiss produces. The withdrawal is a
-- row in FCT_PREDICTION_VERDICT_LEDGER with PREDICTION_STATUS = 'WITHDRAWN';
-- this table is the label kept for calibration. The two are written in the
-- same request and are deliberately separate records.
--
-- Idempotency: LABEL_ID is derived by the service from the decision's own
-- identity (prediction id + action + the moment it was taken) and the write
-- is a MERGE ... WHEN NOT MATCHED, so a standing decision re-read on every
-- daily sweep produces one row rather than one per day. A strategist who
-- changes their mind carries a new DECIDED_AT and therefore a new label --
-- the tier keeps the whole sequence of human judgements, which is what a
-- later calibration pass is fit against.
--
-- Isolation invariant: like every other prediction-pillar table, nothing
-- here is ever read by HEAT_INDEX, LIFECYCLE_STATUS, or any trend-scoring
-- path (CONTEXT.md, evidence purity).
CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_STRATEGIST_LABELS (
  LABEL_ID             VARCHAR(64)   NOT NULL PRIMARY KEY  COMMENT 'uuid5(prediction_id, decision, decided_at) minted by the service so a re-read MERGEs into a no-op (the PK is informational in Snowflake and enforces nothing)',
  PREDICTION_ID        VARCHAR(64)   NOT NULL              COMMENT 'FCT_PREDICTION_VERDICT_LEDGER.PREDICTION_ID this decision was about; the only key the decision is ever bound by',
  DECISION             VARCHAR(16)   NOT NULL              COMMENT 'APPROVE | DISMISS -- the label',
  DECIDED_AT           TIMESTAMP_NTZ NOT NULL              COMMENT 'when the strategist acted, as Insights Postgres recorded it; also what makes an Approve''s protection end at the next human touch',
  DECIDED_BY           VARCHAR(256)                        COMMENT 'the strategist, when the source names one',

  -- What the human was looking at when they acted. The Insights side stores
  -- both at decision time; they are the label's context, not a reading this
  -- service took.
  OBSERVED_CONFIDENCE  NUMBER(5,1)                         COMMENT 'the PREDICTION_SCORE shown to the strategist at decision time',
  OBSERVED_FLAG        VARCHAR(32)                         COMMENT 'the PREDICTION_FLAG shown to the strategist at decision time',

  -- What the pillar itself read at the evaluation that recorded this label --
  -- the feature side of a later calibration fit.
  VERDICT_CONFIDENCE   NUMBER(5,1)                         COMMENT 'CONFIDENCE on the verdict this sweep wrote for the prediction',
  VERDICT_STATUS       VARCHAR(32)                         COMMENT 'PREDICTION_STATUS on that verdict; DISMISS labels read WITHDRAWN',

  DECISION_SOURCE      VARCHAR(64)                         COMMENT 'where the decision was read from -- insights_postgres.prediction_decisions',
  RECORDED_AT          TIMESTAMP_NTZ NOT NULL              COMMENT 'when this service wrote the label; written, not defaulted, so it shares HORIZON_AT''s UTC clock rather than the warehouse session''s',
  CHAIN_ID             VARCHAR(64)                         COMMENT 'the sweep that recorded it -- joins to the verdict rows of the same run',
  LABEL_VERSION        VARCHAR(16)   DEFAULT 'v1'          COMMENT 'bump when the label contract changes; auditable lineage'
);
