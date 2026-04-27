-- Snapshot Table: Dashboard — one row per trend with all fields needed for the UI
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-27 transitional: UNION ALL of FCT_TRENDS (canonical, agent-promoted)
-- and FCT_TREND_METRICS (legacy clustering output). Until a future audit/
-- lifecycle agent triages the 324 legacy rows, both surfaces are needed for
-- dashboard continuity. Once that work lands, this DT collapses back to
-- FCT_TRENDS-only.
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
),
macro_tags AS (
    SELECT TREND_ID,
           ARRAY_AGG(MACROTREND_NAME) WITHIN GROUP (ORDER BY RELEVANCE_SCORE DESC) AS MACROTREND_TAGS
    FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
    GROUP BY TREND_ID
),
related AS (
    SELECT TREND_ID, RELATED_TRENDS
    FROM MCC_PRESENTATION.TREND_AGENT.V_TREND_TAXONOMY
),
unioned_trends AS (
    -- Agent-promoted trends (canonical going forward)
    SELECT
        t.TREND_ID, t.TREND_TOPIC, t.TOTAL_CLUSTER_SIZE, t.DISTINCT_SOURCE_COUNT,
        t.VELOCITY_DIRECTION, t.TREND_HEAT_INDEX, t.DETECTED_AT, t.LAST_UPDATE_AT,
        t.CONFIDENCE          AS PROMOTION_CONFIDENCE,
        t.SPECIFICITY_SCORE   AS PROMOTION_SPECIFICITY,
        'fct_trends'          AS TREND_SOURCE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t

    UNION ALL

    -- Legacy SQL-clustered trends — kept visible while audit/lifecycle agent
    -- triages them. Filter out any TREND_IDs that already appear in FCT_TRENDS
    -- so we don't double-count overlap.
    SELECT
        m.TREND_ID, m.TREND_TOPIC, m.TOTAL_CLUSTER_SIZE, m.DISTINCT_SOURCE_COUNT,
        m.VELOCITY_DIRECTION, m.TREND_HEAT_INDEX, m.DETECTED_AT, m.LAST_UPDATE_AT,
        NULL                  AS PROMOTION_CONFIDENCE,
        NULL                  AS PROMOTION_SPECIFICITY,
        'fct_trend_metrics'   AS TREND_SOURCE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
    WHERE m.TREND_ID NOT IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS)
)
SELECT
    -- Card header
    u.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, u.TREND_TOPIC) AS TREND_NAME,
    d.TREND_NAME_B2B,
    d.CATEGORY,
    d.SUBCATEGORY,
    d.CATEGORY_CONFIDENCE,
    d.LOW_CONFIDENCE_FLAG,
    d.SUMMARY_SHORT,
    d.SUMMARY_LONG,
    ROUND(COALESCE(u.TREND_HEAT_INDEX, 0), 1)    AS HEAT_INDEX,
    u.TOTAL_CLUSTER_SIZE,
    u.DISTINCT_SOURCE_COUNT,
    u.VELOCITY_DIRECTION,
    u.PROMOTION_CONFIDENCE,
    u.PROMOTION_SPECIFICITY,
    u.TREND_SOURCE,
    COALESCE(d.ORIGINALLY_SURFACED_AT, u.DETECTED_AT) AS ORIGINALLY_SURFACED_AT,

    -- Key data points (per-source headline metrics)
    (SELECT ARRAY_AGG(
         OBJECT_CONSTRUCT(
             'source', sm.SOURCE_NAME,
             'metric_name', sm.HEADLINE_METRIC_NAME,
             'metric_value', sm.HEADLINE_METRIC
         )
     ) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS sm
       WHERE sm.TREND_ID = u.TREND_ID
         AND sm.HEADLINE_METRIC IS NOT NULL
         AND sm.HEADLINE_METRIC > 0
    )                                            AS KEY_DATA_POINTS,

    -- Cultural context (Phase 3 enrichment agent — null for legacy rows)
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

    -- Macro trend tags + related trends (legacy fields, kept for upstream
    -- compatibility — Macro Trend layer marked for retirement in newer
    -- dashboard feedback but consumers still read these columns).
    mt.MACROTREND_TAGS,
    r.RELATED_TRENDS,

    -- Enrichment freshness
    d.ENRICHED_AT

FROM unioned_trends u
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d ON u.TREND_ID = d.TREND_ID
LEFT JOIN top_signals ts  ON u.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt   ON u.TREND_ID = mt.TREND_ID
LEFT JOIN related r       ON u.TREND_ID = r.TREND_ID;
