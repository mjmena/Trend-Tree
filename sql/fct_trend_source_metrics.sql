-- Fact: Normalized source enrichment metrics per trend
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- One row per trend per source. Each enricher writes its own payload into METRICS.
-- Consumers iterate over rows to discover what sources exist for a trend without
-- needing to know source names upfront.
--
-- HEADLINE_METRIC provides a single comparable number per source for quick ranking
-- (e.g. article count, pageviews, post count). METRICS contains the full payload.
--
-- Adding a new source = INSERT a new SOURCE_NAME value. No DDL changes needed.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS (
    TREND_ID VARCHAR NOT NULL,
    SOURCE_NAME VARCHAR NOT NULL,            -- 'gdelt', 'wikimedia', 'bluesky', 'google_trends', 'amazon', 'reddit', 'pinterest', 'tiktok', 'mcclatchy'
    HEADLINE_METRIC FLOAT,                   -- one comparable number per source
    HEADLINE_METRIC_NAME VARCHAR,            -- what HEADLINE_METRIC represents ('article_count_7d', 'pageviews_7d', etc.)
    METRICS VARIANT NOT NULL,                -- full source-specific payload
    ENRICHED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ENRICHMENT_VERSION NUMBER DEFAULT 1,

    PRIMARY KEY (TREND_ID, SOURCE_NAME)
);
