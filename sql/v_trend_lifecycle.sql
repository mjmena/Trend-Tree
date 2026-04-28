-- View: Lightweight diagnostic over trend lifecycle state.
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-28: simplified once the lifecycle agent landed. Previously this
-- view tried to be a state-machine-via-SQL (NEEDS_ENRICHMENT, NEEDS_RETRY,
-- GOING_DORMANT, LIFECYCLE_CHANGE, etc.). Now the lifecycle agent owns
-- those decisions directly via FCT_TRENDS.LIFECYCLE_STATUS and writes its
-- own ledger to FCT_TREND_LIFECYCLE_HISTORY. This view exists for ops
-- visibility only — surface what's stale, what's unenriched, what the
-- sweeper is about to pick up.
--
-- Removed since prior version:
--   - STG_ENRICHMENT_QUEUE join (queue eliminated 2026-04-27)
--   - NEEDS_RETRY case (was queue-driven)
--   - SUPERSEDED / GOING_DORMANT cases (the agent emits these directly now)
--   - Priority scoring (the lifecycle sweeper has its own ORDER BY)
--   - FCT_TREND_METRICS dependency (legacy, schema-disjoint from FCT_TRENDS)

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_LIFECYCLE AS
WITH source_summary AS (
    SELECT
        TREND_ID,
        COUNT(*)         AS SOURCE_COVERAGE_BREADTH,
        MAX(ENRICHED_AT) AS SOURCES_ENRICHED_AT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
    WHERE HEADLINE_METRIC IS NOT NULL AND HEADLINE_METRIC > 0
    GROUP BY TREND_ID
)
SELECT
    t.TREND_ID,
    COALESCE(d.TREND_NAME_B2B, t.TREND_TOPIC)                AS TREND_NAME,
    t.LIFECYCLE_STATUS,
    ROUND(COALESCE(t.TREND_HEAT_INDEX_SMOOTHED, t.TREND_HEAT_INDEX), 1) AS HEAT_INDEX,
    t.TOTAL_CLUSTER_SIZE,
    t.DISTINCT_SOURCE_COUNT,

    t.PROMOTED_AT,
    t.LAST_UPDATE_AT,
    t.LAST_LIFECYCLE_EVAL_AT,
    t.NEXT_LIFECYCLE_EVAL_AT,
    t.RETIREMENT_REASON,

    d.ENRICHED_AT,
    d.ENRICHMENT_VERSION,
    COALESCE(ss.SOURCE_COVERAGE_BREADTH, 0)                  AS SOURCE_COVERAGE_BREADTH,
    ss.SOURCES_ENRICHED_AT,

    DATEDIFF('hour', t.PROMOTED_AT,            CURRENT_TIMESTAMP()) AS AGE_HOURS,
    DATEDIFF('hour', t.LAST_UPDATE_AT,         CURRENT_TIMESTAMP()) AS HOURS_SINCE_UPDATE,
    DATEDIFF('hour', d.ENRICHED_AT,            CURRENT_TIMESTAMP()) AS HOURS_SINCE_ENRICHMENT,
    DATEDIFF('hour', t.LAST_LIFECYCLE_EVAL_AT, CURRENT_TIMESTAMP()) AS HOURS_SINCE_LIFECYCLE_EVAL,
    DATEDIFF('hour', ss.SOURCES_ENRICHED_AT,   CURRENT_TIMESTAMP()) AS HOURS_SINCE_SOURCE_REFRESH,

    -- ACTION_NEEDED is a coarse diagnostic for ops dashboards.
    -- The lifecycle agent does NOT consume this — it computes its own
    -- decisions per the prompts in DIM_LLM_PROMPT.
    CASE
        WHEN t.LIFECYCLE_STATUS = 'RETIRED'
            THEN 'RETIRED'

        WHEN d.ENRICHED_AT IS NULL AND t.TOTAL_CLUSTER_SIZE >= 3
            THEN 'NEEDS_ENRICHMENT'

        WHEN t.NEXT_LIFECYCLE_EVAL_AT IS NOT NULL
             AND t.NEXT_LIFECYCLE_EVAL_AT <= CURRENT_TIMESTAMP()
            THEN 'LIFECYCLE_DUE'

        WHEN COALESCE(t.TREND_HEAT_INDEX, 0) >= 50
             AND DATEDIFF('hour', d.ENRICHED_AT, CURRENT_TIMESTAMP()) > 48
            THEN 'NEEDS_REFRESH'

        WHEN DATEDIFF('hour', ss.SOURCES_ENRICHED_AT, CURRENT_TIMESTAMP()) > 24
             AND DATEDIFF('hour', t.LAST_UPDATE_AT, CURRENT_TIMESTAMP()) < 24
            THEN 'SOURCES_STALE'

        ELSE 'OK'
    END                                                       AS ACTION_NEEDED

FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d
       ON t.TREND_ID = d.TREND_ID
LEFT JOIN source_summary ss
       ON t.TREND_ID = ss.TREND_ID
ORDER BY
    CASE WHEN t.LIFECYCLE_STATUS = 'RETIRED' THEN 1 ELSE 0 END,
    COALESCE(t.TREND_HEAT_INDEX_SMOOTHED, t.TREND_HEAT_INDEX) DESC NULLS LAST;
