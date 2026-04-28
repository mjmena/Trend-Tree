-- Append-only ledger of every enrichment write per trend.
-- Replaces DIM_TREND_ENRICHMENT (upsert pattern) and FCT_TREND_ENRICHMENT_HISTORY (snapshots).
--
-- Each row is one enrichment event. PAYLOAD VARIANT carries the full
-- enrichment-agent emission (names, category, summaries, social_proof,
-- voice_of_customer, narrative, etc). TREND_VECTOR holds the embedding at
-- this point in time. ENRICHMENT_KIND distinguishes:
--   - promotion_seed: written by promotion at trend creation; vector is
--     topic-only embedding, payload is mostly empty (just topic + keyword)
--   - initial:        first full enrichment-agent run; produces names + categories
--                     + full narrative; the FCT_TRENDS one-shot UPDATE for
--                     names/categories happens off this row
--   - refinement:     lifecycle-triggered light re-enrichment; updates
--                     narrative + vector but never names/categories
--
-- "Current state" for any trend = latest row by WRITTEN_AT (exposed via
-- DT_TREND_ENRICHMENT_CURRENT dynamic table).

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER (
  ENRICHMENT_ID       VARCHAR(64)          DEFAULT UUID_STRING() PRIMARY KEY,
  TREND_ID            VARCHAR(64)          NOT NULL,
  WRITTEN_AT          TIMESTAMP_NTZ        DEFAULT CURRENT_TIMESTAMP(),
  WRITTEN_BY          VARCHAR(32)                                COMMENT 'promotion | enrichment | lifecycle_request',
  ENRICHMENT_KIND     VARCHAR(32)                                COMMENT 'promotion_seed | initial | refinement',
  AGENT_SESSION_ID    VARCHAR(64),
  CHAIN_ID            VARCHAR(64),
  PAYLOAD             VARIANT                                    COMMENT 'full enrichment-agent emission: names, category, summary fields, vibe, social_proof, voice_of_customer, social_narrative, cultural_drivers, name_candidates_considered, name_reviewer, agent_telemetry',
  TREND_VECTOR        VECTOR(FLOAT, 1024)                        COMMENT 'embedding at this point in time; lifecycle q_neighbors reads via DT_TREND_ENRICHMENT_CURRENT',
  MODEL_USED          VARCHAR(128),
  LLM_INPUT_TOKENS    NUMBER,
  LLM_OUTPUT_TOKENS   NUMBER,
  LLM_COST_ESTIMATE   FLOAT
);
