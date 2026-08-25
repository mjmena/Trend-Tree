-- PREDICTION COVERAGE DETECTION (CRMA-767) -- the standalone, runnable form
-- of the statement the prediction service issues for every re-evaluation
-- sweep. Nothing creates or alters an object here: this file is a *query*,
-- and the served copy lives in
-- services/prediction/prediction_service/coverage/detect.py
-- (COVERAGE_DETECTION_QUERY). Nothing is deployed by committing it.
--
-- The two files are held to the same constants by
-- services/prediction/tests/test_coverage_detect.py, so a threshold or
-- dedupe change made in one and forgotten in the other fails the suite.
--
-- WHAT IT ANSWERS: "has McClatchy already published about this prediction's
-- subject?" The prediction's SUBJECT_DESCRIPTOR is embedded at 768 dims with
-- Cortex and cosine-matched against the data team's story embeddings in
-- MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS.KEY_WORDS_VECTOR (also 768-dim /
-- arctic-embed-m-v1.5). CUE_CONTENT_VECTORS is read exactly as-is -- no
-- content re-embedding, Path A, the same reuse CRMA-452 established for the
-- trend-side content match. This is a SEPARATE vector space from the trend's
-- canonical 1024-dim TREND_VECTOR (arctic-embed-l-v2.0); the two are never
-- compared to each other.
--
-- WHAT IT MAY NEVER DO: results land in EVIDENCE.coverage on the prediction
-- verdict ledger and nowhere else. No coverage-derived row is ever written to
-- STG_EXTERNAL_SIGNALS, FCT_SIGNALS, or any trend-scoring path -- evidence
-- purity, CONTEXT.md. Consumption is demote-only: a detection may lower a
-- prediction's posture from "act" to "watch/covered" and can never raise
-- CONFIDENCE or corroborate a trend. The read-only shape of this statement
-- is half of that guarantee; coverage/isolation.py is the other half.
--
-- INCLUSIVE BY CONSTRUCTION (commerce + wire + staff): CUE_CONTENT_VECTORS
-- carries no content-type, byline or credit-line column at all -- its whole
-- schema is PUBLISHED_DATE, CONTENTID, HEADLINE, KEYWORDS, KEY_WORDS_VECTOR,
-- CLUSTER_ID, CLUSTER_DESCRIPTION (verified 2026-08-24) -- so no content
-- class is or can be filtered out below. Excluding one would mean *adding* a
-- join to reach a column that says which class a story is.
--
-- CALIBRATION (2026-08-24, live):
--   * MIN_SIMILARITY = 0.78. Measured over ten live SUBJECT_DESCRIPTOR
--     values from FCT_PREDICTION_VERDICT_LEDGER against the 180-day pool
--     this statement defines. The sample held exactly one genuine piece of
--     McClatchy coverage of a prediction's subject -- 'protein coffee' ->
--     "Protein coffee: How the trending drink is changing the way Americans
--     fuel their mornings" (CONTENTID 316520398, 2026-07-15) -- and it
--     scored 0.8172. The best ADJACENT, non-covering hit across all ten
--     subjects scored 0.7730 ('continuous hormone monitor' -> a
--     perimenopause-symptoms explainer). 0.78 sits in that gap.
--     The gap is narrow, so the error direction is deliberate: genuine
--     coverage that scores low is missed ('filtered showerhead' ->
--     "Everything You Need To Know About Shower Filters" sits at 0.7047 and
--     does not clear the bar). A missed detection leaves a call where the
--     external evidence put it; a false detection silently demotes a live
--     call on a story that is not about it.
--   * WINDOW_DAYS = 180, matching sql/task_recompute_content_matches.sql so
--     the trend-side and prediction-side readings of "have we written about
--     this" span the same corpus.
--   * MIN_HEADLINE_CHARS = 30 -- the junk floor. CMS test rows ("test",
--     "Test QA3", "BE Sanity validation", "related Carousel") sit in the
--     live pool and scored 0.72-0.75 against short subject descriptors,
--     ABOVE every genuine adjacency for niche subjects such as 'urolithin A'.
--     All of them are under 30 characters; real McClatchy headlines are not.
--     ARRAY_SIZE(KEYWORDS) > 0 is the same argument: in a 30-day window,
--     66,612 rows carried no headline, 43,844 of those still carried a
--     vector, and only 3,046 carried any keywords -- a stored vector over an
--     empty keyword list is noise wearing the shape of a reading.
--
-- DEDUPE RULE -- syndicated duplicates counted once: one detection per
-- case- and punctuation-folded headline
-- (TRIM(REGEXP_REPLACE(LOWER(HEADLINE), '[^0-9a-z]+', ' '))). A syndicated
-- story runs on many McClatchy sites and lands here once per publication --
-- same headline, same keyword vector, different CONTENTID -- so folding on
-- the headline counts it once and reports how many rows collapsed into it
-- (SYNDICATED_COPIES) with the earliest and latest publication dates.
-- Deliberately the headline and NOT CLUSTER_ID: clusters group *related*
-- stories (863 across a 180-day, 485k-row window), which would count a whole
-- topic once rather than a whole syndication once.
--
-- STANDALONE VERIFICATION (AC1) -- run this file as-is. Expected against the
-- live pool on 2026-08-24:
--   * 'protein coffee'  -> exactly 1 detection, CONTENT_ID 316520398,
--                          SIMILARITY 0.8172.
--   * 'urolithin A'     -> 0 detections (top hit 0.6970, well under the bar).
--   * lowering min_similarity to 0.70 surfaces the syndication case:
--     'functional beer' -> "A relaxed weekend hangout featuring friendly
--     pickleball matches..." returns as ONE row with SYNDICATED_COPIES = 2,
--     FIRST_PUBLISHED_DATE 2026-03-04, LAST_PUBLISHED_DATE 2026-04-01.
--
-- The service binds subjects one per %(subject_N)s and the four numbers as
-- named binds; the params CTE below is the same statement with the binds
-- written out, so it can be pasted into a worksheet unchanged.

WITH params AS (
    SELECT
        0.78::FLOAT AS min_similarity,
        180         AS window_days,
        30          AS min_headline_chars,
        5           AS detection_limit,
        'snowflake-arctic-embed-m-v1.5' AS embed_model
),
SUBJECTS AS (
              SELECT 'protein coffee' AS SUBJECT_DESCRIPTOR
    UNION ALL SELECT 'urolithin A'
    UNION ALL SELECT 'functional beer'
),
SUBJECT_VECTORS AS (
    SELECT
        s.SUBJECT_DESCRIPTOR,
        SNOWFLAKE.CORTEX.EMBED_TEXT_768(p.embed_model, s.SUBJECT_DESCRIPTOR) AS SUBJECT_VECTOR
    FROM SUBJECTS s, params p
),
POOL AS (
    SELECT
        c.CONTENTID,
        c.HEADLINE,
        c.PUBLISHED_DATE,
        c.KEY_WORDS_VECTOR,
        TRIM(REGEXP_REPLACE(LOWER(c.HEADLINE), '[^0-9a-z]+', ' ')) AS HEADLINE_FOLD
    FROM MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS c, params p
    WHERE c.PUBLISHED_DATE >= DATEADD('day', -p.window_days, CURRENT_DATE())
      AND c.KEY_WORDS_VECTOR IS NOT NULL
      AND c.HEADLINE IS NOT NULL
      AND ARRAY_SIZE(c.KEYWORDS) > 0
      AND LENGTH(TRIM(c.HEADLINE)) >= p.min_headline_chars
),
FOLDED AS (
    SELECT
        s.SUBJECT_DESCRIPTOR,
        p.HEADLINE_FOLD,
        MIN(p.CONTENTID)      AS CONTENT_ID,
        MIN(p.HEADLINE)       AS HEADLINE,
        MIN(p.PUBLISHED_DATE) AS FIRST_PUBLISHED_DATE,
        MAX(p.PUBLISHED_DATE) AS LAST_PUBLISHED_DATE,
        COUNT(*)              AS SYNDICATED_COPIES,
        MAX(VECTOR_COSINE_SIMILARITY(s.SUBJECT_VECTOR, p.KEY_WORDS_VECTOR)::FLOAT) AS SIMILARITY
    FROM POOL p
    CROSS JOIN SUBJECT_VECTORS s
    GROUP BY s.SUBJECT_DESCRIPTOR, p.HEADLINE_FOLD
)
SELECT
    f.SUBJECT_DESCRIPTOR,
    f.CONTENT_ID,
    f.HEADLINE,
    f.FIRST_PUBLISHED_DATE,
    f.LAST_PUBLISHED_DATE,
    f.SYNDICATED_COPIES,
    ROUND(f.SIMILARITY, 4) AS SIMILARITY
FROM FOLDED f, params p
WHERE f.SIMILARITY >= p.min_similarity
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY f.SUBJECT_DESCRIPTOR ORDER BY f.SIMILARITY DESC, f.CONTENT_ID ASC
) <= p.detection_limit
ORDER BY f.SUBJECT_DESCRIPTOR ASC, f.SIMILARITY DESC, f.CONTENT_ID ASC;
