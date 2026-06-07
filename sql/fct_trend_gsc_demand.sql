-- Per-trend Google Search Console (GSC) search-demand, daily.
--
-- Twin of FCT_TREND_GTRENDS_DAILY: one row per (trend, pull), append-only,
-- read latest-per-trend by the lifecycle subagent's heat prefetch. It lives
-- here (not in FCT_TREND_SOURCE_METRICS, which is not a heat input) so the
-- lifecycle q_gsc_demand step can reuse the proven gtrends prefetch path
-- verbatim.
--
-- GSC_DEMAND_SCORE is FIRST-PARTY: QUERY_COUNT in SEARCH_TERM_VECTORS counts
-- appearances in *our own* SEARCH_CONSOLE, not market-wide volume (verified
-- 2026-06-07). So demand is biased toward trends McClatchy already ranks for
-- and low demand is ambiguous — the heat wiring (M6) treats it positive-only
-- / neutral-when-absent, never penalizing.
--
-- Written by PROC_MATCH_GSC_DEMAND. GSC has a ~4-day freshness lag (in the
-- source tables, not our query); a daily refresh is fine for a slow heat slot.
-- TREND_DEMAND_RAW is stored alongside the squashed score so the calibration
-- constant (REF) can be re-tuned offline without re-running the match.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GSC_DEMAND (
  TREND_ID          VARCHAR(64)   NOT NULL,
  PULLED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  GSC_DEMAND_SCORE  FLOAT                                         COMMENT '0..1 — the heat demand-slot input; LEAST(1, log10(TREND_DEMAND_RAW+1)/log10(REF+1))',
  TREND_DEMAND_RAW  FLOAT                                         COMMENT 'pre-squash magnitude: top-K mean of per-term SUM(QUERY_COUNT); auditable',
  MATCHED_TERMS     NUMBER                                        COMMENT 'count of this trend''s terms with >=1 matched GSC query',
  MATCHED_QUERIES   NUMBER                                        COMMENT 'total matched GSC queries across the trend''s terms',
  MATCH_THRESHOLD   FLOAT                                         COMMENT 'vector-leg cosine cutoff that produced this row (provenance)',
  DETAIL            VARIANT                                       COMMENT 'per-term breakdown [{term, demand, queries, rank}] for debugging/calibration',

  PRIMARY KEY (TREND_ID, PULLED_AT)
);
