-- Promoted-trend table. The agent-pathway analog of legacy FCT_TREND_METRICS.
-- One row per trend that the distillation agent has produced as a REAL_TREND
-- candidate. DUPLICATE_OF_* candidates do NOT insert here — they bump the
-- existing matching row's LAST_UPDATE_AT instead.
--
-- Provenance back to the candidate that produced this row is via CANDIDATE_ID
-- + AGENT_SESSION_ID + CHAIN_ID. Supporting signal lineage stays in
-- STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS (an ARRAY) reachable via
-- LATERAL FLATTEN when needed.
--
-- Skipped vs legacy FCT_TREND_METRICS: TREND_VECTOR, AVG_SIMILARITY,
-- TREND_DURATION_HR, SIGNALS_PER_SOURCE, SIGNAL_CHANGE — those are derived
-- from Louvain math the agent path doesn't produce. Add later if a downstream
-- consumer needs them.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS (
  TREND_ID              VARCHAR(64)   NOT NULL PRIMARY KEY,
  CANDIDATE_ID          VARCHAR(64)   NOT NULL,
  TREND_TOPIC           VARCHAR(200),
  AGENT_SESSION_ID      VARCHAR(64),
  CHAIN_ID              VARCHAR(64),
  DETECTED_AT           TIMESTAMP_NTZ COMMENT 'candidate.CREATED_AT',
  LAST_UPDATE_AT        TIMESTAMP_NTZ COMMENT 'bumped by commit_duplicate_updates when an agent run sees this trend re-emerge',
  PROMOTED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  TOTAL_CLUSTER_SIZE    NUMBER        COMMENT 'ARRAY_SIZE(candidate.SUPPORTING_SIGNAL_IDS) at promotion',
  DISTINCT_SOURCE_COUNT NUMBER        COMMENT 'ARRAY_SIZE(OBJECT_KEYS(candidate.SOURCE_BREAKDOWN)) at promotion',
  CONFIDENCE            FLOAT         COMMENT 'from candidate; subagent-emitted score',
  SPECIFICITY_SCORE     FLOAT         COMMENT 'from candidate; subagent-emitted score',
  VELOCITY_DIRECTION    VARCHAR(32)   DEFAULT 'NEW' COMMENT 'NEW | GROWING | STABLE | DECLINING | STAGNANT | SUPERSEDED',
  TREND_HEAT_INDEX      FLOAT         COMMENT 'NULL until a recompute job lands; legacy formula relies on Louvain inputs we do not produce'
);
