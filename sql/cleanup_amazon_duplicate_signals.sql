-- Cleanup: Remove old date-based Amazon + TikTok SIGNAL_IDs from STG_EXTERNAL_SIGNALS
--
-- Root cause: Both ingest_amazon_movers.mjs and ingest_tiktok_trending.mjs used
-- SIGNAL_ID = "{source}_{id}_{date}", creating a new row per item per day. The 7-day
-- enricher query returned up to 7 copies per product/hashtag, inflating counts.
--
-- Fix deployed: SIGNAL_IDs changed to "{source}_{id}" (no date). This cleanup removes
-- old date-suffixed rows. Safe to run after both new ingest versions deploy.
--
-- Run once after deploying:
--   ingest_amazon_movers.mjs v0.0.4+
--   ingest_tiktok_trending.mjs v0.0.7+

-- Amazon: old IDs like "amazon_movers_B0FLKGV6K2_20260330"
DELETE FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SOURCE_NAME = 'amazon_movers'
  AND SIGNAL_ID REGEXP 'amazon_movers_[A-Z0-9]{10}_[0-9]{8}';

-- TikTok: old IDs like "tiktok_7012345678_20260330"
DELETE FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SOURCE_NAME = 'tiktok'
  AND SIGNAL_ID REGEXP 'tiktok_[^_]+_[0-9]{8}$';

-- Verify: both should return 0 after cleanup
SELECT 'amazon_old' AS check_name, COUNT(*) AS remaining_rows
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SOURCE_NAME = 'amazon_movers'
  AND SIGNAL_ID REGEXP 'amazon_movers_[A-Z0-9]{10}_[0-9]{8}'
UNION ALL
SELECT 'tiktok_old', COUNT(*)
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SOURCE_NAME = 'tiktok'
  AND SIGNAL_ID REGEXP 'tiktok_[^_]+_[0-9]{8}$';
