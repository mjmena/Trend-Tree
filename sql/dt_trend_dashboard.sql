-- Snapshot Table: Dashboard — one row per trend with all fields needed for the UI.
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-28 (no-views refactor): inlined the windowed-latest CTEs that
-- used to live in V_TREND_LIFECYCLE_CURRENT, V_TREND_ENRICHMENT_CURRENT,
-- and V_TREND_AGGREGATES. The taxonomy join also inlined from V_TREND_TAXONOMY.
-- This snapshot table is now self-contained — re-run this file to refresh.
--
-- Output column shape preserved for Steeple consumers.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD AS
WITH latest_lifecycle AS (
    SELECT TREND_ID,
           NEW_STATUS         AS LIFECYCLE_STATUS,
           NEW_HEAT           AS HEAT_INDEX,
           NEW_HEAT_SMOOTHED  AS HEAT_INDEX_SMOOTHED,
           EVALUATED_AT       AS LAST_EVAL_AT,
           DECISION_PAYLOAD:retirement_reason::STRING AS RETIREMENT_REASON
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    ) WHERE rn = 1
),
latest_enrichment AS (
    SELECT r.TREND_ID, r.WRITTEN_AT AS ENRICHED_AT,
           r.PAYLOAD:trend_name_b2b::STRING       AS TREND_NAME_B2B,
           r.PAYLOAD:trend_name_b2c::STRING       AS TREND_NAME_B2C,
           r.PAYLOAD:category::STRING             AS CATEGORY,
           r.PAYLOAD:subcategory::STRING          AS SUBCATEGORY,
           r.PAYLOAD:category_confidence::FLOAT   AS CATEGORY_CONFIDENCE,
           (r.PAYLOAD:category_confidence::FLOAT < 0.6) AS LOW_CONFIDENCE_FLAG,
           r.PAYLOAD:summary_short::STRING        AS SUMMARY_SHORT,
           r.PAYLOAD:summary_long::STRING         AS SUMMARY_LONG,
           -- New records emit `social_narrative` as the structured array.
           -- Legacy records emit `social_narrative_v2` as the array and put a string preview in `social_narrative`.
           -- Prefer v2 first to keep the array shape consistent across both eras.
           COALESCE(r.PAYLOAD:social_narrative_v2, r.PAYLOAD:social_narrative) AS SOCIAL_NARRATIVE,
           r.PAYLOAD:cultural_drivers             AS CULTURAL_DRIVERS,
           r.PAYLOAD:seasonal_relevance           AS SEASONAL_RELEVANCE,
           r.PAYLOAD:geographic_hotspots          AS GEOGRAPHIC_HOTSPOTS,
           COALESCE(r.PAYLOAD:evidence, r.PAYLOAD:social_proof) AS EVIDENCE,
           r.PAYLOAD:name_candidates_considered   AS NAME_CANDIDATES_CONSIDERED,
           r.PAYLOAD:name_reviewer                AS NAME_REVIEWER,
           r.PAYLOAD:originally_surfaced_at::TIMESTAMP_NTZ AS ORIGINALLY_SURFACED_AT
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    ) r WHERE r.rn = 1
),
tc_for_agg AS (
    SELECT t.TREND_ID, c.SUPPORTING_SIGNAL_IDS, c.SOURCE_BREAKDOWN
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
      ON c.CANDIDATE_ID = t.CANDIDATE_ID OR c.DEDUP_OF_TREND_ID = t.TREND_ID
),
trend_aggregates AS (
    SELECT t.TREND_ID,
           COALESCE(s.TOTAL_CLUSTER_SIZE, 0)      AS TOTAL_CLUSTER_SIZE,
           COALESCE(src.DISTINCT_SOURCE_COUNT, 0) AS DISTINCT_SOURCE_COUNT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    LEFT JOIN (
      SELECT TREND_ID, COUNT(DISTINCT f.value::STRING) AS TOTAL_CLUSTER_SIZE
      FROM tc_for_agg, LATERAL FLATTEN(INPUT => SUPPORTING_SIGNAL_IDS) f
      GROUP BY TREND_ID
    ) s ON s.TREND_ID = t.TREND_ID
    LEFT JOIN (
      SELECT TREND_ID, COUNT(DISTINCT k.value::STRING) AS DISTINCT_SOURCE_COUNT
      FROM tc_for_agg, LATERAL FLATTEN(INPUT => OBJECT_KEYS(SOURCE_BREAKDOWN)) k
      GROUP BY TREND_ID
    ) src ON src.TREND_ID = t.TREND_ID
),
top_signals AS (
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
related_trends AS (
    -- Inlined from V_TREND_TAXONOMY: trends sharing macrotrend tags
    SELECT a.TREND_ID,
           ARRAY_AGG(DISTINCT b.TREND_ID) AS RELATED_TRENDS
    FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS a
    JOIN MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS b
      ON a.MACROTREND_NAME = b.MACROTREND_NAME
     AND a.TREND_ID != b.TREND_ID
    GROUP BY a.TREND_ID
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
    LEFT JOIN latest_lifecycle    lc  ON lc.TREND_ID  = t.TREND_ID
    LEFT JOIN trend_aggregates    agg ON agg.TREND_ID = t.TREND_ID
    LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = t.CANDIDATE_ID

    UNION ALL

    -- Legacy SQL-clustered trends (FCT_TREND_METRICS)
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
    u.LIFECYCLE_STATUS                                                    AS VELOCITY_DIRECTION,
    u.LAST_LIFECYCLE_EVAL_AT,
    u.RETIREMENT_REASON,
    u.PROMOTION_CONFIDENCE,
    u.PROMOTION_SPECIFICITY,
    u.TREND_SOURCE,
    COALESCE(e.ORIGINALLY_SURFACED_AT, u.DETECTED_AT)                     AS ORIGINALLY_SURFACED_AT,

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

    e.SOCIAL_NARRATIVE,
    e.CULTURAL_DRIVERS,
    e.SEASONAL_RELEVANCE,
    e.GEOGRAPHIC_HOTSPOTS,
    e.EVIDENCE,
    e.NAME_CANDIDATES_CONSIDERED,
    e.NAME_REVIEWER,
    ts.TOP_SIGNALS,
    mt.MACROTREND_TAGS,
    r.RELATED_TRENDS,
    e.ENRICHED_AT

FROM unioned_trends u
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t  ON u.TREND_ID = t.TREND_ID  AND u.TREND_SOURCE = 'fct_trends'
LEFT JOIN latest_enrichment e                         ON u.TREND_ID = e.TREND_ID
LEFT JOIN top_signals ts                              ON u.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt                               ON u.TREND_ID = mt.TREND_ID
LEFT JOIN related_trends r                            ON u.TREND_ID = r.TREND_ID;
