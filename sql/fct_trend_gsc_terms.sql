-- Per-trend search terms for Google Search Console (GSC) demand matching.
--
-- The sources-p_7NCy36w workflow's generate_search_terms step already
-- produces ~6-8 short phrases per trend (Claude Haiku), but they were
-- historically ephemeral — consumed inline by the GDELT/Wikimedia/GTrends
-- fetchers and never persisted. This table persists the *clean LLM phrases*
-- (the n-gram/long-word padding the GDELT path uses is dropped — it's noise
-- for near-exact GSC query matching) plus a precomputed 768-dim vector so
-- the GSC matcher (PROC_MATCH_GSC_DEMAND) can match each term individually.
--
-- TERM_VECTOR is written NULL by the merge step and batch-filled by
-- PROC_EMBED_GSC_TERMS via SNOWFLAKE.CORTEX.EMBED_TEXT_768 — the same
-- arctic-embed-m-v1.5 / 768 space as GSC's SEARCH_TERM_VECTORS. (Trend
-- identity vectors are 1024 arctic-l-v2 and cannot cosine against GSC.)
--
-- Written by sources-p_7NCy36w's merge_gsc_terms step (NOT-MATCHED-only,
-- so an already-embedded term is never re-NULLed). Coverage builds forward
-- only — there is nothing to backfill.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GSC_TERMS (
  TREND_ID      VARCHAR(64)        NOT NULL,
  TERM          VARCHAR                                          COMMENT 'raw phrase as generated (clean LLM phrase)',
  TERM_NORM     VARCHAR            NOT NULL                      COMMENT 'LOWER(TRIM(TERM)) — dedup + string-match key',
  TERM_VECTOR   VECTOR(FLOAT, 768)                               COMMENT 'arctic-embed-m-v1.5 embedding of TERM; NULL on write, filled by PROC_EMBED_GSC_TERMS',
  SOURCE_GEN    VARCHAR            DEFAULT 'gsc_v1'              COMMENT 'which generator produced the term (room for a future GSC-tuned generator)',
  GENERATED_AT  TIMESTAMP_NTZ      DEFAULT CURRENT_TIMESTAMP(),
  EMBEDDED_AT   TIMESTAMP_NTZ                                    COMMENT 'set when TERM_VECTOR is filled',

  PRIMARY KEY (TREND_ID, TERM_NORM)
);
