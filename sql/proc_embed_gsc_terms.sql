-- Batch-fill TERM_VECTOR on FCT_TREND_GSC_TERMS for any rows the
-- merge_gsc_terms step left NULL.
--
-- Embeds at arctic-embed-m-v1.5 / 768 to stay in GSC's SEARCH_TERM_VECTORS
-- space (trend identity vectors are 1024 arctic-l-v2 and are incompatible).
-- This is a Cortex op, not a vector-search op, so it runs fine on
-- MARKETING_WH — it does NOT need CORTEX_M. It must run before
-- PROC_MATCH_GSC_DEMAND so the matcher's vector leg has vectors to compare.
--
-- Embed in Snowflake (not Pipedream JS): the SQL proxy 413's at ~256KB and
-- collapses backslashes, which mangles vector payloads.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_EMBED_GSC_TERMS()
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  n NUMBER DEFAULT 0;
BEGIN
  UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GSC_TERMS
  SET TERM_VECTOR = SNOWFLAKE.CORTEX.EMBED_TEXT_768('snowflake-arctic-embed-m-v1.5', TERM),
      EMBEDDED_AT = CURRENT_TIMESTAMP()
  WHERE TERM_VECTOR IS NULL
    AND TERM IS NOT NULL;
  n := SQLROWCOUNT;
  RETURN 'embedded ' || n || ' terms';
END;
$$;
