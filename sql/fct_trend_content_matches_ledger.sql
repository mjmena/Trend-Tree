-- FCT_TREND_CONTENT_MATCHES_LEDGER (CRMA-452) — append-only ledger of the
-- top-N nearest published-content matches per live trend, one generation
-- per recompute. Mirrors FCT_TREND_CONNECTIONS_LEDGER's shape (CRMA-462): a
-- fresh CHAIN_ID + COMPUTED_AT tags every row of one recompute run;
-- "current state" = the rows of the most recent CHAIN_ID (surfaced inline
-- on DT_TREND_DASHBOARD.NEAREST_CONTENT — see dt_trend_dashboard.sql).
--
-- Purpose (Path A — reuse the data team's content embeddings, no new
-- content-embedding job): for each live trend,
-- MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES embeds a short companion doc
-- (TREND_NAME + SUMMARY_SHORT) with
-- SNOWFLAKE.CORTEX.EMBED_TEXT_768('snowflake-arctic-embed-m-v1.5', ...) and
-- cosines it against the data team's existing
-- MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS.KEY_WORDS_VECTOR — also 768-dim /
-- arctic-embed-m-v1.5, confirmed by fingerprint (re-embedding source text
-- reproduces the stored vector at cosine 1.0; see
-- docs/dashboard/migrating-data-sources.md). CUE_CONTENT_VECTORS is read
-- exactly as-is — no content re-embedding.
--
-- This is a SEPARATE, isolated vector space from the trend's canonical
-- 1024-dim TREND_VECTOR (arctic-embed-l-v2.0, internal clustering /
-- RELATED_TRENDS / lifecycle neighbors). The two dims are never compared to
-- each other and this ledger never feeds HEAT_INDEX, LIFECYCLE_STATUS, or
-- PREDICTION_SCORE — content-match isolation mirrors how
-- FCT_TREND_CONNECTIONS_LEDGER / FCT_TREND_PREDICTION_LEDGER stay isolated.
--
-- Only rows clearing MATCH_THRESHOLD are stored (same "gate before insert"
-- shape as FCT_TREND_CONNECTIONS_LEDGER's category-aware thresholds) — an
-- under-covered trend simply produces zero rows for its CHAIN_ID rather
-- than N mediocre ones forced through a fixed top-N. MATCH_RANK /
-- MATCH_THRESHOLD / WINDOW_DAYS are recorded per generation so the result
-- set is reconstructable and the calibration is auditable as it gets
-- re-tuned (0.60 / 180d calibrated 2026-08-18 — see
-- task_recompute_content_matches.sql for the sample that produced it).
--
-- Content-pool caveat: CUE_CONTENT_VECTORS.HEADLINE is populated on only
-- ~13-18% of rows in any given window (verified 2026-08-18) — a row can
-- carry a valid KEY_WORDS_VECTOR with no human-readable headline. Those
-- rows are excluded from the match pool entirely: a "nearest article" a
-- human can't read or verify is worse than no match.
--
-- No CONTENT_URL column: CUE_CONTENT_VECTORS carries no direct URL, and
-- joining to the neighboring CUE_CONTENT_PROCESSED.CONTENTID (which has
-- HOSTNAME/PATH) recovers a URL-capable row for well under 1% of the
-- otherwise-matched pool (a CONTENTID join-key mismatch between the two
-- tables — verified 2026-08-18), so a resolvable link isn't reliably
-- available today. CONTENT_ID + HEADLINE + PUBLISHED_DATE is enough to
-- spot-check plausibility; a clickable link is a follow-up for CRMA-453/454
-- if either actually needs one.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONTENT_MATCHES_LEDGER (
  CONTENT_MATCH_ID    VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  CHAIN_ID            VARCHAR                                COMMENT 'content-match-task-{ts}, one generation per recompute (cron tick or manual EXECUTE TASK)',
  COMPUTED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),

  TREND_ID            VARCHAR(64)   NOT NULL                 COMMENT 'FCT_TRENDS.TREND_ID',
  CONTENT_ID          NUMBER(38,0)                            COMMENT 'MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS.CONTENTID of the matched article',
  HEADLINE            VARCHAR                                COMMENT 'CUE_CONTENT_VECTORS.HEADLINE, frozen at match time (the source table is not append-only)',
  PUBLISHED_DATE      DATE                                    COMMENT 'CUE_CONTENT_VECTORS.PUBLISHED_DATE',
  SCORE               FLOAT                                   COMMENT 'VECTOR_COSINE_SIMILARITY(trend companion vector, KEY_WORDS_VECTOR), 4dp',
  MATCH_RANK          NUMBER                                  COMMENT '1..TOP_N within this trend + generation, ordered by SCORE DESC',

  -- Calibration audit trail — thresholds/window are a moving target,
  -- mirrors FCT_TREND_CONNECTIONS_LEDGER's INPUT_*_THRESHOLD columns.
  MATCH_THRESHOLD     FLOAT                                   COMMENT 'cosine cutoff in effect for this generation',
  WINDOW_DAYS         NUMBER                                  COMMENT 'CUE_CONTENT_VECTORS.PUBLISHED_DATE rolling-window size in effect for this generation',

  COMPUTATION_VERSION VARCHAR       DEFAULT 'v1'              COMMENT 'bump when the embed-doc recipe or match-selection rule changes; auditable lineage'
);
