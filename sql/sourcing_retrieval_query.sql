-- Sourcing retrieval query (CRMA-776, epic CRMA-772 "Trend-to-product
-- sourcing") — Shopify tier. Canonical reference copy of the query the
-- ecomm agent's fetch_context step runs (inlined there verbatim, per this
-- repo's Pipedream-synced-project constraint: no cross-workflow imports —
-- see the pipedream-synced-project skill). test/sourcing_retrieval.test.sql
-- exercises this exact shape against real DIM_CATALOG_PRODUCT /
-- FCT_TREND_ENRICHMENT_LEDGER fixture rows.
--
-- Cosine similarity between the trend's persisted TREND_VECTOR (latest
-- REAL, non-seed enrichment row — WRITTEN_BY <> 'promotion' excludes the
-- promotion_seed rows written at promotion time, which carry a topic-only
-- vector, not a real embedding) and every active Shopify-tier catalog
-- product's PRODUCT_VECTOR. Shopify tier: floor SEMANTIC_THRESHOLD=0.40,
-- TOP_N=10, score-descending. No trend-side re-embed — the vector already
-- exists (agents/lib/sourcing_run.mjs: SEMANTIC_THRESHOLD, TOP_N).
--
-- One deviation from the story's literal reference query: this adds
-- `p.TIER = 'shopify'` to the join. DIM_CATALOG_PRODUCT is explicitly a
-- multi-tier dimension (sql/dim_catalog_product.sql: "One dimension for
-- ALL sourcing tiers") and PROC_SOURCING_APPLY writes a header per
-- (trend, TIER) — omitting the TIER filter works today only by coincidence
-- (Shopify is the only tier with any rows), and would silently blend a
-- future second tier's candidates into this tier's pool the moment one
-- exists, which the PRD explicitly forbids ("each consulted tier writes
-- its own header... Cross-tier SEMANTIC_SCOREs are never compared").
--
-- Usage (the workflow substitutes :trend_id and :tier at runtime):
--   the CTE resolves the trend's latest real vector; if it returns zero
--   rows, the workflow's fetch_context step treats that as "no sourceable
--   vector yet" (see agents/lib/sourcing_run.mjs's design-decisions note
--   on the resulting 'failed' outcome) rather than running this query at
--   all.

WITH t AS (
  SELECT TREND_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_ID = :trend_id
    AND WRITTEN_BY <> 'promotion'
    AND TREND_VECTOR IS NOT NULL
  ORDER BY WRITTEN_AT DESC
  LIMIT 1
)
SELECT
  p.CATALOG_PRODUCT_ID,
  p.TITLE            AS PRODUCT_TITLE,
  p.VENDOR,
  p.PRODUCT_TYPE,
  p.EMBED_DOC,
  ROUND(VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR), 4) AS SEMANTIC_SCORE
FROM t
JOIN MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT p
  ON p.TIER = :tier
 AND p.CATALOG_STATUS = 'active'
WHERE VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR) >= 0.40
ORDER BY SEMANTIC_SCORE DESC
LIMIT 10;
