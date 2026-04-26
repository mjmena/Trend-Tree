-- alter_dt_external_trend_embeddings.sql
--
-- Slice 4, step 3: collapse the amazon_trends + "other external signals"
-- branches into one. Pre-swap, amazon_trends needed a special branch
-- because its SIGNAL_ID was synthetic (`amazon_trends_kitchen-dining_2026-04-25_1`)
-- and excluded by the catch-all branch. Post-swap (swap_signal_id_to_url.sql),
-- amazon_trends SIGNAL_IDs are real URLs (`https://www.amazon.com/s?k=...`)
-- and indistinguishable in shape from other external sources.
--
-- The amazon_movers exclusion is preserved — those are individual product
-- listings, not trend-level signals, and would dilute the trend embeddings.
--
-- Dynamic table will refresh on its 1-hour target_lag automatically.

CREATE OR REPLACE DYNAMIC TABLE MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS (
    URL,
    TITLE,
    DESCRIPTION,
    SIGNAL_TYPE,
    SIGNAL_NAME,
    SOURCE_TREND_ID,
    DETECTED_AT,
    TITLE_VECTOR,
    DESCRIPTION_VECTOR
)
TARGET_LAG = '1 hour'
REFRESH_MODE = AUTO
INITIALIZE = ON_CREATE
WAREHOUSE = MARKETING_WH
AS
WITH RAW_SIGNALS AS (
    -- 1. GOOGLE TRENDS (exploded by article from STG_GOOGLE_TRENDS, separate ingest path)
    SELECT
        n.value:source::STRING                                                          AS SIGNAL_NAME,
        'GT'                                                                            AS SIGNAL_TYPE,
        t.PUB_DATE                                                                      AS DETECTED_AT,
        n.value:article_title::STRING                                                   AS TITLE,
        COALESCE(n.value:url::STRING, MD5(n.value:article_title::STRING))               AS URL,
        CONCAT('Google Trend: ', t.TREND_TITLE, ' | Source: ', n.value:source::STRING, ' | ', n.value:article_title::STRING) AS DESCRIPTION,
        t.TREND_ID                                                                      AS SOURCE_TREND_ID
    FROM MCC_RAW.MARKETING_DEV.STG_GOOGLE_TRENDS t
    INNER JOIN MCC_RAW.MARKETING_DEV.STG_GOOGLE_TREND_RELEVANCE r
        ON t.TREND_ID = r.TREND_ID AND r.IS_RELEVANT = TRUE,
    LATERAL FLATTEN(input => t.NEWS_ITEMS) n
    WHERE t.PUB_DATE >= DATEADD('day', -3, CURRENT_TIMESTAMP())

    UNION ALL

    -- 2. EXTERNAL SIGNALS (post-swap: SIGNAL_ID is canonical URL universally,
    --    so amazon_trends + bluesky + gdelt + wikimedia + google_trends_explore
    --    all collapse into one uniform branch). amazon_movers excluded —
    --    product listings dilute trend-level embeddings.
    SELECT
        s.SOURCE_NAME                                                                   AS SIGNAL_NAME,
        'EXT'                                                                           AS SIGNAL_TYPE,
        s.SIGNAL_TIMESTAMP                                                              AS DETECTED_AT,
        s.SIGNAL_TITLE                                                                  AS TITLE,
        s.SIGNAL_ID                                                                     AS URL,
        COALESCE(s.SIGNAL_TEXT, s.SIGNAL_TITLE)                                         AS DESCRIPTION,
        NULL                                                                            AS SOURCE_TREND_ID
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
    WHERE s.SOURCE_NAME != 'amazon_movers'
      AND s.SIGNAL_TIMESTAMP >= DATEADD('day', -3, CURRENT_TIMESTAMP())
)
SELECT
    URL,
    TITLE,
    DESCRIPTION,
    SIGNAL_TYPE,
    SIGNAL_NAME,
    SOURCE_TREND_ID,
    DETECTED_AT,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', TITLE)            AS TITLE_VECTOR,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', LEFT(DESCRIPTION, 512)) AS DESCRIPTION_VECTOR
FROM RAW_SIGNALS
WHERE TITLE IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY URL ORDER BY DETECTED_AT ASC) = 1;
