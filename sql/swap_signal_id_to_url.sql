-- swap_signal_id_to_url.sql
--
-- Slice 4, step 2 (Option D): make SIGNAL_ID = canonical URL.
-- Snapshots existing SIGNAL_IDs into LEGACY_SIGNAL_ID for the soak window
-- (~14d), then overwrites SIGNAL_ID with the canonical URL backfilled in
-- alter_stg_external_signals_url_migration.sql.
--
-- Rows where URL IS NULL (tiktok/pinterest/smoke/orphans) keep their old
-- SIGNAL_ID for now — those sources need ingester migration before the
-- URL column can be populated.
--
-- HISTORICAL JOIN BREAK: STG_TREND_CANDIDATES_AGENT.SUPPORTING_SIGNAL_IDS
-- arrays still reference the old (legacy) IDs. After this swap, joining
-- those arrays to STG_EXTERNAL_SIGNALS.SIGNAL_ID will MISS. To keep
-- historical candidates queryable during the soak, join against
-- LEGACY_SIGNAL_ID instead. After the soak, LEGACY_SIGNAL_ID gets dropped
-- and historical references become permanently broken — acceptable given
-- STG_TREND_CANDIDATES_AGENT is the Phase 1 shadow table.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- Step 1: snapshot the existing SIGNAL_IDs.
ALTER TABLE STG_EXTERNAL_SIGNALS
    ADD COLUMN IF NOT EXISTS LEGACY_SIGNAL_ID VARCHAR;

COMMENT ON COLUMN STG_EXTERNAL_SIGNALS.LEGACY_SIGNAL_ID IS
'Pre-swap SIGNAL_ID value (source-prefixed identifier like "wiki_20260424_Lisa_Marie_Presley"). Preserved for the 14d soak so historical joins from STG_TREND_CANDIDATES_AGENT.SUPPORTING_SIGNAL_IDS arrays can still resolve via WHERE LEGACY_SIGNAL_ID = sid. Drop after soak.';

-- Step 2: copy current SIGNAL_ID into LEGACY_SIGNAL_ID. Idempotent.
UPDATE STG_EXTERNAL_SIGNALS
SET LEGACY_SIGNAL_ID = SIGNAL_ID
WHERE LEGACY_SIGNAL_ID IS NULL
  AND SIGNAL_ID IS NOT NULL;

-- Step 3: swap. SIGNAL_ID := URL where we have a URL. Rows without URL
-- (tiktok/pinterest/smoke/orphans) keep their old SIGNAL_ID — those
-- sources will be addressed via ingester updates.
UPDATE STG_EXTERNAL_SIGNALS
SET SIGNAL_ID = URL
WHERE URL IS NOT NULL
  AND (SIGNAL_ID IS NULL OR SIGNAL_ID != URL);

-- ════════════════════════════════════════════════════════════════════════
-- Verification (run after to confirm the swap took)
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. SIGNAL_IDs that look like URLs (post-swap):
--   SELECT SOURCE_NAME, COUNT(*) AS total,
--          COUNT(CASE WHEN SIGNAL_ID LIKE 'http%' THEN 1 END) AS url_shaped,
--          COUNT(CASE WHEN SIGNAL_ID NOT LIKE 'http%' THEN 1 END) AS legacy_shaped
--   FROM STG_EXTERNAL_SIGNALS
--   GROUP BY SOURCE_NAME ORDER BY total DESC;
--
-- 2. LEGACY_SIGNAL_ID populated:
--   SELECT COUNT(*) FROM STG_EXTERNAL_SIGNALS WHERE LEGACY_SIGNAL_ID IS NOT NULL;
--
-- 3. Historical candidate join via LEGACY_SIGNAL_ID still resolves:
--   SELECT s.SOURCE_NAME, COUNT(*)
--   FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT c,
--        LATERAL FLATTEN(input => c.SUPPORTING_SIGNAL_IDS) sid
--   JOIN STG_EXTERNAL_SIGNALS s ON s.LEGACY_SIGNAL_ID = sid.value::STRING
--   WHERE c.AGENT_SESSION_ID = 'sess-279003ba-209a-45da-a0f7-6574645a0f1f'
--   GROUP BY 1;
