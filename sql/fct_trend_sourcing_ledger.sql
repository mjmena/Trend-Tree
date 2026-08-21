-- FCT_TREND_SOURCING_LEDGER (CRMA-774, epic CRMA-772 "Trend-to-product sourcing")
-- — the run header for the sourcing pass. One row per (trend, tier, run):
-- PROC_SOURCING_APPLY writes a 'running' row when a run starts, then a later
-- call completes that SAME row in place to a terminal STATUS
-- (matched/no_match/failed). This is a deliberate, disclosed exception to
-- this repo's append-only ledger convention (FCT_TREND_CONNECTIONS_LEDGER /
-- FCT_TREND_PREDICTION_LEDGER never mutate a written row) — the header must
-- exist and read as 'running' the instant a run starts, which a pure-append
-- design can't express without a separate "current state" query. Only the
-- header row is mutated (once, running->terminal); FCT_TREND_SOURCING_CANDIDATES
-- stays fully append-only — written once by the same 'complete' call, never
-- updated after. This ledger is also the first in this repo to deliberately
-- record a computed-but-empty result:
--
--   * no header row for a (trend, tier)  -> not sourced yet
--   * STATUS = 'no_match', zero rows in FCT_TREND_SOURCING_CANDIDATES
--                                         -> processed, nothing cleared the bar
--   * STATUS = 'matched', >=1 candidate row with SELECTED=TRUE
--                                         -> processed, something to show
--   * STATUS = 'failed', ERROR_MESSAGE set
--                                         -> processed, errored — the poll's
--                                            anti-join does not see a 'failed'
--                                            header as sourced, so the next
--                                            tick retries automatically
--
-- Every other ledger in this repo (FCT_TREND_CONTENT_MATCHES_LEDGER,
-- FCT_TREND_CONNECTIONS_LEDGER) writes nothing at all when a computation
-- clears no rows — an empty result and "never ran" are indistinguishable
-- there. This ledger exists specifically so a Decision Page panel can tell
-- "processed, nothing matched" apart from "not sourced" and "failed" in one
-- SELECT (see test/sourcing.test.sql for the fixture that proves it).
--
-- TIER is a free string, not a constrained enum — 'shopify' is the only tier
-- implemented today, but the multi-tier contract (docs/prd/trend-to-product-
-- sourcing.md) requires a future tier to add rows here with no DDL change.
-- CANDIDATE_COUNT / SELECTED_COUNT are 0 for 'no_match' (we know the pool was
-- empty) and NULL for 'failed' (we may not have gotten far enough to know).

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER (
  SOURCING_RUN_ID      VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  TREND_ID             VARCHAR(64)   NOT NULL                 COMMENT 'FCT_TRENDS.TREND_ID',
  TIER                 VARCHAR(32)   NOT NULL                 COMMENT 'e.g. shopify — one product catalog ranked by commercial preference; free string, new tiers add rows not columns',
  STARTED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP() COMMENT 'set by the open call',
  COMPLETED_AT         TIMESTAMP_NTZ                          COMMENT 'set by the complete call; NULL while STATUS=running',
  STATUS               VARCHAR(16)   DEFAULT 'running'        COMMENT 'running | matched | no_match | failed',
  ERROR_MESSAGE        VARCHAR(2000)                          COMMENT 'set only when STATUS=failed',
  SEMANTIC_THRESHOLD   FLOAT                                  COMMENT 'cosine floor in effect for this run (Shopify tier: 0.40)',
  CANDIDATE_COUNT      NUMBER                                 COMMENT 'rows written to FCT_TREND_SOURCING_CANDIDATES for this run — 0 for no_match, NULL for failed',
  SELECTED_COUNT       NUMBER                                 COMMENT 'COUNT(SELECTED=TRUE) among this run''s candidates — 0 for no_match, NULL for failed',
  SELECTOR_NOTE        VARCHAR                                COMMENT 'the selector''s run-level pool_note; populated for no_match, optional for matched, NULL for failed',
  MODEL_USED           VARCHAR                                COMMENT 'e.g. gemini-3.7-flash',
  EMBED_DOC_VERSION    VARCHAR                                COMMENT 'DIM_CATALOG_PRODUCT embed-doc recipe version in effect for this run''s retrieval (e.g. v1 for the Shopify tier)',
  COMPUTATION_VERSION  VARCHAR       DEFAULT 'v1'             COMMENT 'bump when the retrieval/selection rule changes; auditable lineage',
  AGENT_SESSION_ID     VARCHAR(64)                            COMMENT 'correlates to the STG_AGENT_RUN_COSTS row for this run'
);
