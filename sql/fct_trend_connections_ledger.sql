-- Append-only ledger for the connections-agent. One generation of pairwise
-- trend-similarity edges per recompute, tagged with a single CHAIN_ID +
-- COMPUTED_AT. The connections-agent owns this ledger exclusively
-- (one-ledger-per-agent convention — mirrors FCT_TREND_PREDICTION_LEDGER /
-- FCT_TREND_LIFECYCLE_LEDGER).
--
-- Each row is one undirected edge (TREND_ID_A < TREND_ID_B, no self-pairs).
-- "Current state" = rows from the most recent CHAIN_ID / COMPUTED_AT, exposed
-- to Atlas via DT_TREND_CONNECTIONS in the exact five-column contract.
--
-- Score isolation: connection edges are NEVER read by HEAT_INDEX,
-- LIFECYCLE_STATUS, PREDICTION_SCORE, or the dashboard's RELATED_TRENDS. This
-- stage is intentionally isolated from RELATED_TRENDS for now (issue #48 — the
-- two get reconciled deliberately, not coupled prematurely).
--
-- INPUT_SAME_THRESHOLD / INPUT_CROSS_THRESHOLD record the cut points used for
-- each generation so the edge set is reconstructable + the calibration is
-- auditable as thresholds get re-tuned over time (issue #50).

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONNECTIONS_LEDGER (
  CONNECTION_EDGE_ID    VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  CHAIN_ID              VARCHAR                                COMMENT 'conn-chain-{rand}, one generation per recompute (cron tick or manual POST)',
  COMPUTED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),

  TREND_ID_A            VARCHAR(64)   NOT NULL                 COMMENT 'lower trend id of the undirected pair (A < B)',
  TREND_ID_B            VARCHAR(64)   NOT NULL                 COMMENT 'higher trend id of the undirected pair (A < B)',
  SCORE                 FLOAT                                  COMMENT 'VECTOR_COSINE_SIMILARITY of the two latest TREND_VECTORs, 4-dp',
  CATEGORY_A            VARCHAR                                COMMENT 'frozen FCT_TRENDS.CATEGORY of TREND_ID_A',
  CATEGORY_B            VARCHAR                                COMMENT 'frozen FCT_TRENDS.CATEGORY of TREND_ID_B',

  -- Calibration audit trail (issue #50 — thresholds are a moving target)
  INPUT_SAME_THRESHOLD  FLOAT                                  COMMENT 'SAME_CAT_THRESHOLD in effect for this generation',
  INPUT_CROSS_THRESHOLD FLOAT                                  COMMENT 'CROSS_CAT_THRESHOLD in effect for this generation',

  COMPUTATION_VERSION   VARCHAR       DEFAULT 'v1'             COMMENT 'bump when edge-selection rule changes; auditable lineage'
);
