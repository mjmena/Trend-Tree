-- Dimension: product catalog, one mutable row per (TIER, CATALOG_PRODUCT_ID).
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Genuinely new table (CRMA-773) — no prior DIM_CATALOG_PRODUCT-shaped table
-- to extend. Backs trend-to-product sourcing (CRMA-772): a trend's
-- enrichment vector (FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR) is compared
-- against PRODUCT_VECTOR here via VECTOR_COSINE_SIMILARITY to surface
-- candidate products for a trend.
--
-- One dimension for ALL sourcing tiers, not one table per tier. TIER +
-- CATALOG_PRODUCT_ID together are the natural key — CATALOG_PRODUCT_ID's
-- shape is tier-defined (the Shopify tier keys on the product Handle; a
-- future Amazon/other tier would key on its own natural id, e.g. ASIN).
--
-- Populated today by the one-off CSV seed (scripts/seed_catalog_from_csv.mjs,
-- CRMA-773) and, later, by a recurring live-sync Cloud Run job hitting the
-- Shopify Admin REST API. Both producers normalize their raw rows into the
-- same shape and call the shared agents/lib/catalog_transform.mjs planner,
-- so the upsert/delist/re-embed semantics below are identical regardless of
-- source.
--
-- Deliberately NO presentation fields (price, image, availability) — this
-- is an identity + retrieval dimension, not a merchandising feed. A product
-- missing from a sweep is soft-delisted (CATALOG_STATUS flips to
-- 'delisted'); rows are never deleted, so historical CATALOG_PRODUCT_ID
-- references (e.g. from a sourcing suggestion already shown to a
-- strategist) never dangle.
--
-- ****************************************************************
-- WARNING: CREATE OR REPLACE TABLE is destructive on re-run — it drops and
-- recreates this table EMPTY, discarding every seeded row and its (paid)
-- Cortex embedding. This is the one table in sql/ that behaves this way on
-- purpose per CRMA-773's spec (every sibling DIM_*/FCT_* table here uses
-- CREATE TABLE IF NOT EXISTS instead). Only ever run the CREATE statement
-- below for the initial table creation or a deliberate schema migration —
-- never as a "make sure the table exists" no-op before a script run.
-- ****************************************************************

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT (
  TIER                 VARCHAR(32)   NOT NULL COMMENT 'sourcing tier — ''shopify'' is the only tier as of CRMA-773; CATALOG_PRODUCT_ID''s shape is defined per tier',
  CATALOG_PRODUCT_ID   VARCHAR(255)  NOT NULL COMMENT 'tier-scoped natural key — shopify tier: the product Handle (stable across variants, present on every export/API row)',

  TITLE                VARCHAR(1000),
  VENDOR               VARCHAR(255),
  PRODUCT_TYPE         VARCHAR(255)  COMMENT 'raw source Type/category value; literal ''0'' (Shopify''s empty-category sentinel) and true-empty both mean unset',
  TAGS                 VARCHAR       COMMENT 'raw comma-separated tag string as exported/returned by the source — NOT an array',

  EMBED_DOC            VARCHAR       COMMENT 'canonical text handed to Cortex embed; recipe: "title. Type: <type>. Vendor: <vendor>. Tags: <tags>. <body_html stripped, first 600 chars>" (Type segment omitted when unset) — see agents/lib/catalog_transform.mjs buildEmbedDoc()',
  EMBED_DOC_HASH       VARCHAR(64)   COMMENT 'sha256(EMBED_DOC) hex digest; diffed against the prior value to decide whether a (re)embed is needed — unchanged docs are never re-embedded',
  EMBED_DOC_VERSION    VARCHAR(16)   DEFAULT 'v1' COMMENT 'embed-doc recipe version; bump when the recipe changes so a version-wide re-embed can be scoped',

  PRODUCT_VECTOR       VECTOR(FLOAT, 1024) COMMENT 'SNOWFLAKE.CORTEX.EMBED_TEXT_1024(''snowflake-arctic-embed-l-v2.0'', EMBED_DOC) — same embedding space as FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR, so trend<->product cosine comparisons are valid',

  CATALOG_STATUS       VARCHAR(16)   NOT NULL DEFAULT 'active' COMMENT 'active | delisted — delisted is soft (set by a sync sweep that no longer sees this CATALOG_PRODUCT_ID); rows are never deleted',

  FIRST_SEEN_AT        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP() COMMENT 'first time this (TIER, CATALOG_PRODUCT_ID) was upserted',
  LAST_SEEN_AT         TIMESTAMP_NTZ COMMENT 'stamped with the source snapshot date each time this product is confirmed present (CSV seed: the export date; live-sync: the sweep timestamp) — drives delist detection',
  UPDATED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP() COMMENT 'bumped on every upsert, embed or not',

  PRIMARY KEY (TIER, CATALOG_PRODUCT_ID)
);
