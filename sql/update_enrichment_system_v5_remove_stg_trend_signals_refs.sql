-- Phase 3 enrichment.agent.system v5 — remove STG_TREND_SIGNALS references
--
-- STG_TREND_SIGNALS is being retired (Louvain pipeline frozen since 2026-04-27).
-- Pre-fetched signals now come from STG_EXTERNAL_SIGNALS via the candidate's
-- SUPPORTING_SIGNAL_IDS array, ranked by recency rather than PageRank.
--
-- This script derives v5 from v4 with surgical REPLACE()s on the two text
-- snippets that mention STG_TREND_SIGNALS, then deactivates v4.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY,
  5 AS VERSION,
  MODEL,
  REPLACE(
    REPLACE(
      TEMPLATE,
      'The top 10 STG_TREND_SIGNALS by pagerank — these are the signals that defined the cluster',
      'The top 10 supporting signals (titles, sources, URLs) drawn from STG_EXTERNAL_SIGNALS via the candidate''s SUPPORTING_SIGNAL_IDS, ordered by recency — these are the signals that defined the cluster'
    ),
    '(a) The strongest pre-fetched signals you reference — these come from STG_TREND_SIGNALS, visible in your context as the top 10 by pagerank. They are the cluster''s foundation. Tag each one you cite.',
    '(a) The strongest pre-fetched signals you reference — these come from STG_EXTERNAL_SIGNALS via the candidate''s SUPPORTING_SIGNAL_IDS, visible in your context as the top 10 most recent. They are the cluster''s foundation. Tag each one you cite.'
  ) AS TEMPLATE,
  MODEL_PARAMS,
  TRUE AS IS_ACTIVE,
  SHA2(CONCAT('enrichment.agent.system.v5', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'phase3_retire_stg_trend_signals' AS CREATED_BY,
  'v5: replaces "STG_TREND_SIGNALS by pagerank" language with SUPPORTING_SIGNAL_IDS-based wording. Pre-fetched data now comes from STG_EXTERNAL_SIGNALS keyed off the candidate array, ranked by SIGNAL_TIMESTAMP DESC.' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'enrichment.agent.system'
  AND VERSION = 4
  AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'enrichment.agent.system'
  AND VERSION = 4;

-- Verify: only v5 should now be active, and it should not contain STG_TREND_SIGNALS.
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%STG_TREND_SIGNALS%' THEN 'STILL HAS REF' ELSE 'clean' END AS REF_STATUS
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'enrichment.agent.system'
ORDER BY VERSION;
