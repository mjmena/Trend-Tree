-- Daily Google Trends timeseries per active trend.
-- Append-only; populated by the sibling gtrends-poller-p_13CN9KG workflow.
--
-- One row per (trend, pull). The poller iterates ACTIVE trends each day
-- and POSTs each trend's TREND_TOPIC to the existing
-- ingestion/tools/search-google-trends-p_YyC88x8 endpoint, then writes the
-- response here.
--
-- Lifecycle's q_load_trend_context pre-fetches the last 30 rows per trend
-- as `gtrends_history`. Heat formula's external_factor reads the latest
-- INTEREST_PEAK_PCT (default 0.5 if no rows yet — neutral, not penalizing).
-- RESURGENT detection compares last 24h INTEREST_PEAK_PCT to prior 7d
-- baseline (>2× = spike).
--
-- Lifecycle never invokes the GTrends endpoint live — separation of data
-- acquisition from agent reasoning is intentional.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY (
  TREND_ID            VARCHAR(64)   NOT NULL,
  PULLED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  KEYWORD             VARCHAR(500)                                  COMMENT 'the topic string queried — typically TREND_TOPIC, but the poller may shorten it for the GTrends endpoint length cap',
  GEO                 VARCHAR(8)    DEFAULT 'US'                    COMMENT 'ISO country code',
  TIMEFRAME           VARCHAR(32)   DEFAULT 'now 7-d'               COMMENT 'pytrends-style timeframe; default rolling 7d window',

  INTEREST_OVER_TIME  VARIANT                                       COMMENT 'array of {date, interest} from GTrends — full curve over the timeframe',
  RELATED_QUERIES     VARIANT                                       COMMENT '{top: [...], rising: [...]} from GTrends — useful for catching topic drift',
  INTEREST_PEAK_PCT   FLOAT                                         COMMENT 'max value in INTEREST_OVER_TIME — drives heat formula external_factor and RESURGENT spike detection',
  INTEREST_AVG_PCT    FLOAT                                         COMMENT 'mean value in INTEREST_OVER_TIME — used for the prior-baseline comparison',

  PRIMARY KEY (TREND_ID, PULLED_AT)
);
