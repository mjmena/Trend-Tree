-- Staging: Third-party trend signals (GDELT, Wikimedia, Bluesky, Pinterest, TikTok, Amazon)
-- Database: MCC_RAW.MARKETING_DEV

create or replace table MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS (
    SIGNAL_ID VARCHAR(16777216),  -- canonical URL identity (Option D); widened from 255 — see sql/alter_signal_id_widen.sql
    INGESTED_AT TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(),
    SOURCE_NAME VARCHAR(50),
    SIGNAL_TIMESTAMP TIMESTAMP_NTZ(9),
    SIGNAL_TITLE VARCHAR(16777216),
    SIGNAL_TEXT VARCHAR(16777216),
    METADATA VARIANT
) COMMENT = 'Staging table for third-party trend signals (GDELT, Wikimedia, Bluesky, Pinterest, TikTok, Amazon)';
