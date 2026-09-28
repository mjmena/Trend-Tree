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
-- Seeded once from a CSV export (scripts/seed_catalog_from_csv.mjs,
-- CRMA-773) and kept current by the daily Cloud Run job
-- trend-tree-catalog-sync (services/catalog-sync, CRMA-777), which sweeps the
-- public storefront products.json feed. Both producers normalize their raw
-- rows into the same shape and call the shared
-- services/lib/catalog_transform.mjs planner and services/lib/catalog_sql.mjs
-- writers, so the upsert/delist/re-embed semantics below are identical
-- regardless of source. (The column COMMENTs below still name the planner's
-- pre-CRMA-777 path, agents/lib/; they mirror the live table's metadata.)
--
-- The presentation fields (PRODUCT_URL, PRICE, IMAGE_URL, AVAILABLE) are
-- overwritten on every sweep and never enter the embed doc, so a price change
-- never re-embeds (CRMA-1328). The live table got them by
-- sql/alter_dim_catalog_product_add_presentation.sql. A product
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

  PRODUCT_URL          VARCHAR       COMMENT 'storefront product page: https://<store domain>/products/<handle> (CRMA-1328)',
  PRICE                NUMBER(10,2)  COMMENT 'lowest variants[].price among available variants, else lowest of all variants — read as "from $X" (CRMA-1328)',
  IMAGE_URL            VARCHAR       COMMENT 'images[0].src, the featured image; NULL when the product has no images (CRMA-1328)',
  AVAILABLE            BOOLEAN       COMMENT 'TRUE when any variant is available (CRMA-1328)',

  PRIMARY KEY (TIER, CATALOG_PRODUCT_ID)
);
