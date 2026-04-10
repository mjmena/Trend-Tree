-- View: Trend taxonomy — macro trends, parent-child hierarchy, and vector similarity
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Shows each trend's place in the taxonomy: its macro trend (CATEGORY), parent-child
-- hierarchy from PROC_SPLIT_TREND, and most similar trends via TREND_VECTOR cosine
-- similarity. Two similarity tiers:
--   RELATED_TRENDS       — top 5 at >= 0.45 (broader thematic connections)
--   CLOSELY_RELATED      — top 3 at >= 0.55 (tight semantic matches)
--
-- Usage:
--   SELECT * FROM V_TREND_TAXONOMY WHERE MACRO_TREND = 'wellness' ORDER BY MACRO_TREND_RANK;
--   SELECT TREND_NAME, CLOSELY_RELATED FROM V_TREND_TAXONOMY WHERE TREND_NAME ILIKE '%skincare%';

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_TAXONOMY AS
WITH active_trends AS (
    SELECT
        m.TREND_ID,
        COALESCE(d.TREND_NAME, m.TREND_TOPIC)   AS TREND_NAME,
        m.TREND_TOPIC                            AS RAW_TOPIC,
        d.SUMMARY,
        d.CATEGORY,
        d.SUBCATEGORY,
        d.LIFECYCLE_STAGE,
        m.TREND_HEAT_INDEX,
        m.VELOCITY_DIRECTION,
        m.TREND_VECTOR,
        m.PARENT_TREND_ID,
        m.TOTAL_CLUSTER_SIZE,
        d.TREND_COMMERCIAL_SCORE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT d
        ON m.TREND_ID = d.TREND_ID
    WHERE m.TREND_VECTOR IS NOT NULL
),
-- Pairwise similarity (both directions to avoid correlated subqueries)
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
-- Broad tier: top 5 at >= 0.45
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
-- Tight tier: top 3 at >= 0.55
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
-- Children per parent
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
-- Category-level stats (macro trend summary)
category_stats AS (
    SELECT
        CATEGORY,
        COUNT(*)                                 AS CATEGORY_TREND_COUNT,
        ROUND(AVG(TREND_HEAT_INDEX), 1)          AS CATEGORY_AVG_HEAT,
        ROUND(AVG(TREND_COMMERCIAL_SCORE), 1)    AS CATEGORY_AVG_COMMERCIAL
    FROM active_trends
    WHERE CATEGORY IS NOT NULL
    GROUP BY CATEGORY
)
SELECT
    -- Identity
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
    cs.CATEGORY_AVG_COMMERCIAL                   AS MACRO_TREND_AVG_COMMERCIAL,

    -- Hierarchy
    t.PARENT_TREND_ID,
    p.TREND_NAME                                 AS PARENT_TREND_NAME,
    ch.CHILD_TRENDS,

    -- Similarity: broad + tight
    r.RELATED_TRENDS,
    cr.CLOSELY_RELATED,
    COALESCE(r.RELATED_COUNT, 0)                 AS SIMILAR_TREND_COUNT,

    -- Key metrics for context
    t.TREND_HEAT_INDEX,
    t.VELOCITY_DIRECTION,
    t.TOTAL_CLUSTER_SIZE,
    t.TREND_COMMERCIAL_SCORE,

    -- Rank within macro trend
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
