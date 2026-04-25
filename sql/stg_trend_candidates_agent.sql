-- Shadow output table for the distillation agent during Phase 1. Lives
-- alongside (does NOT replace) STG_TREND_CANDIDATES. Phase 1.5 promotion
-- decides which agent candidates flow into the live pipeline.
--
-- Each row is one candidate trend the agent (lead or subagent) emitted.
-- BUCKET captures whether the candidate originated from the agent's raw-signal
-- scan, the Louvain-only side, or both (overlap). VERDICT is the subagent's
-- final judgment after corroboration. SUPPORTING_SIGNAL_IDS is the union of
-- the original signals + any signals the subagent fetched via ingest_*.
--
-- REASONING_TRACE holds the full tool-call log + thinking blocks (typically
-- 10-30 KB per row). Keep the column VARIANT so we can store interleaved
-- thinking blocks as native JSON.
--
-- PROMOTED_AT / PROMOTED_TO are filled in once a candidate is accepted into
-- STG_TREND_CANDIDATES (or merged onto an existing trend) by the Phase 1.5
-- promotion job. Until then they stay NULL.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT (
  CANDIDATE_ID            VARCHAR(64)   NOT NULL PRIMARY KEY,
  AGENT_SESSION_ID        VARCHAR(64),
  CHAIN_ID                VARCHAR(64),
  ITERATION               NUMBER,
  CREATED_AT              TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  TOPIC                   VARCHAR(200),
  SUPPORTING_SIGNAL_IDS   ARRAY,
  CONFIDENCE              FLOAT,
  SPECIFICITY_SCORE       FLOAT,
  SOURCE_BREAKDOWN        VARIANT,
  BUCKET                  VARCHAR(32)   COMMENT 'OVERLAP | AGENT_ONLY | LOUVAIN_ONLY',
  VERDICT                 VARCHAR(32)   COMMENT 'REAL_TREND | CATEGORY_TOO_BROAD | NOISE | DUPLICATE_OF_<trend_id>',
  EVIDENCE_ADDED          VARIANT       COMMENT 'JSON: tool-fetched signals supporting the verdict',
  REASONING               VARCHAR(2000) COMMENT 'one-paragraph rationale (subagent free-text)',
  REASONING_TRACE         VARIANT       COMMENT 'full Anthropic tool-call log + thinking blocks',
  DEDUP_OF_TREND_ID       VARCHAR(64)   COMMENT 'set when VERDICT starts with DUPLICATE_OF_',
  PROMOTED_AT             TIMESTAMP_NTZ COMMENT 'NULL until Phase 1.5 promotion picks it up',
  PROMOTED_TO             VARCHAR(64)   COMMENT 'TREND_ID it became (or merged onto) post-promotion'
);
