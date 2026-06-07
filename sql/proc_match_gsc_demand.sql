-- Match each persisted per-trend search term to GSC search demand, aggregate
-- to one per-trend demand number, and append a row per trend to
-- FCT_TREND_GSC_DEMAND.
--
-- Design (driven by a 4-trend probe — see plan pure-snacking-creek.md):
--   * Per-term, NOT one blended trend vector. A single blended cosine locks
--     messy trends onto the wrong dominant token ("intranasal NAD+" -> "spray"
--     -> tamsulosin at 0.8+). Matching precise terms individually at a high
--     threshold is the fix.
--   * Hybrid two-leg match, deduped per (trend, term, query):
--       - string leg: exact equality always; ILIKE-containment ONLY for
--         multi-word terms. Single tokens get exact-only — ILIKE has no
--         semantic guard, so "fiber" must not containment-match "google fiber".
--       - vector leg: cosine >= P_THRESHOLD against the term's 768 vector.
--         The high threshold is the polysemy defense.
--   * Magnitude is QUERY_COUNT (first-party appearance frequency), never the
--     cosine. Cosine only gates.
--   * Per-trend normalization = top-K mean of per-term demand, so a vague
--     trend with many loose terms can't out-score a specific hot one by count.
--   * Squash to [0,1] via log10 / log10(REF). REF is the calibration constant
--     (tuned in M5); TREND_DEMAND_RAW is also stored so REF can be re-tuned
--     offline without re-matching.
--
-- Params:
--   P_THRESHOLD       vector-leg cosine cutoff (start 0.90)
--   P_MIN_QUERY_COUNT GSC candidate-pool floor — prefilter SEARCH_TERM_VECTORS
--                     so the cross-join cosine doesn't scan all 144M rows
--                     (>=500 ~= the GSC_HOT_VECTORS scratch; >=4000 ~30K rows
--                     for fast validation). This is the push-down lever.
--   P_TOPK            number of top per-term demands averaged per trend (3)
--   P_REF            calibration reference demand mapping to score ~1.0
--
-- MUST run on CORTEX_M — the vector leg hangs on MARKETING_WH (X-Small).
-- Run PROC_EMBED_GSC_TERMS first so TERM_VECTOR is populated.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_MATCH_GSC_DEMAND(
  P_THRESHOLD       FLOAT,
  P_MIN_QUERY_COUNT NUMBER,
  P_TOPK            NUMBER,
  P_REF             FLOAT
)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  n NUMBER DEFAULT 0;
BEGIN
  INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GSC_DEMAND
    (TREND_ID, GSC_DEMAND_SCORE, TREND_DEMAND_RAW, MATCHED_TERMS,
     MATCHED_QUERIES, MATCH_THRESHOLD, DETAIL)
  WITH terms AS (
    -- Specificity gate (applies to ALL legs, incl. vector): a term qualifies
    -- only if multi-word OR a long single token. A bare common token like
    -- "spray"/"fiber" is too polysemous — even the vector leg pulls its
    -- off-topic cluster (verified: "spray" alone pulled 9138 demand for an
    -- NAD+ trend). A specific single-word neologism ("fibremaxxing", 12ch)
    -- survives the length floor. Production terms are multi-word LLM phrases
    -- anyway (the n-gram/long-word padding is dropped upstream); this is
    -- defense-in-depth against a stray bare token reaching the table.
    SELECT TREND_ID, TERM_NORM, TERM_VECTOR,
           ARRAY_SIZE(SPLIT(TERM_NORM, ' ')) AS WORD_CT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GSC_TERMS
    WHERE TERM_VECTOR IS NOT NULL
      AND (ARRAY_SIZE(SPLIT(TERM_NORM, ' ')) >= 2 OR LENGTH(TERM_NORM) >= 8)
  ),
  pool AS (
    SELECT QUERY_TERM, QUERY_COUNT, QUERY_VECTOR
    FROM MCC_RAW.GOOGLE_SEARCH_CONSOLE.SEARCH_TERM_VECTORS
    WHERE QUERY_COUNT >= :P_MIN_QUERY_COUNT
      AND QUERY_VECTOR IS NOT NULL
  ),
  string_match AS (
    SELECT t.TREND_ID, t.TERM_NORM, p.QUERY_TERM, p.QUERY_COUNT
    FROM terms t
    JOIN pool p
      ON p.QUERY_TERM = t.TERM_NORM
         OR (t.WORD_CT >= 2 AND p.QUERY_TERM ILIKE '%' || t.TERM_NORM || '%')
  ),
  vector_match AS (
    SELECT t.TREND_ID, t.TERM_NORM, p.QUERY_TERM, p.QUERY_COUNT
    FROM terms t
    JOIN pool p
      ON VECTOR_COSINE_SIMILARITY(t.TERM_VECTOR, p.QUERY_VECTOR) >= :P_THRESHOLD
  ),
  matched AS (
    -- dedup a GSC query matched by both legs (or both for the same term)
    SELECT TREND_ID, TERM_NORM, QUERY_TERM, MAX(QUERY_COUNT) AS QUERY_COUNT
    FROM (SELECT * FROM string_match UNION ALL SELECT * FROM vector_match)
    GROUP BY TREND_ID, TERM_NORM, QUERY_TERM
  ),
  per_term AS (
    SELECT TREND_ID, TERM_NORM,
           SUM(QUERY_COUNT)        AS TERM_DEMAND,
           COUNT(*)                AS MATCHED_QUERIES
    FROM matched
    GROUP BY TREND_ID, TERM_NORM
  ),
  per_term_ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY TERM_DEMAND DESC) AS RN
    FROM per_term
  ),
  per_trend AS (
    SELECT TREND_ID,
           AVG(CASE WHEN RN <= :P_TOPK THEN TERM_DEMAND END) AS TREND_DEMAND_RAW,
           COUNT(*)                                          AS MATCHED_TERMS,
           SUM(MATCHED_QUERIES)                              AS MATCHED_QUERIES,
           ARRAY_AGG(OBJECT_CONSTRUCT('term', TERM_NORM, 'demand', TERM_DEMAND,
                                      'queries', MATCHED_QUERIES, 'rank', RN))
             WITHIN GROUP (ORDER BY RN)                      AS DETAIL
    FROM per_term_ranked
    GROUP BY TREND_ID
  )
  SELECT TREND_ID,
         LEAST(1, LOG(10, TREND_DEMAND_RAW + 1) / LOG(10, :P_REF + 1)) AS GSC_DEMAND_SCORE,
         TREND_DEMAND_RAW,
         MATCHED_TERMS,
         MATCHED_QUERIES,
         :P_THRESHOLD,
         DETAIL
  FROM per_trend;

  n := SQLROWCOUNT;
  RETURN 'wrote ' || n || ' trend demand rows (threshold=' || :P_THRESHOLD
         || ', min_query_count=' || :P_MIN_QUERY_COUNT || ', ref=' || :P_REF || ')';
END;
$$;
