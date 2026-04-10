-- Dynamic Table: External trend signal embeddings (Google Trends, third-party)
-- Source: STG_GOOGLE_TRENDS (flattened NEWS_ITEMS), STG_EXTERNAL_SIGNALS
-- Refresh: Auto, 1-hour lag
-- Database: MCC_RAW.MARKETING_DEV

create or replace dynamic table MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS(
    URL,
    TITLE,
    DESCRIPTION,
    SIGNAL_TYPE,
    SIGNAL_NAME,
    SOURCE_TREND_ID,
    DETECTED_AT,
    TITLE_VECTOR,
    DESCRIPTION_VECTOR
) target_lag = '1 hour' refresh_mode = AUTO initialize = ON_CREATE warehouse = MARKETING_WH
 as
WITH RAW_SIGNALS AS (
    -- 1. GOOGLE TRENDS (exploded by article)
    SELECT
        n.value:source::STRING as SIGNAL_NAME,
        'GT' as SIGNAL_TYPE,
        t.PUB_DATE as DETECTED_AT,
        n.value:article_title::STRING as TITLE,
        COALESCE(n.value:url::STRING, MD5(n.value:article_title::STRING)) as URL,
        CONCAT('Google Trend: ', t.TREND_TITLE, ' | Source: ', n.value:source::STRING, ' | ', n.value:article_title::STRING) as DESCRIPTION,
        t.TREND_ID as SOURCE_TREND_ID
    FROM MCC_RAW.MARKETING_DEV.STG_GOOGLE_TRENDS t
    INNER JOIN MCC_RAW.MARKETING_DEV.STG_GOOGLE_TREND_RELEVANCE r
        ON t.TREND_ID = r.TREND_ID AND r.IS_RELEVANT = TRUE,
    LATERAL FLATTEN(input => t.NEWS_ITEMS) n
    WHERE t.PUB_DATE >= DATEADD('day', -3, CURRENT_TIMESTAMP())

    UNION ALL

    -- 2. AGGREGATED AMAZON TRENDS (category-level, not individual products)
    SELECT
        s.SOURCE_NAME as SIGNAL_NAME,
        'EXT' as SIGNAL_TYPE,
        s.SIGNAL_TIMESTAMP as DETECTED_AT,
        s.SIGNAL_TITLE as TITLE,
        s.SIGNAL_ID as URL,
        s.SIGNAL_TEXT as DESCRIPTION,
        NULL as SOURCE_TREND_ID
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
    WHERE s.SOURCE_NAME = 'amazon_trends'
        AND s.SIGNAL_TIMESTAMP >= DATEADD('day', -3, CURRENT_TIMESTAMP())

    UNION ALL

    -- 3. OTHER EXTERNAL SIGNALS (wikimedia, gdelt, bluesky, reddit, etc.)
    SELECT
        s.SOURCE_NAME as SIGNAL_NAME,
        'EXT' as SIGNAL_TYPE,
        s.SIGNAL_TIMESTAMP as DETECTED_AT,
        s.SIGNAL_TITLE as TITLE,
        COALESCE(
            NULLIF(s.METADATA:url::STRING, ''),
            NULLIF(s.METADATA:embedded_url::STRING, ''),
            CASE WHEN s.SIGNAL_ID LIKE '%://%' THEN s.SIGNAL_ID ELSE NULL END
        ) as URL,
        COALESCE(s.SIGNAL_TEXT, s.SIGNAL_TITLE) as DESCRIPTION,
        NULL as SOURCE_TREND_ID
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
    WHERE s.SOURCE_NAME != 'amazon_movers'
        AND s.SOURCE_NAME != 'amazon_trends'
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
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', TITLE) as TITLE_VECTOR,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', LEFT(DESCRIPTION, 512)) as DESCRIPTION_VECTOR
FROM RAW_SIGNALS
WHERE TITLE IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY URL ORDER BY DETECTED_AT ASC) = 1;
