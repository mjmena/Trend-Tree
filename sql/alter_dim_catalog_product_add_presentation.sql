-- Adds the four presentation columns to the live DIM_CATALOG_PRODUCT
-- (CRMA-1328; field rules decided on CRMA-1327).
--
-- Run this as ONE statement. NEVER run sql/dim_catalog_product.sql against
-- the live table: it is CREATE OR REPLACE TABLE, which drops every seeded
-- row and its paid Cortex embedding. That file is the shape a fresh
-- environment gets; this file is the migration.
--
-- Run it BEFORE deploying the catalog-sync job or the ecomm agent that
-- reference these columns — the MERGE and the retrieval query both fail
-- against a table without them.
--
-- The columns are NULLABLE. Every row reads NULL until the next catalog
-- sweep writes it. Sourcing candidates written before that sweep keep NULL;
-- this migration does not backfill them.
--
--   PRODUCT_URL  https://<store domain>/products/<handle>
--   PRICE        lowest price among available variants, else lowest of all
--                variants ("from $X")
--   IMAGE_URL    images[0].src, the featured image; NULL with no images
--   AVAILABLE    TRUE when any variant is available

ALTER TABLE MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT ADD COLUMN IF NOT EXISTS
  PRODUCT_URL VARCHAR       COMMENT 'storefront product page: https://<store domain>/products/<handle> (CRMA-1328)',
  PRICE       NUMBER(10,2)  COMMENT 'lowest variants[].price among available variants, else lowest of all variants — read as "from $X" (CRMA-1328)',
  IMAGE_URL   VARCHAR       COMMENT 'images[0].src, the featured image; NULL when the product has no images (CRMA-1328)',
  AVAILABLE   BOOLEAN       COMMENT 'TRUE when any variant is available (CRMA-1328)';
