-- Backfill HEADLINE_METRIC for existing rows where it is NULL.
-- Root cause: enrich_trend.mjs and enrich_trend_inline.mjs used unprefixed property
-- names (e.g. article_count_7d) but enrichment steps return prefixed keys
-- (e.g. gdelt_article_count_7d). The METRICS column holds the full JSON payload,
-- so we can extract the correct values retroactively.

-- Remove sources no longer in the workflow
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE SOURCE_NAME IN ('reddit', 'mcclatchy');

-- Backfill HEADLINE_METRIC + HEADLINE_METRIC_NAME for all 7 sources.
-- Run SET on both columns unconditionally so stale names from old deploys are corrected.
UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
SET
  HEADLINE_METRIC = CASE SOURCE_NAME
    WHEN 'gdelt'         THEN METRICS:gdelt_article_count_7d::FLOAT
    WHEN 'wikimedia'     THEN METRICS:wiki_pageviews_7d::FLOAT
    WHEN 'bluesky'       THEN METRICS:social_post_count_7d::FLOAT
    WHEN 'google_trends' THEN METRICS:gt_interest_score::FLOAT
    WHEN 'amazon'        THEN METRICS:amazon_product_count::FLOAT
    WHEN 'pinterest'     THEN METRICS:pinterest_trend_count::FLOAT
    WHEN 'tiktok'        THEN METRICS:tiktok_hashtag_count::FLOAT
  END,
  HEADLINE_METRIC_NAME = CASE SOURCE_NAME
    WHEN 'gdelt'         THEN 'gdelt_article_count_7d'
    WHEN 'wikimedia'     THEN 'wiki_pageviews_7d'
    WHEN 'bluesky'       THEN 'social_post_count_7d'
    WHEN 'google_trends' THEN 'gt_interest_score'
    WHEN 'amazon'        THEN 'amazon_product_count'
    WHEN 'pinterest'     THEN 'pinterest_trend_count'
    WHEN 'tiktok'        THEN 'tiktok_hashtag_count'
  END
WHERE SOURCE_NAME IN ('gdelt', 'wikimedia', 'bluesky', 'google_trends', 'amazon', 'pinterest', 'tiktok');
