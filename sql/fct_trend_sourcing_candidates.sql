-- FCT_TREND_SOURCING_CANDIDATES (CRMA-774, epic CRMA-772 "Trend-to-product
-- sourcing") — one row per product candidate the sourcing selector was
-- shown for a run, picks and rejects alike. Written by PROC_SOURCING_APPLY
-- only when a run completes with STATUS='matched' (see
-- fct_trend_sourcing_ledger.sql — 'no_match' and 'failed' runs write zero
-- rows here by construction).
--
-- SEMANTIC_SCORE and REASONED_FIT are kept in separate columns and are
-- NEVER blended into one: SEMANTIC_SCORE is retrieval geometry
-- (VECTOR_COSINE_SIMILARITY against the trend's persisted TREND_VECTOR,
-- reproducible from stored data) and REASONED_FIT is the selector's model
-- judgement (an enum, never a numeric score). REASONED_FIT /
-- REASONED_FIT_RATIONALE are NULL for any row with SELECTED=FALSE — the
-- selector's emit tool only grades the products it actually picked, so a
-- shown-but-rejected candidate carries a score with no verdict attached to
-- it. The rejects are calibration evidence: replaying SEMANTIC_SCORE
-- against actual selector outcomes is how the retrieval threshold gets
-- re-tuned later.
--
-- No rank column: presentation order is always derivable by sorting on
-- SEMANTIC_SCORE DESC within (SOURCING_RUN_ID) — see
-- docs/prd/trend-to-product-sourcing.md.
--
-- CATALOG_PRODUCT_ID is a loose reference to DIM_CATALOG_PRODUCT's
-- (TIER, CATALOG_PRODUCT_ID) natural key — not an enforced FK. This mirrors
-- how every other ledger in this repo references FCT_TRENDS (TREND_ID is a
-- plain VARCHAR column everywhere, no FK constraint anywhere in sql/).
-- DIM_CATALOG_PRODUCT is built by a sibling story (CRMA-773) and may not
-- exist yet at any given point in time; this table does not depend on it
-- existing to be created or written to.
--
-- TREND_ID is intentionally denormalized from the run header (also present
-- on FCT_TREND_SOURCING_LEDGER via SOURCING_RUN_ID) so per-trend candidate
-- queries don't require a join — same convenience as
-- FCT_PROMOTION_AUDIT.CANDIDATE_ID style denormalization elsewhere.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES (
  SOURCING_CANDIDATE_ID   VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  SOURCING_RUN_ID         VARCHAR       NOT NULL                COMMENT 'FCT_TREND_SOURCING_LEDGER.SOURCING_RUN_ID',
  TREND_ID                VARCHAR(64)   NOT NULL                COMMENT 'denormalized from the run header — FCT_TRENDS.TREND_ID',
  TIER                    VARCHAR(32)   NOT NULL                COMMENT 'denormalized from the run header',
  CATALOG_PRODUCT_ID      VARCHAR       NOT NULL                COMMENT 'loose reference to DIM_CATALOG_PRODUCT (TIER, CATALOG_PRODUCT_ID) — no enforced FK; Shopify tier uses the product handle as this id',
  PRODUCT_HANDLE          VARCHAR                                COMMENT 'Shopify handle — the URL identity used to build PRODUCT_URL',
  PRODUCT_TITLE           VARCHAR                                COMMENT 'frozen at match time',
  PRODUCT_TYPE            VARCHAR                                COMMENT 'frozen at match time',
  VENDOR                  VARCHAR                                COMMENT 'frozen at match time',
  PRODUCT_URL             VARCHAR                                COMMENT 'built on the store handle so every link lands on the live product page',
  PRICE_AT_MATCH          NUMBER(10,2)                           COMMENT 'frozen snapshot — the consumer hydrates live price, this is not kept fresh',
  IMAGE_URL_AT_MATCH      VARCHAR                                COMMENT 'frozen snapshot',
  AVAILABLE_AT_MATCH      BOOLEAN                                COMMENT 'frozen snapshot',
  SEMANTIC_SCORE          FLOAT                                  COMMENT 'VECTOR_COSINE_SIMILARITY(trend TREND_VECTOR, product embed vector) at match time — geometry, reproducible, never blended with REASONED_FIT',
  REASONED_FIT            VARCHAR(16)                            COMMENT 'strong | partial | weak — selector''s model verdict; NULL for rejects (SELECTED=FALSE), since the emit tool only grades picks',
  REASONED_FIT_RATIONALE  VARCHAR                                COMMENT 'selector''s one-sentence, operator-facing rationale; NULL for rejects',
  SELECTED                BOOLEAN       DEFAULT FALSE            COMMENT 'TRUE for a selector pick, FALSE for a shown-but-rejected candidate',
  CATALOG_PAYLOAD         VARIANT                                COMMENT 'tier-specific extra fields the fixed columns above do not carry — lets a second tier append without a DDL change',
  CREATED_AT              TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
