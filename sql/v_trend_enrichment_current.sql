-- View: latest enrichment row per trend.
-- Replaces DIM_TREND_ENRICHMENT (which is being dropped). Carries the full
-- enrichment payload (parsed from VARIANT into typed columns) plus the
-- LATEST NON-NULL TREND_VECTOR.
--
-- Vector handling: enrichment writes typically don't re-embed (vector is
-- set at promotion seed time). So the latest enrichment row may have NULL
-- vector even when an earlier promotion_seed row has one. We use a separate
-- CTE for the latest-non-null vector and JOIN it onto the latest-row CTE.

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_ENRICHMENT_CURRENT AS
WITH ranked AS (
  SELECT
    TREND_ID,
    WRITTEN_AT,
    WRITTEN_BY,
    ENRICHMENT_KIND,
    PAYLOAD,
    MODEL_USED,
    LLM_COST_ESTIMATE,
    AGENT_SESSION_ID,
    CHAIN_ID,
    ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
),
latest_vector AS (
  SELECT TREND_ID, TREND_VECTOR
  FROM (
    SELECT TREND_ID, TREND_VECTOR,
           ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE TREND_VECTOR IS NOT NULL
  )
  WHERE rn = 1
),
versions AS (
  SELECT TREND_ID, COUNT(*) AS ENRICHMENT_VERSION
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE ENRICHMENT_KIND IN ('initial', 'refinement')
  GROUP BY TREND_ID
)
SELECT
  r.TREND_ID,
  r.WRITTEN_AT                                          AS ENRICHED_AT,
  COALESCE(v.ENRICHMENT_VERSION, 0)                     AS ENRICHMENT_VERSION,
  r.ENRICHMENT_KIND,
  r.WRITTEN_BY,

  lv.TREND_VECTOR,

  r.PAYLOAD:trend_name_b2b::STRING                      AS TREND_NAME_B2B,
  r.PAYLOAD:trend_name_b2c::STRING                      AS TREND_NAME_B2C,
  r.PAYLOAD:category::STRING                            AS CATEGORY,
  r.PAYLOAD:subcategory::STRING                         AS SUBCATEGORY,
  r.PAYLOAD:category_confidence::FLOAT                  AS CATEGORY_CONFIDENCE,
  r.PAYLOAD:low_confidence_flag::BOOLEAN                AS LOW_CONFIDENCE_FLAG,

  r.PAYLOAD:summary_short::STRING                       AS SUMMARY_SHORT,
  r.PAYLOAD:summary_long::STRING                        AS SUMMARY_LONG,
  r.PAYLOAD:vibe_shift::STRING                          AS VIBE_SHIFT,
  COALESCE(r.PAYLOAD:social_narrative_v2,
           r.PAYLOAD:social_narrative)                  AS SOCIAL_NARRATIVE,
  r.PAYLOAD:voice_of_customer                           AS VOICE_OF_CUSTOMER,
  r.PAYLOAD:cultural_drivers                            AS CULTURAL_DRIVERS,
  r.PAYLOAD:seasonal_relevance                          AS SEASONAL_RELEVANCE,
  r.PAYLOAD:geographic_hotspots                         AS GEOGRAPHIC_HOTSPOTS,
  r.PAYLOAD:social_proof                                AS SOCIAL_PROOF,
  r.PAYLOAD:name_candidates_considered                  AS NAME_CANDIDATES_CONSIDERED,
  r.PAYLOAD:name_reviewer                               AS NAME_REVIEWER,
  r.PAYLOAD:agent_telemetry                             AS AGENT_TELEMETRY,
  r.PAYLOAD:originally_surfaced_at::TIMESTAMP_NTZ       AS ORIGINALLY_SURFACED_AT,

  r.MODEL_USED,
  r.LLM_COST_ESTIMATE,
  r.AGENT_SESSION_ID                                    AS LAST_AGENT_SESSION_ID,
  r.CHAIN_ID                                            AS LAST_CHAIN_ID
FROM ranked r
LEFT JOIN versions      v  ON v.TREND_ID  = r.TREND_ID
LEFT JOIN latest_vector lv ON lv.TREND_ID = r.TREND_ID
WHERE r.rn = 1;
