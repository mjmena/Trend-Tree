-- View: Trend leaderboard — ranked by heat index (source-first)
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Quick-reference ranking of active, enriched trends sorted by
-- FCT_TREND_METRICS.TREND_HEAT_INDEX. Designed for editorial standups
-- and content prioritization. Surfaces names, short summary, source
-- coverage, and top signals for fast scanning. Source breadth (live
-- count from FCT_TREND_SOURCE_METRICS) is a secondary tiebreaker.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_LEADERBOARD AS
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
source_agg AS (
    SELECT
        TREND_ID,
        ARRAY_AGG(SOURCE_NAME)     AS SOURCE_NAMES,
        COUNT(*)                   AS SOURCE_COUNT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
    WHERE HEADLINE_METRIC IS NOT NULL AND HEADLINE_METRIC > 0
    GROUP BY TREND_ID
),
signal_evidence AS (
    -- Top 3 signal titles per trend by PageRank
    SELECT
        TREND_ID,
        ARRAY_AGG(TITLE) WITHIN GROUP (ORDER BY PAGERANK_SCORE DESC) AS TOP_SIGNAL_TITLES
    FROM (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC NULLS LAST) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
    )
    WHERE rn <= 3
    GROUP BY TREND_ID
)
SELECT
    -- Identity & description
    m.TREND_ID,
    COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, m.TREND_TOPIC) AS TREND_NAME,
    d.TREND_NAME_B2B,
    d.TREND_NAME_B2C,
    d.SUMMARY_SHORT,
    d.CATEGORY,
    d.SUBCATEGORY,

    -- Scores
    m.TREND_HEAT_INDEX,

    -- Pipeline metrics
    m.VELOCITY_DIRECTION,
    m.TOTAL_CLUSTER_SIZE,
    m.DISTINCT_SOURCE_COUNT,

    -- Source evidence (live count from FCT_TREND_SOURCE_METRICS)
    sa.SOURCE_NAMES,
    COALESCE(sa.SOURCE_COUNT, 0)                     AS SOURCE_COVERAGE_BREADTH,
    sig.TOP_SIGNAL_TITLES,

    -- Temporal
    m.DETECTED_AT,
    m.LAST_UPDATE_AT,
    DATEDIFF('hour', m.DETECTED_AT, m.LAST_UPDATE_AT)  AS TREND_AGE_HOURS,

    -- Rank within category
    ROW_NUMBER() OVER (
        PARTITION BY d.CATEGORY
        ORDER BY m.TREND_HEAT_INDEX DESC
    )                                                AS CATEGORY_RANK

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
JOIN latest_enrichment d
    ON m.TREND_ID = d.TREND_ID
LEFT JOIN source_agg sa
    ON m.TREND_ID = sa.TREND_ID
LEFT JOIN signal_evidence sig
    ON m.TREND_ID = sig.TREND_ID
WHERE d.ENRICHED_AT IS NOT NULL
ORDER BY m.TREND_HEAT_INDEX DESC, COALESCE(sa.SOURCE_COUNT, 0) DESC;
