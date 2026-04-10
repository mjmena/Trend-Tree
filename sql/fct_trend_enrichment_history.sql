-- Fact: Point-in-time snapshots of enrichment metrics
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Captures a row per trend per day when the enrichment workflow runs.
-- Tracks three things: (1) source-metric drift (so you can see how a
-- trend's source mix evolved), (2) category drift (so Audit Agent can
-- flag trends whose classification keeps flipping), and (3) per-run
-- cost. Validity/lifecycle/sponsorship/brand counts are intentionally
-- not tracked here in the source-first shape.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_HISTORY (
    TREND_ID VARCHAR NOT NULL,
    SNAPSHOT_DATE DATE NOT NULL,

    SOURCE_METRICS_SNAPSHOT VARIANT,         -- {source_name: {headline_metric, headline_metric_name}}
    CATEGORY VARCHAR,                        -- tracks categorization drift over time

    LLM_TOTAL_TOKENS NUMBER,
    LLM_COST_ESTIMATE FLOAT,

    PRIMARY KEY (TREND_ID, SNAPSHOT_DATE)
);
