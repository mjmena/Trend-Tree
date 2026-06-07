-- Daily refresh of per-trend GSC search-demand: embed any new terms, then
-- match + aggregate into FCT_TREND_GSC_DEMAND.
--
-- ⚠️ GATED: do NOT create this task in Snowflake until the M5 validation
-- kill-gate passes AND the REF calibration constant below is tuned on a real
-- ~20-40 trend term sample. The mechanism is validated (polysemy defended,
-- clean ranking) but the log-squash REF needs tuning — at REF=100000 the
-- score compresses (raw 26x -> score 1.4x). See plan pure-snacking-creek.md M5.
--
-- WAREHOUSE = CORTEX_M is mandatory and fixed at CREATE TASK time: the
-- matcher's vector leg hangs on MARKETING_WH (X-Small), and MARKETING_ENGINEER
-- cannot ALTER a warehouse afterward. Do NOT copy the MARKETING_WH pattern
-- from task_classify_google_trends.sql.
--
-- GSC source tables lag reality ~4 days; a daily cron is fine for a slow heat
-- slot. Off-minute schedule avoids colliding with other 14:00-ish jobs.
--
-- Params to PROC_MATCH_GSC_DEMAND: (threshold, min_query_count, topk, ref).
--   threshold 0.90  — vector cosine cutoff (polysemy defense; validated)
--   min_query_count 500 — production candidate-pool floor
--   topk 3          — per-trend top-K mean
--   ref <TUNE_IN_M5>  — calibration reference; placeholder 100000

CREATE OR REPLACE TASK MCC_RAW.MARKETING_DEV.TASK_REFRESH_GSC_DEMAND
  WAREHOUSE = CORTEX_M
  SCHEDULE  = 'USING CRON 17 6 * * * UTC'
  COMMENT   = 'Daily GSC search-demand refresh -> FCT_TREND_GSC_DEMAND'
AS
BEGIN
  CALL MCC_RAW.MARKETING_DEV.PROC_EMBED_GSC_TERMS();
  CALL MCC_RAW.MARKETING_DEV.PROC_MATCH_GSC_DEMAND(0.90, 500, 3, 100000);
END;

-- After creating, the task is suspended by default — resume with:
--   ALTER TASK MCC_RAW.MARKETING_DEV.TASK_REFRESH_GSC_DEMAND RESUME;
