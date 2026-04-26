-- alter_stg_external_signals_url_migration.sql
--
-- Slice 4, step 1: add URL column (nullable) + backfill from existing data.
-- Ingester updates (slice 4, step 2) will start populating URL on every new
-- write. Once a soak window confirms parity, a follow-up migration will
-- swap SIGNAL_ID ↔ URL so URL becomes the natural cross-source dedup key.
--
-- Per-source URL construction:
--   wikimedia, amazon_movers, gdelt          → metadata.url (already canonical-ish)
--   bluesky                                  → at:// uri → https://bsky.app/profile/{did}/post/{rkey}
--   amazon_trends                            → https://www.amazon.com/s?k={slug}&i={dept}
--   google_trends_explore                    → https://trends.google.com/trends/explore?q={query}&geo={geo}
--   tiktok, pinterest, reddit (when active)  → handled in url_canon.mjs at ingestion time
--
-- This migration is non-destructive: SIGNAL_ID is untouched. Adding a
-- nullable column has no impact on existing readers. Backfill UPDATEs
-- only set URL where currently NULL — safe to re-run.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- Step 1: Add URL column (nullable, no default)
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE STG_EXTERNAL_SIGNALS
    ADD COLUMN IF NOT EXISTS URL VARCHAR;

COMMENT ON COLUMN STG_EXTERNAL_SIGNALS.URL IS
'Canonical URL for the signal. For content sources (gdelt/bluesky/wikimedia/amazon_movers), points to the actual hosted item. For aggregation sources (amazon_trends/google_trends_explore/tiktok/pinterest), points to the aggregator page that produced the signal. Cross-source dedup key. Future migration will rename URL→SIGNAL_ID once ingesters and downstream readers are updated.';

-- ════════════════════════════════════════════════════════════════════════
-- Step 2: Backfill URL from existing data
-- ════════════════════════════════════════════════════════════════════════

-- ── wikimedia: metadata.url is already https://en.wikipedia.org/wiki/{title} ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = METADATA:url::STRING
WHERE SOURCE_NAME = 'wikimedia'
  AND URL IS NULL
  AND METADATA:url IS NOT NULL;

-- ── amazon_movers: metadata.url is already https://www.amazon.com/dp/{asin} ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = METADATA:url::STRING
WHERE SOURCE_NAME = 'amazon_movers'
  AND URL IS NULL
  AND METADATA:url IS NOT NULL;

-- ── gdelt: metadata.url is the article URL; live ingester will canonicalize
--    going forward (strip utm/fbclid/gclid, follow redirects, AMP rewrite).
--    Backfill takes raw value as-is. ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = METADATA:url::STRING
WHERE SOURCE_NAME = 'gdelt'
  AND URL IS NULL
  AND METADATA:url IS NOT NULL;

-- ── bluesky: convert metadata.uri (at://did:plc:xxx/app.bsky.feed.post/yyy)
--    to web URL (https://bsky.app/profile/{did}/post/{rkey}).
--    SPLIT_PART skips the at:// prefix and pulls the did + rkey by index. ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = 'https://bsky.app/profile/'
       || SPLIT_PART(METADATA:uri::STRING, '/', 3)
       || '/post/'
       || SPLIT_PART(METADATA:uri::STRING, '/', 5)
WHERE SOURCE_NAME = 'bluesky'
  AND URL IS NULL
  AND METADATA:uri IS NOT NULL
  AND METADATA:uri::STRING LIKE 'at://%';

-- ── amazon_trends: aggregation source. URL = Amazon search for the theme
--    in the matching department. Slug from SIGNAL_TITLE: lowercase + dash.
--    REGEXP_REPLACE strips non-alphanumerics, then collapses dashes. ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = 'https://www.amazon.com/s?k='
       || REGEXP_REPLACE(REGEXP_REPLACE(LOWER(SIGNAL_TITLE), '[^a-z0-9]+', '-'), '(^-+|-+$)', '')
       || '&i='
       || COALESCE(METADATA:department::STRING, 'all')
WHERE SOURCE_NAME = 'amazon_trends'
  AND URL IS NULL;

-- ── google_trends_explore: URL = Google Trends explore page for the query.
--    SIGNAL_TITLE is the search query (already lowercased + spaces).
--    URL-encode spaces to + (browsers accept either + or %20). ──
UPDATE STG_EXTERNAL_SIGNALS
SET URL = 'https://trends.google.com/trends/explore?q='
       || REPLACE(SIGNAL_TITLE, ' ', '+')
       || '&geo='
       || COALESCE(METADATA:geo::STRING, 'US')
WHERE SOURCE_NAME = 'google_trends_explore'
  AND URL IS NULL;

-- ════════════════════════════════════════════════════════════════════════
-- Verification queries (run manually after backfill)
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Coverage by source:
--   SELECT SOURCE_NAME, COUNT(*) AS total,
--          COUNT(URL) AS with_url,
--          COUNT(*) - COUNT(URL) AS missing_url
--   FROM STG_EXTERNAL_SIGNALS
--   GROUP BY SOURCE_NAME ORDER BY total DESC;
--
-- 2. Spot-check that URLs are well-formed:
--   SELECT SOURCE_NAME, URL FROM STG_EXTERNAL_SIGNALS
--   WHERE URL IS NOT NULL
--   QUALIFY ROW_NUMBER() OVER (PARTITION BY SOURCE_NAME ORDER BY SIGNAL_TIMESTAMP DESC) <= 2
--   ORDER BY SOURCE_NAME;
--
-- 3. Cross-source dedup demonstration (find URLs from multiple sources):
--   SELECT URL, COUNT(DISTINCT SOURCE_NAME) AS n_sources, ARRAY_AGG(DISTINCT SOURCE_NAME)
--   FROM STG_EXTERNAL_SIGNALS WHERE URL IS NOT NULL
--   GROUP BY URL HAVING COUNT(DISTINCT SOURCE_NAME) > 1
--   LIMIT 10;
