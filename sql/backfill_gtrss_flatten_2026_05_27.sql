-- One-shot 24h backfill: re-ingest the last 24h of google_trends_rss raw
-- rows into the flattened article-per-row shape so clustering has fresh
-- material immediately, without waiting for live ingest to produce
-- enough volume.
--
-- Run AFTER the fetch_source/entry.js refactor is live and verified
-- emitting flattened_news_item rows. Old-shape rows older than 24h stay
-- as-is; new article-URL SIGNAL_IDs don't collide with the legacy
-- explore-URL SIGNAL_IDs, so this is purely additive.
--
-- Volume estimate: ~800–900 rows. Cortex embed cost ≈ $0.05–0.10.

USE ROLE MARKETING_ENGINEER;
USE WAREHOUSE MARKETING_WH;
USE DATABASE MCC_PRESENTATION;
USE SCHEMA TREND_AGENT;

-- Preview (run interactively before the INSERT to confirm row count):
--
-- WITH raw AS (
--     SELECT
--         s.SIGNAL_TIMESTAMP                                   AS signal_timestamp,
--         ni.value:url::STRING                                 AS article_url
--     FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s,
--          LATERAL FLATTEN(input => s.METADATA:news_items) ni
--     WHERE s.SOURCE_NAME = 'google_trends_rss'
--       AND s.SIGNAL_TIMESTAMP > DATEADD(hour, -24, CURRENT_TIMESTAMP())
--       AND ni.value:url::STRING IS NOT NULL
--       AND ni.value:url::STRING != ''
-- ),
-- deduped AS (
--     SELECT article_url, signal_timestamp
--     FROM raw
--     QUALIFY ROW_NUMBER() OVER (PARTITION BY article_url ORDER BY signal_timestamp ASC) = 1
-- )
-- SELECT COUNT(*) AS to_insert,
--        MIN(signal_timestamp) AS earliest,
--        MAX(signal_timestamp) AS latest
-- FROM deduped d
-- WHERE NOT EXISTS (
--     SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
--     WHERE f.SIGNAL_ID = d.article_url
-- );

INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS (
    SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP,
    SIGNAL_TITLE, SIGNAL_TEXT, METADATA, SIGNAL_VECTOR
)
WITH raw AS (
    SELECT
        s.SIGNAL_ID                                          AS parent_signal_id,
        s.SIGNAL_TIMESTAMP                                   AS signal_timestamp,
        s.METADATA:approx_traffic::STRING                    AS approx_traffic,
        s.METADATA:geo::STRING                               AS geo,
        REPLACE(REPLACE(s.SIGNAL_ID,
            'https://trends.google.com/trends/explore?q=', ''),
            '&geo=US', '')                                   AS gt_trending_query,
        ni.value:url::STRING                                 AS article_url,
        ni.value:article_title::STRING                       AS article_title
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s,
         LATERAL FLATTEN(input => s.METADATA:news_items) ni
    WHERE s.SOURCE_NAME = 'google_trends_rss'
      AND s.SIGNAL_TIMESTAMP > DATEADD(hour, -24, CURRENT_TIMESTAMP())
      AND ni.value:url::STRING IS NOT NULL
      AND ni.value:url::STRING != ''
),
deduped AS (
    SELECT *,
        LOWER(REGEXP_REPLACE(
            REGEXP_SUBSTR(article_url, 'https?://([^/]+)', 1, 1, 'e', 1),
            '^www\\.', '')) AS publisher_domain
    FROM raw
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY article_url
        ORDER BY signal_timestamp ASC
    ) = 1
)
SELECT
    d.article_url                                            AS SIGNAL_ID,
    'google_trends_rss'                                      AS SOURCE_NAME,
    d.signal_timestamp,
    d.article_title                                          AS SIGNAL_TITLE,
    d.article_title || ' — via ' || d.publisher_domain       AS SIGNAL_TEXT,
    OBJECT_CONSTRUCT(
        'geo',               d.geo,
        'type',              'flattened_news_item',
        'gt_trending_query', d.gt_trending_query,
        'gt_approx_traffic', d.approx_traffic,
        'publisher',         d.publisher_domain,
        'url',               d.article_url,
        'backfilled',        TRUE
    )                                                        AS METADATA,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
        'snowflake-arctic-embed-l-v2.0',
        d.article_title || ' ' ||
            LEFT(d.article_title || ' — via ' || d.publisher_domain, 512)
    )                                                        AS SIGNAL_VECTOR
FROM deduped d
WHERE NOT EXISTS (
    SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
    WHERE f.SIGNAL_ID = d.article_url
)
AND d.publisher_domain IS NOT NULL;

-- Post-run verification:
--
-- SELECT COUNT(*),
--        MIN(SIGNAL_TIMESTAMP),
--        MAX(SIGNAL_TIMESTAMP)
-- FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
-- WHERE SOURCE_NAME = 'google_trends_rss'
--   AND METADATA:type::STRING = 'flattened_news_item'
--   AND METADATA:backfilled::BOOLEAN = TRUE;
