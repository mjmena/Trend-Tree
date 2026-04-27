-- Append-only audit trail for every promotion-agent decision.
-- One row per candidate evaluated, regardless of outcome (PROMOTE/MERGE/REJECT/DEFER).
--
-- CONSIDERED_NEIGHBORS is the per-neighbor judgment trail — for each of the
-- top-K vector neighbors the subagent examined, what call did it make
-- (same/hierarchical/recurrence/different) and why. This lets us audit
-- whether the agent's topic judgment is consistent without rerunning it.
--
-- DECISION_CATEGORY is the finer-grained reason within DECISION:
--   PROMOTE_NEW         → CONFIRM_NEW | OVER_DEDUP | OVER_REJECT_PROMOTE
--   MERGE_INTO_EXISTING → CONFIRM_DUPE | MISSED_DUPLICATE | CORRECTED_DEDUP_TARGET
--   REJECT              → LOW_QUALITY | CONFIRM_REJECT | OFF_TOPIC
--   DEFER               → NEEDS_MORE_SIGNAL | AMBIGUOUS_TOPIC_JUDGMENT
--
-- OVERRODE_VERDICT = TRUE when agent's DECISION conflicts with what
-- distillation would have done with its DISTILLATION_VERDICT — useful for
-- spotting drift between distillation and promotion.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_AUDIT (
  AUDIT_ID             VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
  CANDIDATE_ID         VARCHAR NOT NULL,
  CHAIN_ID             VARCHAR NOT NULL,
  ITERATION            NUMBER  NOT NULL,
  DECIDED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  DECISION             VARCHAR NOT NULL                          COMMENT 'PROMOTE_NEW | MERGE_INTO_EXISTING | REJECT | DEFER',
  DECISION_CATEGORY    VARCHAR                                    COMMENT 'finer-grained category — see file comment',
  TARGET_TREND_ID      VARCHAR                                    COMMENT 'new TREND_ID for PROMOTE_NEW; existing for MERGE_INTO_EXISTING',
  DISTILLATION_VERDICT VARCHAR                                    COMMENT 'what distillation recommended (REAL_TREND, DUPLICATE_OF_<id>, NOISE, CATEGORY_TOO_BROAD)',
  OVERRODE_VERDICT     BOOLEAN                                    COMMENT 'TRUE when agent decision conflicts with distillation',
  MAX_NEIGHBOR_SIM     FLOAT                                      COMMENT 'top vector sim against FCT_TRENDS at decision time (FYI only, not the decision driver)',
  CONSIDERED_NEIGHBORS VARIANT                                    COMMENT 'ARRAY of {trend_id, similarity, judgment} — per-neighbor reasoning trail',
  CLUSTER_SIZE         NUMBER                                     COMMENT 'ARRAY_SIZE(SUPPORTING_SIGNAL_IDS)',
  SOURCE_COUNT         NUMBER                                     COMMENT 'distinct source count from SOURCE_BREAKDOWN',
  CONFIDENCE           FLOAT                                      COMMENT 'candidate.CONFIDENCE',
  RATIONALE            VARCHAR                                    COMMENT 'subagent reasoning paragraph defending the decision',
  MODEL_USED           VARCHAR DEFAULT 'claude-sonnet-4-6',
  INPUT_TOKENS         NUMBER,
  OUTPUT_TOKENS        NUMBER,
  COST_ESTIMATE        FLOAT
);
