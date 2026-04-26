-- v_valuable_trend_examples.sql
--
-- Slice 5: few-shot grounding for the distillation agent.
--
-- Returns the top ~20 currently-active enriched trends, ordered by recency
-- × heat. Each row carries the B2B/B2C names + summary + category from
-- DIM_TREND_ENRICHMENT, plus the cluster size + heat from FCT_TREND_METRICS.
--
-- Used by Slice 6 to inject `valuable_examples[]` into distillation lead +
-- subagent system prompts. Calibrates "what does a good trend look like"
-- against actual enriched trends — fixes the Amazon-product-shape bias
-- surfaced by the slice3_verify run (10 candidates, 100% Amazon-sourced).
--
-- Filter rationale:
--   - VELOCITY_DIRECTION != 'SUPERSEDED'  → only currently-alive trends
--   - LAST_UPDATE_AT > now - 30d         → recent enough to feel live
--   - INNER JOIN to DIM_TREND_ENRICHMENT → only trends that completed enrichment
--                                          (enrichment IS the proxy for "worth keeping")
--   - ORDER BY TREND_HEAT_INDEX DESC      → highest-signal examples first
--   - LIMIT 20                            → keeps prompt token budget bounded

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_VALUABLE_TREND_EXAMPLES
COMMENT = 'Top ~20 currently-active enriched trends for few-shot grounding in distillation prompts. Joins FCT_TREND_METRICS (alive + recent) to DIM_TREND_ENRICHMENT (B2B/B2C names + summary). See Slice 5 of LLM-prompt + signal-key plan.'
AS
SELECT
    m.TREND_ID,
    m.TREND_TOPIC,
    m.TREND_HEAT_INDEX,
    m.TOTAL_CLUSTER_SIZE,
    m.DISTINCT_SOURCE_COUNT,
    m.LAST_UPDATE_AT,
    e.TREND_NAME_B2B,
    e.TREND_NAME_B2C,
    e.SUMMARY_SHORT,
    e.CATEGORY,
    e.SUBCATEGORY,
    e.ENRICHED_AT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT e
    ON e.TREND_ID = m.TREND_ID
WHERE m.VELOCITY_DIRECTION != 'SUPERSEDED'
  AND m.LAST_UPDATE_AT > DATEADD(day, -30, CURRENT_TIMESTAMP())
ORDER BY m.TREND_HEAT_INDEX DESC NULLS LAST
LIMIT 20;
