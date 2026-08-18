-- Dynamic Table: Dashboard — one row per trend with all fields needed for the UI.
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- 2026-04-28 (dynamic table + ledger-only sources): converted to a dynamic
-- table with a 15-minute target lag. Aggregate columns (TOTAL_CLUSTER_SIZE,
-- DISTINCT_SOURCE_COUNT) now derive from FCT_PROMOTION_LEDGER instead of
-- reaching cross-database into STG_TREND_CANDIDATES — which kept the schema-
-- managed owner role MCC_PRESENTATION_TREND_AGENT_SFULL inside MCC_PRESENTATION
-- so refresh succeeds without granting it cross-database privileges.
-- PROMOTION_CONFIDENCE and PROMOTION_SPECIFICITY were dropped (undocumented).
--
-- 2026-04-28 (no-views refactor): inlined the windowed-latest CTEs that
-- used to live in V_TREND_LIFECYCLE_CURRENT, V_TREND_ENRICHMENT_CURRENT,
-- and V_TREND_AGGREGATES. The taxonomy join also inlined from V_TREND_TAXONOMY.
--
-- 2026-04-29 (related trends): replaced deprecated MAP_TREND_MACROTRENDS join
-- with pairwise VECTOR_COSINE_SIMILARITY on FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR
-- (falling back to FCT_TRENDS.TREND_VECTOR). RELATED_TRENDS is now an array of
-- {trend_id, trend_name, category, similarity} objects (top 5, threshold ≥ 0.65).
--
-- 2026-04-28 (STG_TREND_SIGNALS retirement): top_signals CTE now derives from
-- the enrichment EVIDENCE pool (filtered to type IN news/commerce/social,
-- first 5 in agent emit order) instead of reading the frozen STG_TREND_SIGNALS
-- table by PageRank. EVIDENCE already includes the strongest pre-fetched
-- cluster signals — the agent is instructed to tag them — so this is the
-- same data through a different pipe. Stays inside MCC_PRESENTATION;
-- no cross-DB grant on MCC_RAW needed.
-- TOP_SIGNALS object shape: pagerank_score field removed; rest preserved.
--
-- 2026-05-06 (FCT_TREND_SOURCE_METRICS removed as a dashboard input):
--   * trend_aggregates: TOTAL_CLUSTER_SIZE / DISTINCT_SOURCE_COUNT now derive
--     from FCT_TREND_SIGNALS (live, includes both LINK_KIND='supporting' and
--     'attributed') instead of summing the frozen FCT_PROMOTION_LEDGER
--     CLUSTER_SIZE / SOURCE_COUNT. This unblocks growth from
--     lifecycle-attribution-agent-p_KwCoaap. New signal_domains CTE maps each
--     FCT_SIGNALS row to a canonical domain via best-effort METADATA
--     extraction; DISTINCT_SOURCE_COUNT becomes COUNT(DISTINCT domain) — so
--     four GDELT articles from four publishers count as 4, not 1.
--   * KEY_DATA_POINTS now reads FCT_TREND_GTRENDS_DAILY (latest pull's peak +
--     avg interest) instead of FCT_TREND_SOURCE_METRICS. Same array shape;
--     entries shift from "platform headline metrics" to gtrends scalars.
-- FCT_TREND_SOURCE_METRICS no longer read by this dynamic table.
--
-- 2026-06-08 (#37 trend vector for B2C feed): expose the canonical 1024-dim
-- trend embedding as TREND_VECTOR_ARCTIC_EMBED_L_V2_0 by joining the existing
-- trend_vectors CTE (built for RELATED_TRENDS) into the final SELECT. Additive
-- column; underlying FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR unchanged. See
-- the column's inline note for the explicit-select + O(n²) scale caveats.
--
-- 2026-08-18 (CRMA-452 trend -> published-content match): additive
-- NEAREST_CONTENT column — top-N nearest MCC_RAW.STORY_DATA.CUE_CONTENT_
-- VECTORS matches per trend, from the latest MARKETING_TASK_RECOMPUTE_
-- CONTENT_MATCHES generation in the new FCT_TREND_CONTENT_MATCHES_LEDGER
-- (see that file + task_recompute_content_matches.sql). Computed with a
-- SEPARATE 768-dim arctic-embed-m-v1.5 companion vector, isolated from the
-- 1024-dim TREND_VECTOR_ARCTIC_EMBED_L_V2_0 above — the two spaces are never
-- compared. NULL (not []) when a trend has no row in the latest chain,
-- matching RELATED_TRENDS' existing null-when-absent convention.
--
-- Output column shape preserved for Steeple consumers (minus the two dropped
-- promotion-* columns and TOP_SIGNALS.pagerank_score).

CREATE OR REPLACE DYNAMIC TABLE MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
  TARGET_LAG = '15 minutes'
  WAREHOUSE = TREND_AGENT_WH
  REFRESH_MODE = AUTO
  INITIALIZE = ON_SCHEDULE
AS
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
latest_prediction AS (
    -- Latest prediction-agent row per trend. Additive columns for the
    -- Predictions Queue UI. ISOLATED from HEAT_INDEX / LIFECYCLE_STATUS —
    -- not read by any scoring path, only surfaced for the frontend.
    SELECT TREND_ID,
           PREDICTION_SCORE,
           PREDICTION_FLAG,
           PREDICTION_ELIGIBLE
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
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
           -- Legacy columns kept for front-end backward compat during cutover.
           -- Steeple consumers read these column names directly. EVIDENCE supersedes
           -- SOCIAL_PROOF + VOICE_OF_CUSTOMER going forward; remove these once
           -- consumers have migrated to filter the typed pool by `type`.
           r.PAYLOAD:social_proof                 AS SOCIAL_PROOF,
           r.PAYLOAD:voice_of_customer            AS VOICE_OF_CUSTOMER,
           r.PAYLOAD:vibe_shift::STRING           AS VIBE_SHIFT,
           r.PAYLOAD:name_candidates_considered   AS NAME_CANDIDATES_CONSIDERED,
           r.PAYLOAD:name_reviewer                AS NAME_REVIEWER,
           r.PAYLOAD:originally_surfaced_at::TIMESTAMP_NTZ AS ORIGINALLY_SURFACED_AT
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    ) r WHERE r.rn = 1
),
latest_gtrends AS (
    -- Most recent gtrends-poller pull per trend. Feeds KEY_DATA_POINTS.
    SELECT TREND_ID,
           INTEREST_PEAK_PCT,
           INTEREST_AVG_PCT,
           PULLED_AT
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PULLED_AT DESC) AS rn
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_GTRENDS_DAILY
    ) WHERE rn = 1
),
evidence_split AS (
    -- Pre-bucket the typed pool for the dashboard.
    -- COALESCE on `type` (new schema) and `source_type` (legacy social_proof rows)
    -- so legacy rows are grouped on their old enum until they re-enrich.
    SELECT
      le.TREND_ID,
      ARRAY_COMPACT(ARRAY_AGG(
        CASE WHEN COALESCE(f.value:type::STRING, f.value:source_type::STRING) IN ('news', 'commerce')
             THEN f.value END
      )) AS GENERAL_EVIDENCE,
      ARRAY_COMPACT(ARRAY_AGG(
        CASE WHEN COALESCE(f.value:type::STRING, f.value:source_type::STRING) = 'social'
             THEN f.value END
      )) AS SOCIAL_EVIDENCE,
      ARRAY_COMPACT(ARRAY_AGG(
        CASE WHEN COALESCE(f.value:type::STRING, f.value:source_type::STRING)
                  IN ('reference', 'search_volume', 'video', 'other')
             THEN f.value END
      )) AS OTHER_EVIDENCE
    FROM latest_enrichment le, LATERAL FLATTEN(input => le.EVIDENCE, OUTER => TRUE) f
    GROUP BY le.TREND_ID
),
signal_domains AS (
    -- Best-effort canonical domain per FCT_SIGNALS row, lowercased + 'www.'
    -- stripped. Self-domain platforms hard-code; news + discovery sources
    -- extract from METADATA. Vertex grounding-redirect URLs from
    -- agent_gemini_discovery resolve to NULL — the redirect host isn't a
    -- meaningful publisher, so it drops out of COUNT(DISTINCT) without
    -- removing the signal from cluster_size.
    SELECT
        SIGNAL_ID,
        CASE
            -- Self-domain platforms (signal == one platform's domain)
            WHEN SOURCE_NAME = 'wikimedia'             THEN 'wikipedia.org'
            WHEN SOURCE_NAME = 'amazon_trends'         THEN 'amazon.com'
            WHEN SOURCE_NAME = 'tiktok'                THEN 'tiktok.com'
            WHEN SOURCE_NAME = 'pinterest'             THEN 'pinterest.com'
            WHEN SOURCE_NAME = 'bluesky'               THEN 'bsky.app'
            WHEN SOURCE_NAME = 'google_trends_explore' THEN 'trends.google.com'
            WHEN SOURCE_NAME = 'grok_live'             THEN 'x.com'
            -- News + discovery sources (extract from METADATA)
            WHEN SOURCE_NAME = 'gdelt'
                THEN LOWER(REGEXP_REPLACE(METADATA:domain::STRING, '^www\\.', ''))
            WHEN SOURCE_NAME LIKE 'gemini\\_%' ESCAPE '\\'
                -- gemini_food_drink / gemini_other / gemini_travel / gemini_wellness
                -- (vertical-sharded discovery) emit metadata.source_name as the publisher.
                THEN LOWER(METADATA:source_name::STRING)
            WHEN SOURCE_NAME LIKE 'agent\\_%\\_discovery' ESCAPE '\\' THEN
                CASE
                    -- Vertex grounding-redirect URLs aren't meaningful publishers.
                    WHEN METADATA:canonical_url::STRING LIKE '%vertexaisearch.cloud.google.com%'
                        THEN NULL
                    ELSE LOWER(REGEXP_REPLACE(
                        REGEXP_SUBSTR(METADATA:canonical_url::STRING, 'https?://([^/]+)', 1, 1, 'e', 1),
                        '^www\\.', ''))
                END
            WHEN SOURCE_NAME = 'google_trends_rss'
                -- Post-2026-05-27 flatten: one row per article, publisher
                -- normalized at ingest. Old-shape rows (pre-flatten + the
                -- 95k legacy unbackfilled) lack METADATA:publisher and yield
                -- NULL — same as today's behavior.
                THEN LOWER(METADATA:publisher::STRING)
            ELSE NULL
        END AS DOMAIN
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
),
trend_aggregates AS (
    -- Live counts derived from FCT_TREND_SIGNALS (both LINK_KIND='supporting'
    -- from MARKETING_TASK_PROMOTE_TREND_SIGNALS and 'attributed' from
    -- lifecycle-attribution-agent-p_KwCoaap). Replaces the prior
    -- FCT_PROMOTION_LEDGER SUM, which never grew post-promotion (no
    -- MERGE_INTO_EXISTING decisions have ever fired). DISTINCT_SOURCE_COUNT
    -- counts unique domains, not source-name vocabulary, so cross-publisher
    -- breadth is reflected accurately.
    SELECT ts.TREND_ID,
           COUNT(DISTINCT ts.SIGNAL_ID) AS TOTAL_CLUSTER_SIZE,
           COUNT(DISTINCT sd.DOMAIN)    AS DISTINCT_SOURCE_COUNT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
    LEFT JOIN signal_domains sd ON sd.SIGNAL_ID = ts.SIGNAL_ID
    GROUP BY ts.TREND_ID
),
top_signals AS (
    -- First 5 EVIDENCE entries per trend with type IN news/commerce/social,
    -- preserving the order the agent emitted them. Reference / search_volume /
    -- video are excluded — those are background, not "what defined the cluster".
    SELECT TREND_ID,
           ARRAY_AGG(OBJECT_CONSTRUCT(
               -- EVIDENCE entries from agent emit `claim` (their one-sentence summary of why
               -- this URL is relevant), not raw `title`. Surface as `title` for backward
               -- compatibility with the previous TOP_SIGNALS shape.
               'title',  COALESCE(EV:title::STRING, EV:claim::STRING),
               'url',    EV:url::STRING,
               'source', EV:source::STRING
           )) WITHIN GROUP (ORDER BY ORIG_IDX) AS TOP_SIGNALS
    FROM (
        SELECT le.TREND_ID,
               f.index AS ORIG_IDX,
               f.value AS EV,
               ROW_NUMBER() OVER (PARTITION BY le.TREND_ID ORDER BY f.index) AS RN
        FROM latest_enrichment le, LATERAL FLATTEN(input => le.EVIDENCE, OUTER => TRUE) f
        WHERE COALESCE(f.value:type::STRING, f.value:source_type::STRING) IN ('news', 'commerce', 'social')
    )
    WHERE RN <= 5
    GROUP BY TREND_ID
),
macro_tags AS (
    SELECT TREND_ID,
           ARRAY_AGG(MACROTREND_NAME) WITHIN GROUP (ORDER BY RELEVANCE_SCORE DESC) AS MACROTREND_TAGS
    FROM MCC_PRESENTATION.TREND_AGENT.MAP_TREND_MACROTRENDS
    GROUP BY TREND_ID
),
trend_vectors AS (
    -- Latest enrichment vector per trend, scoped to FCT_TRENDS members so
    -- RELATED_IDs always resolve to a valid dashboard row.
    SELECT TREND_ID, TREND_VECTOR
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE TREND_VECTOR IS NOT NULL
      AND TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) = 1
),
pairwise_similarity AS (
    -- Top-5 most similar neighbours per trend, threshold ≥ 0.65.
    SELECT
        a.TREND_ID                                                                        AS TREND_ID,
        b.TREND_ID                                                                        AS RELATED_ID,
        ROUND(VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR)::FLOAT, 4)         AS SCORE
    FROM trend_vectors a
    JOIN trend_vectors b
      ON a.TREND_ID != b.TREND_ID
     AND VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR) >= 0.65
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY a.TREND_ID
        ORDER BY VECTOR_COSINE_SIMILARITY(a.TREND_VECTOR, b.TREND_VECTOR) DESC
    ) <= 5
),
related_trends AS (
    SELECT
        ps.TREND_ID,
        ARRAY_AGG(
            OBJECT_CONSTRUCT(
                'trend_id',   ps.RELATED_ID,
                'trend_name', COALESCE(ft.TREND_NAME_B2C, ft.TREND_NAME_B2B, re.TREND_NAME_B2C, re.TREND_NAME_B2B, ft.TREND_TOPIC),
                'category',   COALESCE(ft.CATEGORY, re.CATEGORY),
                'similarity', ps.SCORE
            )
        ) WITHIN GROUP (ORDER BY ps.SCORE DESC) AS RELATED_TRENDS
    FROM pairwise_similarity ps
    LEFT JOIN latest_enrichment re ON re.TREND_ID = ps.RELATED_ID
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS ft ON ft.TREND_ID = ps.RELATED_ID
    GROUP BY ps.TREND_ID
),
latest_content_match_chain AS (
    -- CRMA-452: "latest generation" pointer into FCT_TREND_CONTENT_MATCHES_
    -- LEDGER, same pattern as DT_TREND_CONNECTIONS' CHAIN_ID lookup.
    SELECT CHAIN_ID
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONTENT_MATCHES_LEDGER
    QUALIFY ROW_NUMBER() OVER (ORDER BY COMPUTED_AT DESC) = 1
),
nearest_content AS (
    -- Top-N nearest published-content matches per trend (already capped +
    -- threshold-gated by the recompute task, so no re-filtering needed
    -- here — see task_recompute_content_matches.sql). A trend absent from
    -- the latest chain (nothing cleared MATCH_THRESHOLD, or newer than the
    -- last recompute) simply has no row here and NEAREST_CONTENT reads
    -- NULL downstream.
    SELECT
        m.TREND_ID,
        ARRAY_AGG(
            OBJECT_CONSTRUCT(
                'content_id',     m.CONTENT_ID,
                'headline',       m.HEADLINE,
                'published_date', m.PUBLISHED_DATE,
                'score',          m.SCORE
            )
        ) WITHIN GROUP (ORDER BY m.MATCH_RANK) AS NEAREST_CONTENT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONTENT_MATCHES_LEDGER m
    JOIN latest_content_match_chain c ON c.CHAIN_ID = m.CHAIN_ID
    GROUP BY m.TREND_ID
),
trend_base AS (
    -- Sourced from FCT_TRENDS only. Legacy FCT_TREND_METRICS union removed
    -- 2026-04-28 to test dashboard scoped exclusively to agent-promoted trends.
    SELECT
        t.TREND_ID,
        t.TREND_TOPIC,
        COALESCE(agg.TOTAL_CLUSTER_SIZE,    0) AS TOTAL_CLUSTER_SIZE,
        COALESCE(agg.DISTINCT_SOURCE_COUNT, 0) AS DISTINCT_SOURCE_COUNT,
        lc.LIFECYCLE_STATUS,
        COALESCE(lc.HEAT_INDEX_SMOOTHED, lc.HEAT_INDEX) AS TREND_HEAT_INDEX,
        t.DETECTED_AT,
        t.LAST_UPDATE_AT,
        lc.LAST_EVAL_AT                           AS LAST_LIFECYCLE_EVAL_AT,
        lc.RETIREMENT_REASON,
        'fct_trends'                              AS TREND_SOURCE
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    LEFT JOIN latest_lifecycle    lc  ON lc.TREND_ID  = t.TREND_ID
    LEFT JOIN trend_aggregates    agg ON agg.TREND_ID = t.TREND_ID
)
SELECT
    tb.TREND_ID,
    -- Prefer the new singular TREND_NAME (post-2026-05-27 cutover); fall
    -- back through legacy B2C/B2B columns for trends not yet re-enriched
    -- under the singular-name agent, then through the latest enrichment
    -- ledger's B2C/B2B (covers in-flight migration), then trend topic.
    COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, t.TREND_NAME_B2B, e.TREND_NAME_B2C, e.TREND_NAME_B2B, tb.TREND_TOPIC) AS TREND_NAME,
    COALESCE(t.TREND_NAME_B2B, e.TREND_NAME_B2B)                          AS TREND_NAME_B2B,
    COALESCE(t.CATEGORY,       e.CATEGORY)                                AS CATEGORY,
    COALESCE(t.SUBCATEGORY,    e.SUBCATEGORY)                             AS SUBCATEGORY,
    e.CATEGORY_CONFIDENCE,
    e.LOW_CONFIDENCE_FLAG,
    e.SUMMARY_SHORT,
    e.SUMMARY_LONG,
    ROUND(COALESCE(tb.TREND_HEAT_INDEX, 0), 1)                            AS HEAT_INDEX,
    -- Prediction-agent additive columns. Isolated from HEAT_INDEX by design;
    -- read by the Insights Agent Predictions Queue only.
    pred.PREDICTION_SCORE,
    pred.PREDICTION_FLAG,
    COALESCE(pred.PREDICTION_ELIGIBLE, FALSE)                              AS PREDICTION_ELIGIBLE,
    tb.TOTAL_CLUSTER_SIZE,
    tb.DISTINCT_SOURCE_COUNT,
    tb.DISTINCT_SOURCE_COUNT                                               AS DISTINCT_PUBLISHER_COUNT,
    tb.LIFECYCLE_STATUS,
    tb.LIFECYCLE_STATUS                                                    AS VELOCITY_DIRECTION,
    tb.LAST_LIFECYCLE_EVAL_AT,
    tb.RETIREMENT_REASON,
    tb.TREND_SOURCE,
    COALESCE(e.ORIGINALLY_SURFACED_AT, tb.DETECTED_AT)                     AS ORIGINALLY_SURFACED_AT,

    -- KEY_DATA_POINTS is the latest gtrends-poller pull's interest scalars.
    -- ARRAY_CONSTRUCT_COMPACT drops null entries, so a trend with no gtrends
    -- row yields an empty array (same shape as the prior "no source_metrics
    -- rows" case).
    ARRAY_CONSTRUCT_COMPACT(
        CASE WHEN lg.INTEREST_PEAK_PCT IS NOT NULL THEN
            OBJECT_CONSTRUCT(
                'source',       'google_trends',
                'metric_name',  'interest_peak_pct',
                'metric_value', lg.INTEREST_PEAK_PCT
            )
        END,
        CASE WHEN lg.INTEREST_AVG_PCT IS NOT NULL THEN
            OBJECT_CONSTRUCT(
                'source',       'google_trends',
                'metric_name',  'interest_avg_pct',
                'metric_value', lg.INTEREST_AVG_PCT
            )
        END
    )                                                                     AS KEY_DATA_POINTS,

    e.SOCIAL_NARRATIVE,
    e.CULTURAL_DRIVERS,
    e.SEASONAL_RELEVANCE,
    e.GEOGRAPHIC_HOTSPOTS,
    e.EVIDENCE,
    -- Pre-bucketed typed pool for dashboard sections.
    es.GENERAL_EVIDENCE,
    es.SOCIAL_EVIDENCE,
    es.OTHER_EVIDENCE,
    -- Legacy columns for front-end backward compat. Remove once consumers
    -- have migrated to EVIDENCE (filter by type for proof / VoC / etc.).
    e.SOCIAL_PROOF,
    e.VOICE_OF_CUSTOMER,
    e.VIBE_SHIFT,
    e.NAME_CANDIDATES_CONSIDERED,
    e.NAME_REVIEWER,
    ts.TOP_SIGNALS,
    mt.MACROTREND_TAGS,
    r.RELATED_TRENDS,
    e.ENRICHED_AT,

    -- 2026-06-08 (#37): canonical trend embedding for the Hunter B2C feed
    -- recommender (distances / clusters / per-user aggregate vectors). Reuses
    -- the trend_vectors CTE already built for RELATED_TRENDS — same "latest
    -- enrichment vector, scoped to live FCT_TRENDS" semantics — so this is
    -- purely additive (no new scan). Model encoded in the wire-facing name so
    -- it's self-documenting; the underlying ledger column stays TREND_VECTOR
    -- (no rename → no repo/prod drift). Only the 1024-dim trend-concept space
    -- is exposed; the 768-dim arctic-embed-m-v1.5 GSC space stays internal.
    --
    -- API note (Marcelo): consumers must select columns EXPLICITLY — never
    -- SELECT * — so this ~4KB/row vector doesn't ride into ATLAS payloads that
    -- don't need it.
    --
    -- Scale note: the real cliff is the O(n²) pairwise cosine in
    -- pairwise_similarity (~100M VECTOR_COSINE_SIMILARITY calls/refresh at
    -- ~10k trends), NOT vector storage. Flag for a future VECTOR_SEARCH/ANN
    -- migration. Not a today problem at ~200 trends.
    tv.TREND_VECTOR                                                       AS TREND_VECTOR_ARCTIC_EMBED_L_V2_0,

    -- 2026-08-18 (CRMA-452): top-N nearest published-content matches, see
    -- the nearest_content CTE + fct_trend_content_matches_ledger.sql.
    nc.NEAREST_CONTENT

FROM trend_base tb
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t  ON tb.TREND_ID = t.TREND_ID
LEFT JOIN latest_enrichment e                         ON tb.TREND_ID = e.TREND_ID
LEFT JOIN latest_gtrends lg                           ON tb.TREND_ID = lg.TREND_ID
LEFT JOIN evidence_split es                           ON tb.TREND_ID = es.TREND_ID
LEFT JOIN top_signals ts                              ON tb.TREND_ID = ts.TREND_ID
LEFT JOIN macro_tags mt                               ON tb.TREND_ID = mt.TREND_ID
LEFT JOIN related_trends r                            ON tb.TREND_ID = r.TREND_ID
LEFT JOIN trend_vectors tv                            ON tb.TREND_ID = tv.TREND_ID
LEFT JOIN latest_prediction pred                      ON tb.TREND_ID = pred.TREND_ID
LEFT JOIN nearest_content nc                          ON tb.TREND_ID = nc.TREND_ID;
