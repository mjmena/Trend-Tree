-- Dynamic Table: LLM-generated trend signal embeddings
-- Source: STG_LLM_PROMPT_LOGS (flattened RESPONSE array)
-- Refresh: Auto, 1-hour lag
-- Database: MCC_RAW.MARKETING_DEV

create or replace dynamic table MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS(
    INGESTION_ID,
    URL,
    TITLE,
    DESCRIPTION,
    SIGNAL_TYPE,
    SIGNAL_NAME,
    DETECTED_AT,
    TITLE_VECTOR,
    DESCRIPTION_VECTOR
) target_lag = '1 hour' refresh_mode = AUTO initialize = ON_CREATE warehouse = MARKETING_WH
 as
WITH RAW_SIGNALS AS (
    SELECT
        l.INGESTION_ID,
        l.MODEL_NAME as SIGNAL_NAME,
        'LLM' as SIGNAL_TYPE,
        l.CREATED_AT_UTC as DETECTED_AT,
        f.value:trend::STRING as TITLE,
        COALESCE(
            -- New format: construct Google Trends URL from search_query
            CASE WHEN f.value:search_query IS NOT NULL
                 THEN CONCAT('https://trends.google.com/trends/explore?q=',
                             REPLACE(f.value:search_query::STRING, ' ', '+'),
                             '&date=now%207-d&geo=US')
                 ELSE NULL END,
            -- Old format: use existing url if it looks like a real URL
            CASE WHEN f.value:url::STRING LIKE '%://%' THEN f.value:url::STRING ELSE NULL END,
            -- Fallback: hash for dedup
            MD5(COALESCE(f.value:search_query::STRING, '') || l.MODEL_NAME || f.value:trend::STRING)
        ) as URL,
        CONCAT('Context: ', f.value:description::STRING, ' | Content: ', f.value:trend::STRING, ': ', f.value:description::STRING) as DESCRIPTION
    FROM MCC_RAW.MARKETING_DEV.STG_LLM_PROMPT_LOGS l,
    LATERAL FLATTEN(input => l.RESPONSE) f
    WHERE l.CREATED_AT_UTC >= DATEADD('day', -30, CURRENT_TIMESTAMP())
)
SELECT
    INGESTION_ID,
    URL,
    TITLE,
    DESCRIPTION,
    SIGNAL_TYPE,
    SIGNAL_NAME,
    DETECTED_AT,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', TITLE) as TITLE_VECTOR,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', DESCRIPTION) as DESCRIPTION_VECTOR
FROM RAW_SIGNALS
WHERE TITLE IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY URL ORDER BY LENGTH(DESCRIPTION) DESC) = 1;
