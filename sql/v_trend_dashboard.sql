-- View: Dashboard — one row per trend with all fields needed for the UI
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Stable schema for the Trend Agent dashboard. Each row powers one trend card.
-- KEY_DATA_POINTS is populated from per-source headline metrics in
-- FCT_TREND_SOURCE_METRICS. Cultural-context fields (voice of customer,
-- vibe shift, narrative, drivers, seasonality, geography) come from the
-- Grok specialist output in DIM_TREND_ENRICHMENT and replace the former
-- ENGAGEMENT_METRICS placeholder.
--
-- Usage:
--   SELECT * FROM V_TREND_DASHBOARD ORDER BY HEAT_INDEX DESC LIMIT 25;
--   SELECT * FROM V_TREND_DASHBOARD WHERE CATEGORY = 'Wellness';

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_DASHBOARD AS
WITH latest_enrichment AS (
  SELECT r.TREND_ID, r.WRITTEN_AT AS ENRICHED_AT,
         lv.TREND_VECTOR,
         r.PAYLOAD:trend_name_b2b::STRING AS TREND_NAME_B2B,
         r.PAYLOAD:trend_name_b2c::STRING AS TREND_NAME_B2C,
         r.PAYLOAD:category::STRING       AS CATEGORY,
         r.PAYLOAD:subcategory::STRING    AS SUBCATEGORY,
         r.PAYLOAD:category_confidence::FLOAT  AS CATEGORY_CONFIDENCE,
         r.PAYLOAD:low_confidence_flag::BOOLEAN AS LOW_CONFIDENCE_FLAG,
         r.PAYLOAD:summary_short::STRING  AS SUMMARY_SHORT,
         r.PAYLOAD:summary_long::STRING   AS SUMMARY_LONG,
         r.PAYLOAD:vibe_shift::STRING     AS VIBE_SHIFT,
         COALESCE(r.PAYLOAD:social_narrative_v2, r.PAYLOAD:social_narrative) AS SOCIAL_NARRATIVE,
         r.PAYLOAD:voice_of_customer  AS VOICE_OF_CUSTOMER,
         r.PAYLOAD:cultural_drivers   AS CULTURAL_DRIVERS,
         r.PAYLOAD:seasonal_relevance AS SEASONAL_RELEVANCE,
         r.PAYLOAD:geographic_hotspots AS GEOGRAPHIC_HOTSPOTS,
         r.PAYLOAD:social_proof       AS SOCIAL_PROOF,
         r.PAYLOAD:name_candidates_considered AS NAME_CANDIDATES_CONSIDERED,
         r.PAYLOAD:name_reviewer      AS NAME_REVIEWER,
         r.PAYLOAD:agent_telemetry    AS AGENT_TELEMETRY,
         r.PAYLOAD:originally_surfaced_at::TIMESTAMP_NTZ AS ORIGINALLY_SURFACED_AT
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  ) r
  LEFT JOIN (
    SELECT TREND_ID, TREND_VECTOR
    FROM (
      SELECT TREND_ID, TREND_VECTOR,
             ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
      WHERE TREND_VECTOR IS NOT NULL
    ) WHERE rn = 1
  ) lv ON lv.TREND_ID = r.TREND_ID
  WHERE r.rn = 1
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
related AS (
    SELECT TREND_ID, RELATED_TRENDS
    FROM MCC_PRESENTATION.TREND_AGENT.V_TREND_TAXONOMY
)
SELECT
    -- Card header
    m.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, m.TREND_TOPIC) AS TREND_NAME,
    d.TREND_NAME_B2B,
    d.CATEGORY,
    d.SUBCATEGORY,
    mt.MACROTREND_TAGS,
    d.SUMMARY_SHORT,
    d.SUMMARY_LONG,
    ROUND(m.TREND_HEAT_INDEX, 1)                 AS HEAT_INDEX,
    m.TOTAL_CLUSTER_SIZE,
    m.VELOCITY_DIRECTION,

    -- Key data points (per-source headline metrics)
    (SELECT ARRAY_AGG(
         OBJECT_CONSTRUCT(
             'source', sm.SOURCE_NAME,
             'metric_name', sm.HEADLINE_METRIC_NAME,
             'metric_value', sm.HEADLINE_METRIC
         )
     ) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS sm
       WHERE sm.TREND_ID = m.TREND_ID
         AND sm.HEADLINE_METRIC IS NOT NULL
         AND sm.HEADLINE_METRIC > 0
    )                                            AS KEY_DATA_POINTS,

    -- Cultural context (Grok specialist — source-grounded via Bluesky)
    d.VOICE_OF_CUSTOMER,
    d.VIBE_SHIFT,
    d.SOCIAL_NARRATIVE,
    d.CULTURAL_DRIVERS,
    d.SEASONAL_RELEVANCE,
    d.GEOGRAPHIC_HOTSPOTS,

    -- Top 5 signals by PageRank
    ts.TOP_SIGNALS,

    -- Related trends (vector similarity from taxonomy view)
    r.RELATED_TRENDS,

    -- Enrichment freshness
    d.ENRICHED_AT

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
LEFT JOIN latest_enrichment d ON m.TREND_ID = d.TREND_ID
LEFT JOIN top_signals ts  ON m.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt   ON m.TREND_ID = mt.TREND_ID
LEFT JOIN related r       ON m.TREND_ID = r.TREND_ID;
