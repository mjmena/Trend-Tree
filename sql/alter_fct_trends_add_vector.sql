-- Adds TREND_VECTOR to FCT_TRENDS so the promotion agent can do
-- vector cosine similarity against existing trends when verifying dedup.
--
-- The vector is the embedding of a constructed trend description text:
--   TREND_TOPIC | distillation REASONING | top 3 signal titles
-- via SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', :text).
--
-- Same model used by STG_EXTERNAL_SIGNALS / DT_LLM_TREND_EMBEDDINGS /
-- DT_EXTERNAL_TREND_EMBEDDINGS, so trend vectors are directly comparable to
-- those embeddings (and to themselves).

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
  ADD COLUMN IF NOT EXISTS TREND_VECTOR VECTOR(FLOAT, 1024)
  COMMENT 'Embedding of constructed trend description text (TREND_TOPIC + distillation REASONING + top signal titles), via SNOWFLAKE.CORTEX.EMBED_TEXT_1024(snowflake-arctic-embed-l-v2.0). Set at promotion time.';
