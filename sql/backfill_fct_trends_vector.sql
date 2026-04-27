-- One-time backfill of TREND_VECTOR on existing FCT_TRENDS rows.
-- Run AFTER alter_fct_trends_add_vector.sql but BEFORE the promotion agent's
-- first run (otherwise the neighbor pool will be empty and every candidate
-- looks novel).
--
-- Constructed-text recipe matches what proc_promotion_apply uses for new rows
-- so backfilled vectors are directly comparable to future ones:
--   TREND_TOPIC | distillation REASONING (or DIM_TREND_ENRICHMENT.SUMMARY_SHORT) | top 3 signal titles
--
-- Two passes: rows with a candidate→trend lineage get the full recipe;
-- legacy rows without lineage fall back to TREND_TOPIC only.

-- Pass 1: rows with a candidate → use full recipe
WITH ranked_signals AS (
  SELECT
    cc.CANDIDATE_ID,
    s.SIGNAL_TITLE,
    s.INGESTED_AT
  FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES cc,
       LATERAL FLATTEN(INPUT => cc.SUPPORTING_SIGNAL_IDS) f
  JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s ON s.SIGNAL_ID = f.value::STRING
  WHERE s.SIGNAL_TITLE IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY cc.CANDIDATE_ID ORDER BY s.INGESTED_AT DESC) <= 3
),
candidate_titles AS (
  SELECT CANDIDATE_ID, LISTAGG(SIGNAL_TITLE, ', ') WITHIN GROUP (ORDER BY INGESTED_AT DESC) AS TOP_TITLES
  FROM ranked_signals
  GROUP BY CANDIDATE_ID
)
UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
SET TREND_VECTOR = SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
  'snowflake-arctic-embed-l-v2.0',
  COALESCE(t.TREND_TOPIC, '') || ' | ' ||
  COALESCE(LEFT(c.REASONING, 800), '') || ' | ' ||
  COALESCE(sigs.TOP_TITLES, '')
)
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
LEFT JOIN candidate_titles sigs ON sigs.CANDIDATE_ID = c.CANDIDATE_ID
WHERE t.CANDIDATE_ID = c.CANDIDATE_ID
  AND t.TREND_VECTOR IS NULL;

-- Pass 2: legacy rows with no candidate lineage → topic only
UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
SET TREND_VECTOR = SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
  'snowflake-arctic-embed-l-v2.0',
  COALESCE(TREND_TOPIC, '')
)
WHERE TREND_VECTOR IS NULL
  AND TREND_TOPIC IS NOT NULL;
