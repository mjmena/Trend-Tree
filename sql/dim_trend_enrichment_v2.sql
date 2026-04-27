-- Migration: DIM_TREND_ENRICHMENT v2 (Phase 3 enrichment refactor)
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Adds columns required by:
--   * dashboard feedback (low-confidence category flag, structured social
--     proof with click-through URLs, "originally surfaced at" timestamp)
--   * naming-quality refactor (audit trail of candidate names + scores;
--     post-emission reviewer pass output)
--   * single-agent-loop telemetry (turns, tool_calls, stop_reason, cost)
--
-- Additive ALTERs only — never drops columns. Legacy rows have NULL for
-- new fields; the write workflow's compute_scores has a compat path that
-- leaves them NULL when a legacy-shape response comes through.
--
-- Two items intentionally NOT in this migration:
--   * STEPPS_METADATA — dropped wholesale per user direction 2026-04-27.
--   * PREDICTION_SCORE / PREDICTION_RATIONALE — deferred; heat index from
--     FCT_TREND_METRICS is the primary momentum signal, computed upstream.

-- Snowflake doesn't support IF NOT EXISTS in compound ALTER TABLE ... ADD COLUMN.
-- These are run once during the Phase 3 cutover; rerunning will error if columns
-- already exist, which is the intended behavior.
ALTER TABLE MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
    ADD COLUMN CATEGORY_CONFIDENCE         NUMBER(3,2),
               LOW_CONFIDENCE_FLAG         BOOLEAN,
               SOCIAL_PROOF                VARIANT,
               ORIGINALLY_SURFACED_AT      TIMESTAMP_NTZ,
               NAME_CANDIDATES_CONSIDERED  VARIANT,
               NAME_REVIEWER               VARIANT,
               AGENT_TELEMETRY             VARIANT;

-- SOCIAL_NARRATIVE was VARCHAR (single string). Phase 3 emits a structured
-- array of {point, evidence_url} so the dashboard can render each narrative
-- bullet as a click-through. Adding a parallel V2 column keeps the legacy
-- column intact during cutover; the dashboard reads V2 with a fallback.
-- A follow-up migration after cutover should drop the original column.
ALTER TABLE MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
    ADD COLUMN IF NOT EXISTS SOCIAL_NARRATIVE_V2 VARIANT;

-- VOICE_OF_CUSTOMER was already VARIANT — no migration needed. Phase 3
-- shape is [{quote, source_url, platform}] (was {quote, sentiment, persona_type}).
-- Old rows remain readable; consumers should branch on the keys present.

-- History table also gains CATEGORY_CONFIDENCE so Audit Agent can detect
-- confidence drift, not just category drift.
ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_HISTORY
    ADD COLUMN IF NOT EXISTS CATEGORY_CONFIDENCE NUMBER(3,2);
