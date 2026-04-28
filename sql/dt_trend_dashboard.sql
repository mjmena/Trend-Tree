-- Snapshot Table: Dashboard — one row per trend with all fields needed for the UI.
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-28 refactor: identity (FCT_TRENDS) + state (V_TREND_LIFECYCLE_CURRENT) +
-- narrative (V_TREND_ENRICHMENT_CURRENT) + aggregates (V_TREND_AGGREGATES) +
-- legacy UNION (FCT_TREND_METRICS).
--
-- DIM_TREND_ENRICHMENT joins removed; everything narrative now flows through
-- V_TREND_ENRICHMENT_CURRENT. FCT_TRENDS holds frozen names + categories.
-- All previous output column names preserved so dashboard consumers aren't broken.
-- VELOCITY_DIRECTION kept as a backwards-compat alias of LIFECYCLE_STATUS.
--
-- To refresh: re-run this file (CREATE OR REPLACE TABLE ... AS SELECT).

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
        t.TREND_ID,
        t.TREND_TOPIC,
        COALESCE(agg.TOTAL_CLUSTER_SIZE,    0) AS TOTAL_CLUSTER_SIZE,
        COALESCE(agg.DISTINCT_SOURCE_COUNT, 0) AS DISTINCT_SOURCE_COUNT,
        lc.LIFECYCLE_STATUS,
        COALESCE(lc.HEAT_INDEX_SMOOTHED, lc.HEAT_INDEX) AS TREND_HEAT_INDEX,
        t.DETECTED_AT,
        t.LAST_UPDATE_AT,
        c.CONFIDENCE                              AS PROMOTION_CONFIDENCE,
        c.SPECIFICITY_SCORE                       AS PROMOTION_SPECIFICITY,
        lc.LAST_EVAL_AT                           AS LAST_LIFECYCLE_EVAL_AT,
        lc.RETIREMENT_REASON,
        'fct_trends'                              AS TREND_SOURCE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.V_TREND_LIFECYCLE_CURRENT lc ON lc.TREND_ID = t.TREND_ID
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.V_TREND_AGGREGATES        agg ON agg.TREND_ID = t.TREND_ID
    LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES             c   ON c.CANDIDATE_ID = t.CANDIDATE_ID

    UNION ALL

    -- Legacy SQL-clustered trends — kept visible while audit/lifecycle agent
    -- triages them. Filter out any TREND_IDs that already appear in FCT_TRENDS
    -- so we don't double-count overlap. Map the legacy VELOCITY_DIRECTION enum
    -- forward (STAGNANT→DORMANT, SUPERSEDED→RETIRED).
    SELECT
        m.TREND_ID,
        m.TREND_TOPIC,
        m.TOTAL_CLUSTER_SIZE,
        m.DISTINCT_SOURCE_COUNT,
        CASE m.VELOCITY_DIRECTION
          WHEN 'STAGNANT'   THEN 'DORMANT'
          WHEN 'SUPERSEDED' THEN 'RETIRED'
          ELSE m.VELOCITY_DIRECTION
        END                                       AS LIFECYCLE_STATUS,
        m.TREND_HEAT_INDEX,
        m.DETECTED_AT,
        m.LAST_UPDATE_AT,
        NULL                                      AS PROMOTION_CONFIDENCE,
        NULL                                      AS PROMOTION_SPECIFICITY,
        NULL::TIMESTAMP_NTZ                       AS LAST_LIFECYCLE_EVAL_AT,
        NULL                                      AS RETIREMENT_REASON,
        'fct_trend_metrics'                       AS TREND_SOURCE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
    WHERE m.TREND_ID NOT IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS)
)
SELECT
    -- Card header — names + category come from FCT_TRENDS (frozen) for new
    -- trends; from V_TREND_ENRICHMENT_CURRENT for legacy (which lacks the
    -- frozen columns since they were never promoted into FCT_TRENDS).
    u.TREND_ID,
    COALESCE(t.TREND_NAME_B2C, t.TREND_NAME_B2B, e.TREND_NAME_B2C, e.TREND_NAME_B2B, u.TREND_TOPIC) AS TREND_NAME,
    COALESCE(t.TREND_NAME_B2B, e.TREND_NAME_B2B)                          AS TREND_NAME_B2B,
    COALESCE(t.CATEGORY,       e.CATEGORY)                                AS CATEGORY,
    COALESCE(t.SUBCATEGORY,    e.SUBCATEGORY)                             AS SUBCATEGORY,
    e.CATEGORY_CONFIDENCE,
    e.LOW_CONFIDENCE_FLAG,
    e.SUMMARY_SHORT,
    e.SUMMARY_LONG,
    ROUND(COALESCE(u.TREND_HEAT_INDEX, 0), 1)                             AS HEAT_INDEX,
    u.TOTAL_CLUSTER_SIZE,
    u.DISTINCT_SOURCE_COUNT,
    u.LIFECYCLE_STATUS,
    u.LIFECYCLE_STATUS                                                    AS VELOCITY_DIRECTION,  -- backwards-compat alias
    u.LAST_LIFECYCLE_EVAL_AT,
    u.RETIREMENT_REASON,
    u.PROMOTION_CONFIDENCE,
    u.PROMOTION_SPECIFICITY,
    u.TREND_SOURCE,
    COALESCE(e.ORIGINALLY_SURFACED_AT, u.DETECTED_AT)                     AS ORIGINALLY_SURFACED_AT,

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
    )                                                                     AS KEY_DATA_POINTS,

    -- Cultural context (Phase 3 enrichment agent — null for legacy rows)
    e.VOICE_OF_CUSTOMER,
    e.VIBE_SHIFT,
    e.SOCIAL_NARRATIVE,
    e.CULTURAL_DRIVERS,
    e.SEASONAL_RELEVANCE,
    e.GEOGRAPHIC_HOTSPOTS,

    -- Phase 3 dashboard additions
    e.SOCIAL_PROOF,
    e.NAME_CANDIDATES_CONSIDERED,
    e.NAME_REVIEWER,

    -- Top 5 signals by PageRank
    ts.TOP_SIGNALS,

    -- Macro trend tags + related trends
    mt.MACROTREND_TAGS,
    r.RELATED_TRENDS,

    -- Enrichment freshness
    e.ENRICHED_AT

FROM unioned_trends u
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS                t  ON u.TREND_ID = t.TREND_ID  AND u.TREND_SOURCE = 'fct_trends'
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.V_TREND_ENRICHMENT_CURRENT e  ON u.TREND_ID = e.TREND_ID
LEFT JOIN top_signals ts  ON u.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt   ON u.TREND_ID = mt.TREND_ID
LEFT JOIN related r       ON u.TREND_ID = r.TREND_ID;
