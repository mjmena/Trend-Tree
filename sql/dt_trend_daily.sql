-- Dynamic Table: per-trend daily heat / signal history — one row per (TREND_ID, DAY).
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Purpose (#38): a clean daily time-series backing the Hunter B2C platform's
-- score_timeseries graph, week_high / week_low, and the week-over-week
-- momentum badge. DT_TREND_DASHBOARD answers "what is this trend right now";
-- this table answers "how did it get here, day by day".
--
-- 2026-06-08 (#38 created): grain (TREND_ID, DAY). target_lag 18h — the data
-- is daily, so refreshing every 15 min would be pure waste. REFRESH_MODE is
-- FULL: this query uses CURRENT_DATE (date-spine upper bound) and window
-- functions over a generated calendar, neither of which is incrementally
-- refreshable — and at ~250 trends × ~6 weeks a full rebuild is trivial.
-- Snowflake backfills the entire history from existing FCT_TREND_LIFECYCLE_LEDGER
-- and FCT_TREND_SIGNALS rows on creation, so there is NO separate backfill job.
--
-- Source-of-truth note: the issue named FCT_TREND_DAILY_SNAPSHOTS as the
-- signal/source source, but that table is dead (orphaned Louvain-era DDL, no
-- writer — see docs/prediction-flow.md). SIGNAL_COUNT / SOURCE_COUNT /
-- NEW_SIGNALS_TODAY are instead derived live from FCT_TREND_SIGNALS.LINKED_AT
-- using the same cumulative-set framing the prediction agent uses (#33): each
-- signal / publisher domain is attributed to the day its FIRST link to the
-- trend landed. This is monotonic (a cumulative distinct count only ever
-- grows) and backfill-immune (re-linking a historical signal leaves its
-- MIN(first-link day) unchanged), so SIGNAL_WOW_PCT never shows a phantom
-- cliff from a bulk re-link.
--
-- Divergence note (intentional): HEAT_INDEX here is the daily MAX of
-- NEW_HEAT_SMOOTHED — a downsample of the hourly lifecycle ledger — which is
-- NOT the same number as DT_TREND_DASHBOARD.HEAT_INDEX (the single latest
-- evaluation). Hunter sources the HEADLINE heat from the dashboard and the
-- GRAPH LINE from this table. They will differ within a day; that is by design.
--
-- HEAT_WOW_PCT is velocity-as-percent (a first difference over 7 days). It is
-- distinct from FCT_TREND_PREDICTION_LEDGER.INPUT_ACCELERATION, which is a
-- second difference ((heat_now − heat_7d) − (heat_7d − heat_14d)). Keep them
-- separate — one is "how fast", the other is "speeding up or slowing down".

CREATE OR REPLACE DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DAILY
  TARGET_LAG = '18 hours'
  WAREHOUSE = TREND_AGENT_WH
  REFRESH_MODE = FULL
  INITIALIZE = ON_CREATE
AS
WITH calendar AS (
    -- Dense daily calendar. 2000 days from 2025-01-01 covers well past today;
    -- the per-trend span join below clamps it to each trend's lifetime.
    SELECT DATEADD(day, SEQ4(), DATE '2025-01-01') AS DAY
    FROM TABLE(GENERATOR(ROWCOUNT => 2000))
),
heat_daily AS (
    -- Daily MAX of the EWMA-smoothed heat. The lifecycle agent writes hourly
    -- and irregularly; MAX collapses each day to its peak smoothed value.
    SELECT TREND_ID,
           CAST(EVALUATED_AT AS DATE) AS DAY,
           MAX(NEW_HEAT_SMOOTHED)     AS HEAT_RAW
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    GROUP BY TREND_ID, CAST(EVALUATED_AT AS DATE)
),
signal_first_link AS (
    -- First day each signal linked to each trend (cumulative-set anchor).
    SELECT TREND_ID, SIGNAL_ID,
           MIN(CAST(LINKED_AT AS DATE)) AS FIRST_DAY
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
    GROUP BY TREND_ID, SIGNAL_ID
),
new_signals_daily AS (
    SELECT TREND_ID, FIRST_DAY AS DAY, COUNT(*) AS NEW_SIGNALS_TODAY
    FROM signal_first_link
    GROUP BY TREND_ID, FIRST_DAY
),
signal_domains AS (
    -- Best-effort canonical publisher domain per FCT_SIGNALS row. This is the
    -- SAME extraction logic used by dt_trend_dashboard.sql (DISTINCT_SOURCE_COUNT)
    -- and the prediction agent (source-diversity input) — kept inline per the
    -- 2026-04-28 no-views convention. SOURCE_COUNT here therefore means
    -- "distinct publishers", not "distinct source-platform names": four GDELT
    -- articles from four publishers count as 4. Vertex grounding-redirect hosts
    -- resolve to NULL and drop out of the distinct count.
    SELECT
        SIGNAL_ID,
        CASE
            WHEN SOURCE_NAME = 'wikimedia'             THEN 'wikipedia.org'
            WHEN SOURCE_NAME = 'amazon_trends'         THEN 'amazon.com'
            WHEN SOURCE_NAME = 'tiktok'                THEN 'tiktok.com'
            WHEN SOURCE_NAME = 'pinterest'             THEN 'pinterest.com'
            WHEN SOURCE_NAME = 'bluesky'               THEN 'bsky.app'
            WHEN SOURCE_NAME = 'google_trends_explore' THEN 'trends.google.com'
            WHEN SOURCE_NAME = 'grok_live'             THEN 'x.com'
            WHEN SOURCE_NAME = 'gdelt'
                THEN LOWER(REGEXP_REPLACE(METADATA:domain::STRING, '^www\\.', ''))
            WHEN SOURCE_NAME LIKE 'gemini\\_%' ESCAPE '\\'
                THEN LOWER(METADATA:source_name::STRING)
            WHEN SOURCE_NAME LIKE 'agent\\_%\\_discovery' ESCAPE '\\' THEN
                CASE
                    WHEN METADATA:canonical_url::STRING LIKE '%vertexaisearch.cloud.google.com%'
                        THEN NULL
                    ELSE LOWER(REGEXP_REPLACE(
                        REGEXP_SUBSTR(METADATA:canonical_url::STRING, 'https?://([^/]+)', 1, 1, 'e', 1),
                        '^www\\.', ''))
                END
            WHEN SOURCE_NAME = 'google_trends_rss'
                THEN LOWER(METADATA:publisher::STRING)
            ELSE NULL
        END AS DOMAIN
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
),
domain_first_link AS (
    -- First day each publisher domain linked to each trend.
    SELECT ts.TREND_ID, sd.DOMAIN,
           MIN(CAST(ts.LINKED_AT AS DATE)) AS FIRST_DAY
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
    JOIN signal_domains sd ON sd.SIGNAL_ID = ts.SIGNAL_ID
    WHERE sd.DOMAIN IS NOT NULL
    GROUP BY ts.TREND_ID, sd.DOMAIN
),
new_sources_daily AS (
    SELECT TREND_ID, FIRST_DAY AS DAY, COUNT(*) AS NEW_SOURCES_TODAY
    FROM domain_first_link
    GROUP BY TREND_ID, FIRST_DAY
),
trend_span AS (
    -- Per-trend day range: from the earliest activity (first heat eval or
    -- first signal link, whichever is older) through today. Starting at the
    -- earliest of the two guarantees no signal-link day is dropped while still
    -- giving HEAT_INDEX a value from the first lifecycle eval onward.
    SELECT s.TREND_ID,
           LEAST(
               COALESCE(s.FIRST_HEAT_DAY, s.FIRST_SIGNAL_DAY),
               COALESCE(s.FIRST_SIGNAL_DAY, s.FIRST_HEAT_DAY)
           )            AS START_DAY,
           CURRENT_DATE AS END_DAY
    FROM (
        SELECT t.TREND_ID,
               (SELECT MIN(DAY) FROM heat_daily       h WHERE h.TREND_ID = t.TREND_ID) AS FIRST_HEAT_DAY,
               (SELECT MIN(FIRST_DAY) FROM signal_first_link sl WHERE sl.TREND_ID = t.TREND_ID) AS FIRST_SIGNAL_DAY
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    ) s
    WHERE COALESCE(s.FIRST_HEAT_DAY, s.FIRST_SIGNAL_DAY) IS NOT NULL
),
spine AS (
    -- Dense (TREND_ID, DAY) grid — the backbone that makes carry-forward
    -- gap-fill and a clean 7-day LAG possible (every day present, so LAG(7)
    -- is exactly one week, never "7 rows ago across a gap").
    SELECT ts.TREND_ID, c.DAY
    FROM trend_span ts
    JOIN calendar c ON c.DAY BETWEEN ts.START_DAY AND ts.END_DAY
),
daily AS (
    SELECT
        sp.TREND_ID,
        sp.DAY,
        -- Carry-forward gap-fill: the last observed daily-MAX heat, held flat
        -- across days with no lifecycle eval. A gap would otherwise read as
        -- "heat went to zero". Leading days before the first eval stay NULL
        -- (genuinely no history yet), which only happens if a signal predates
        -- the trend's first lifecycle eval.
        LAST_VALUE(hd.HEAT_RAW IGNORE NULLS) OVER (
            PARTITION BY sp.TREND_ID ORDER BY sp.DAY
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS HEAT_INDEX,
        COALESCE(ns.NEW_SIGNALS_TODAY, 0) AS NEW_SIGNALS_TODAY,
        -- Cumulative distinct sets as of this day (monotonic, backfill-immune).
        SUM(COALESCE(ns.NEW_SIGNALS_TODAY, 0)) OVER (
            PARTITION BY sp.TREND_ID ORDER BY sp.DAY
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS SIGNAL_COUNT,
        SUM(COALESCE(nd.NEW_SOURCES_TODAY, 0)) OVER (
            PARTITION BY sp.TREND_ID ORDER BY sp.DAY
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS SOURCE_COUNT
    FROM spine sp
    LEFT JOIN heat_daily        hd ON hd.TREND_ID = sp.TREND_ID AND hd.DAY = sp.DAY
    LEFT JOIN new_signals_daily ns ON ns.TREND_ID = sp.TREND_ID AND ns.DAY = sp.DAY
    LEFT JOIN new_sources_daily nd ON nd.TREND_ID = sp.TREND_ID AND nd.DAY = sp.DAY
)
SELECT
    TREND_ID,
    DAY,
    ROUND(HEAT_INDEX, 1)                                            AS HEAT_INDEX,
    SIGNAL_COUNT,
    SOURCE_COUNT,
    NEW_SIGNALS_TODAY,
    -- Week-over-week velocity as a percent. Reuses the 7-day window convention
    -- prediction (#33) standardized on, for cross-surface consistency. NULL in
    -- a trend's first 7 days (no LAG anchor) and when the 7-day-ago value was 0.
    ROUND(
        (HEAT_INDEX - LAG(HEAT_INDEX, 7) OVER (PARTITION BY TREND_ID ORDER BY DAY))
        / NULLIF(LAG(HEAT_INDEX, 7) OVER (PARTITION BY TREND_ID ORDER BY DAY), 0) * 100,
    1)                                                              AS HEAT_WOW_PCT,
    ROUND(
        (SIGNAL_COUNT - LAG(SIGNAL_COUNT, 7) OVER (PARTITION BY TREND_ID ORDER BY DAY))
        / NULLIF(LAG(SIGNAL_COUNT, 7) OVER (PARTITION BY TREND_ID ORDER BY DAY), 0) * 100,
    1)                                                              AS SIGNAL_WOW_PCT
FROM daily;
