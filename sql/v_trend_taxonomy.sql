-- View: Taxonomy — trend hierarchy, macro-trend grouping, similarity-based relations
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Source-first update (2026-04-10):
--   * TREND_COMMERCIAL_SCORE / MACRO_TREND_AVG_COMMERCIAL removed (column dropped from DIM)
--   * LIFECYCLE_STAGE now reads FCT_TREND_METRICS.VELOCITY_DIRECTION (not DIM)
--   * TREND_NAME coalesces d.TREND_NAME_B2C → d.TREND_NAME_B2B → m.TREND_TOPIC
--   * SUMMARY now reads d.SUMMARY_SHORT (short is the right granularity here)

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_TAXONOMY AS
WITH active_trends AS (
    SELECT
        m.TREND_ID,
        COALESCE(d.TREND_NAME_B2C, d.TREND_NAME_B2B, m.TREND_TOPIC) AS TREND_NAME,
        m.TREND_TOPIC                            AS RAW_TOPIC,
        d.SUMMARY_SHORT                          AS SUMMARY,
        d.CATEGORY,
        d.SUBCATEGORY,
        m.VELOCITY_DIRECTION                     AS LIFECYCLE_STAGE,
        m.TREND_HEAT_INDEX,
        m.VELOCITY_DIRECTION,
        m.TREND_VECTOR,
        m.PARENT_TREND_ID,
        m.TOTAL_CLUSTER_SIZE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.V_TREND_ENRICHMENT_CURRENT d
        ON m.TREND_ID = d.TREND_ID
    WHERE m.TREND_VECTOR IS NOT NULL
),
similarity_scored AS (
    SELECT
        a.TREND_ID,
        b.TREND_ID                                              AS SIMILAR_TREND_ID,
        b.TREND_NAME                                            AS SIMILAR_TREND_NAME,
        b.CATEGORY                                              AS SIMILAR_CATEGORY,
        ROUND(VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR), 3)
                                                                AS SIMILARITY_SCORE
    FROM active_trends a
    JOIN active_trends b
        ON a.TREND_ID != b.TREND_ID
    WHERE VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR) >= 0.45
),
ranked_similar AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY SIMILARITY_SCORE DESC) AS sim_rank
    FROM similarity_scored
),
related AS (
    SELECT
        TREND_ID,
        ARRAY_AGG(OBJECT_CONSTRUCT(
            'trend_id', SIMILAR_TREND_ID,
            'trend_name', SIMILAR_TREND_NAME,
            'category', SIMILAR_CATEGORY,
            'similarity', SIMILARITY_SCORE
        )) WITHIN GROUP (ORDER BY SIMILARITY_SCORE DESC) AS RELATED_TRENDS,
        COUNT(*)                                          AS RELATED_COUNT
    FROM ranked_similar
    WHERE sim_rank <= 5
    GROUP BY TREND_ID
),
closely_related AS (
    SELECT
        TREND_ID,
        ARRAY_AGG(OBJECT_CONSTRUCT(
            'trend_id', SIMILAR_TREND_ID,
            'trend_name', SIMILAR_TREND_NAME,
            'category', SIMILAR_CATEGORY,
            'similarity', SIMILARITY_SCORE
        )) WITHIN GROUP (ORDER BY SIMILARITY_SCORE DESC) AS CLOSELY_RELATED
    FROM ranked_similar
    WHERE sim_rank <= 3 AND SIMILARITY_SCORE >= 0.55
    GROUP BY TREND_ID
),
children AS (
    SELECT
        c.PARENT_TREND_ID                        AS TREND_ID,
        ARRAY_AGG(OBJECT_CONSTRUCT(
            'trend_id', c.TREND_ID,
            'trend_name', c.TREND_NAME,
            'velocity', c.VELOCITY_DIRECTION
        ))                                       AS CHILD_TRENDS
    FROM active_trends c
    WHERE c.PARENT_TREND_ID IS NOT NULL
    GROUP BY c.PARENT_TREND_ID
),
category_stats AS (
    SELECT
        CATEGORY,
        COUNT(*)                                 AS CATEGORY_TREND_COUNT,
        ROUND(AVG(TREND_HEAT_INDEX), 1)          AS CATEGORY_AVG_HEAT
    FROM active_trends
    WHERE CATEGORY IS NOT NULL
    GROUP BY CATEGORY
)
SELECT
    t.TREND_ID,
    t.TREND_NAME,
    t.RAW_TOPIC,
    t.SUMMARY,

    -- Macro trend (= CATEGORY)
    t.CATEGORY                                   AS MACRO_TREND,
    t.SUBCATEGORY,
    t.LIFECYCLE_STAGE,
    cs.CATEGORY_TREND_COUNT,
    cs.CATEGORY_AVG_HEAT                         AS MACRO_TREND_AVG_HEAT,

    -- Hierarchy
    t.PARENT_TREND_ID,
    p.TREND_NAME                                 AS PARENT_TREND_NAME,
    ch.CHILD_TRENDS,

    -- Similarity
    r.RELATED_TRENDS,
    cr.CLOSELY_RELATED,
    COALESCE(r.RELATED_COUNT, 0)                 AS SIMILAR_TREND_COUNT,

    -- Context
    t.TREND_HEAT_INDEX,
    t.VELOCITY_DIRECTION,
    t.TOTAL_CLUSTER_SIZE,

    ROW_NUMBER() OVER (
        PARTITION BY t.CATEGORY
        ORDER BY t.TREND_HEAT_INDEX DESC NULLS LAST
    )                                            AS MACRO_TREND_RANK

FROM active_trends t
LEFT JOIN related r          ON t.TREND_ID = r.TREND_ID
LEFT JOIN closely_related cr ON t.TREND_ID = cr.TREND_ID
LEFT JOIN children ch        ON t.TREND_ID = ch.TREND_ID
LEFT JOIN category_stats cs  ON t.CATEGORY = cs.CATEGORY
LEFT JOIN active_trends p    ON t.PARENT_TREND_ID = p.TREND_ID
ORDER BY t.CATEGORY NULLS LAST, t.TREND_HEAT_INDEX DESC NULLS LAST;
