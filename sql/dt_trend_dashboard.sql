-- Snapshot Table: Dashboard — one row per trend with all fields needed for the UI
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Point-in-time snapshot of trend dashboard data. Will be replaced by a
-- dynamic table once CREATE DYNAMIC TABLE is granted on this schema.
--
-- 2026-04-27 migration: source-of-truth flipped from FCT_TREND_METRICS
-- to FCT_TRENDS. Macro tags + related trends dropped (V_TREND_TAXONOMY
-- + MAP_TREND_MACROTRENDS retired with the legacy clustering pipeline).
-- New Phase 3 enrichment fields surfaced (low_confidence_flag, social_proof,
-- name_reviewer alternates).
--
-- To refresh: re-run this file (CREATE OR REPLACE TABLE ... AS SELECT).
--
-- Usage:
--   SELECT * FROM DT_TREND_DASHBOARD ORDER BY HEAT_INDEX DESC LIMIT 25;
--   SELECT * FROM DT_TREND_DASHBOARD WHERE CATEGORY = 'wellness';

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD AS
WITH top_signals AS (
    SELECT TREND_ID,
           ARRAY_AGG(OBJECT_CONSTRUCT(
               'title', TITLE,
               'url', URL,
               'source', SIGNAL_NAME,
               'pagerank_score', ROUND(PAGERANK_SCORE, 3)
           )) WITHIN GROUP (ORDER BY PAGERANK_SCORE DESC) AS TOP_SIGNALS
    FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
        WHERE PAGERANK_SCORE IS NOT NULL
    )
    WHERE rn <= 5
    GROUP BY TREND_ID
)
SELECT
    -- Card header
    t.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, t.TREND_TOPIC) AS TREND_NAME,
    d.TREND_NAME_B2B,
    d.CATEGORY,
    d.SUBCATEGORY,
    d.CATEGORY_CONFIDENCE,
    d.LOW_CONFIDENCE_FLAG,
    d.SUMMARY_SHORT,
    d.SUMMARY_LONG,
    ROUND(COALESCE(t.TREND_HEAT_INDEX, 0), 1)    AS HEAT_INDEX,
    t.TOTAL_CLUSTER_SIZE,
    t.DISTINCT_SOURCE_COUNT,
    t.VELOCITY_DIRECTION,
    t.CONFIDENCE                                  AS PROMOTION_CONFIDENCE,
    t.SPECIFICITY_SCORE,
    COALESCE(d.ORIGINALLY_SURFACED_AT, t.DETECTED_AT) AS ORIGINALLY_SURFACED_AT,

    -- Key data points (per-source headline metrics)
    (SELECT ARRAY_AGG(
         OBJECT_CONSTRUCT(
             'source', sm.SOURCE_NAME,
             'metric_name', sm.HEADLINE_METRIC_NAME,
             'metric_value', sm.HEADLINE_METRIC
         )
     ) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS sm
       WHERE sm.TREND_ID = t.TREND_ID
         AND sm.HEADLINE_METRIC IS NOT NULL
         AND sm.HEADLINE_METRIC > 0
    )                                            AS KEY_DATA_POINTS,

    -- Cultural context (Phase 3 enrichment agent)
    d.VOICE_OF_CUSTOMER,
    d.VIBE_SHIFT,
    COALESCE(d.SOCIAL_NARRATIVE_V2, TO_VARIANT(d.SOCIAL_NARRATIVE)) AS SOCIAL_NARRATIVE,
    d.CULTURAL_DRIVERS,
    d.SEASONAL_RELEVANCE,
    d.GEOGRAPHIC_HOTSPOTS,

    -- Phase 3 dashboard additions
    d.SOCIAL_PROOF,
    d.NAME_CANDIDATES_CONSIDERED,
    d.NAME_REVIEWER,

    -- Top 5 signals by PageRank
    ts.TOP_SIGNALS,

    -- Enrichment freshness
    d.ENRICHED_AT

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d ON t.TREND_ID = d.TREND_ID
LEFT JOIN top_signals ts  ON t.TREND_ID = ts.TREND_ID;
