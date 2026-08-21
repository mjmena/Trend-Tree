// Ecomm Agent — read-only context gather (CRMA-776, epic CRMA-772).
//
// Ported from the removed Pipedream step ecomm-agent/fetch_context/entry.mjs.
// The one substantive change the Cloud Run move buys: checkCatalogFreshness is
// now IMPORTED from services/lib/sourcing_run.mjs instead of being an inlined
// copy — the image bundles the whole services/ tree, so the Pipedream
// no-cross-file-imports constraint that forced the duplication is gone.
//
// Four reads, short-circuited in order so nothing unnecessary runs:
//   1. Catalog freshness — MAX(LAST_SEEN_AT) over this tier's active rows.
//      Stale (or empty) catalog -> catalog_fresh=false immediately; the run
//      declines without ever calling PROC_SOURCING_APPLY.
//   2. The trend's latest REAL (non-seed) enrichment vector, joined to
//      FCT_TRENDS for the name/category/subcategory the selector prompt needs.
//      Zero rows means "no sourceable vector yet" (including a trend_id that
//      doesn't exist at all) -> trend_found=false; the run still opens a
//      header and completes it 'failed' (this IS a run, just one that can't
//      proceed — distinct from a freshness decline, which is never a run).
//   3. Retrieval (sql/sourcing_retrieval_query.sql, verbatim) — only when 1
//      and 2 both succeeded.
//   4. The sourcing.selector v1 prompt row — only when retrieval ran.

import { checkCatalogFreshness } from "../lib/sourcing_run.mjs";
import { runWithRetry } from "./snowflake.mjs";

const Q_FRESHNESS = `
  SELECT MAX(LAST_SEEN_AT) AS MAX_LAST_SEEN_AT
  FROM MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT
  WHERE TIER = ? AND CATALOG_STATUS = 'active'
`;

const Q_TREND = `
  SELECT
    t.TREND_ID,
    COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, el.PAYLOAD:trend_name_b2c::STRING) AS TREND_NAME,
    t.CATEGORY,
    t.SUBCATEGORY,
    el.PAYLOAD:summary_short::STRING AS SUMMARY_SHORT
  FROM (
    SELECT TREND_ID, PAYLOAD
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE TREND_ID = ? AND WRITTEN_BY <> 'promotion' AND TREND_VECTOR IS NOT NULL
    ORDER BY WRITTEN_AT DESC
    LIMIT 1
  ) el
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = el.TREND_ID
`;

// Verbatim shape of sql/sourcing_retrieval_query.sql (see that file for the
// full rationale, incl. the TIER-scoping deviation from the story's literal
// reference query, and test/sourcing_retrieval.test.sql for its fixture
// coverage). Only the bind syntax differs — `?` positional here vs the SQL
// file's documentary `:trend_id` / `:tier`. Keep the two in sync.
const Q_RETRIEVAL = `
  WITH t AS (
    SELECT TREND_VECTOR
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE TREND_ID = ?
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
    ON p.TIER = ?
   AND p.CATALOG_STATUS = 'active'
  WHERE VECTOR_COSINE_SIMILARITY(t.TREND_VECTOR, p.PRODUCT_VECTOR) >= 0.40
  ORDER BY SEMANTIC_SCORE DESC
  LIMIT 10
`;

// ORDER BY VERSION DESC LIMIT 1: defense in depth against a seed re-run ever
// leaving two IS_ACTIVE=TRUE rows for this key (DIM_LLM_PROMPT's PRIMARY KEY
// is informational-only in Snowflake, not enforced) — always deterministically
// pick the newest version rather than an arbitrary row.
const Q_PROMPT = `
  SELECT TEMPLATE, MODEL, MODEL_PARAMS
  FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  WHERE PROMPT_KEY = 'sourcing.selector' AND IS_ACTIVE = TRUE
  ORDER BY VERSION DESC
  LIMIT 1
`;

export async function fetchContext({ connOpts, trend_id, tier }) {
  const freshRows = await runWithRetry(connOpts, Q_FRESHNESS, [tier]);
  const maxLastSeenAt = freshRows?.[0]?.MAX_LAST_SEEN_AT ?? null;
  const freshness = checkCatalogFreshness(maxLastSeenAt);

  // Guarded, not `new Date(x).toISOString()`: that throws RangeError on an
  // unparseable value, and this line runs BEFORE the decline branch — so it
  // would 500 the request (no header, no cost row) on exactly the input
  // checkCatalogFreshness is written to turn into a clean decline.
  const seenAt = maxLastSeenAt ? new Date(maxLastSeenAt) : null;
  const seenAtIso = seenAt && !Number.isNaN(seenAt.getTime()) ? seenAt.toISOString() : null;

  const base = {
    trend_id,
    tier,
    catalog_fresh: freshness.fresh,
    catalog_age_days: freshness.ageDays,
    catalog_max_last_seen_at: seenAtIso,
    decline_reason: freshness.reason,
  };

  if (!freshness.fresh) {
    console.log(`ecomm-agent fetch_context: DECLINE trend=${trend_id} reason=${freshness.reason}`);
    return { ...base, trend_found: false, trend: null, pool: [], prompt: null };
  }

  const trendRows = await runWithRetry(connOpts, Q_TREND, [trend_id]);
  if (!trendRows || trendRows.length === 0) {
    console.log(`ecomm-agent fetch_context: trend=${trend_id} has NO real (non-seed) enrichment vector`);
    return { ...base, trend_found: false, trend: null, pool: [], prompt: null };
  }
  const trendRow = trendRows[0];
  const trend = {
    trend_name: trendRow.TREND_NAME ?? null,
    category: trendRow.CATEGORY ?? null,
    subcategory: trendRow.SUBCATEGORY ?? null,
    summary_short: trendRow.SUMMARY_SHORT ?? null,
  };

  const [retrievalRows, promptRows] = await Promise.all([
    runWithRetry(connOpts, Q_RETRIEVAL, [trend_id, tier]),
    runWithRetry(connOpts, Q_PROMPT, []),
  ]);

  // product_handle: the Shopify tier's CATALOG_PRODUCT_ID IS the product
  // handle (sql/dim_catalog_product.sql: "shopify tier: the product Handle";
  // DIM_CATALOG_PRODUCT carries no separate handle column). A future
  // non-Shopify tier whose CATALOG_PRODUCT_ID is NOT the handle (e.g. an ASIN)
  // would need to fetch/derive PRODUCT_HANDLE separately here — this
  // assumption is tier-scoped, not a general truth.
  const pool = (retrievalRows || []).map((r) => ({
    catalog_product_id: r.CATALOG_PRODUCT_ID,
    product_handle: r.CATALOG_PRODUCT_ID,
    product_title: r.PRODUCT_TITLE ?? null,
    vendor: r.VENDOR ?? null,
    product_type: r.PRODUCT_TYPE ?? null,
    embed_doc: r.EMBED_DOC ?? "",
    semantic_score: typeof r.SEMANTIC_SCORE === "number" ? r.SEMANTIC_SCORE : Number(r.SEMANTIC_SCORE),
  }));

  let prompt = null;
  if (promptRows && promptRows.length > 0) {
    let modelParams = {};
    try {
      modelParams =
        typeof promptRows[0].MODEL_PARAMS === "string"
          ? JSON.parse(promptRows[0].MODEL_PARAMS)
          : promptRows[0].MODEL_PARAMS || {};
    } catch (e) {
      console.log(
        `ecomm-agent fetch_context: sourcing.selector MODEL_PARAMS failed to parse, falling back to {} (selector call will use its hardcoded defaults): ${e.message}`,
      );
      modelParams = {};
    }
    prompt = { template: promptRows[0].TEMPLATE, model: promptRows[0].MODEL, params: modelParams };
  }

  console.log(`ecomm-agent fetch_context: trend=${trend_id} pool_size=${pool.length} prompt_loaded=${!!prompt}`);
  return { ...base, trend_found: true, trend, pool, prompt };
}
