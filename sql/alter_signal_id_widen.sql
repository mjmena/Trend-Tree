-- alter_signal_id_widen.sql  (issue #45, applied 2026-06-10)
--
-- SIGNAL_ID = canonical URL (Option D, swap_signal_id_to_url.sql), but the
-- column stayed VARCHAR(255) from the pre-swap identifier era. Long article
-- URLs from the Google Trends RSS flatten (reviewjournal.com with UTM params,
-- mynews4.com / fox17.com long slugs with NO params) overflowed it, making
-- MERGE_EXTERNAL_SIGNALS throw "String ... would be truncated" and drop the
-- whole batch ~daily.
--
-- Widening is metadata-only in Snowflake (no storage/perf cost) and keeps the
-- URL-as-identity design intact across the whole key chain — hashing only the
-- overflowing source would have broken cross-source URL dedup.
--
-- Companion changes (same date):
--   * TASK_PROMOTE_TREND_SIGNALS link filter raised 255 -> 2048
--     (fct_trend_signals.sql) — its "wider than the column can't match"
--     premise died with this widen.
--   * google-trends RSS ingester now canonicalizes URLs (strips tracking
--     params) and skips URLs > 2048 chars as malformed.
--   * discovery canonicalize_and_validate URL cap raised 255 -> 2048.
--
-- Verified 2026-06-10: DT_TREND_DASHBOARD / DT_TREND_DAILY expose no
-- VARCHAR(255) output columns derived from SIGNAL_ID (it's only joined /
-- aggregated), so the widen does not change any dynamic-table schema.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
    ALTER COLUMN SIGNAL_ID SET DATA TYPE VARCHAR(16777216);

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS_TEST
    ALTER COLUMN SIGNAL_ID SET DATA TYPE VARCHAR(16777216);

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
    ALTER COLUMN SIGNAL_ID SET DATA TYPE VARCHAR(16777216);

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
    ALTER COLUMN SIGNAL_ID SET DATA TYPE VARCHAR(16777216);
