// Ecomm Agent — fetch_context
//
// Read-only Snowflake gather for one trend's sourcing pass (CRMA-776).
// Direct snowflake-sdk connection with bounded retry (same pattern as
// prediction-agent-p_QPCkLP1/commit_to_ledger/entry.mjs — issue #46: the
// snowflake-execute-sql-query registry action's proxy intermittently fails
// with "Error contacting database", and bind parameters here also avoid
// ever mustache-templating raw trend/product text into a SQL string).
//
// Four reads, short-circuited in order so nothing unnecessary runs:
//   1. Catalog freshness — MAX(LAST_SEEN_AT) over this tier's active rows.
//      Stale (or empty) catalog -> return catalog_fresh=false immediately;
//      run_sourcing declines without ever calling PROC_SOURCING_APPLY.
//   2. The trend's latest REAL (non-seed) enrichment vector, joined to
//      FCT_TRENDS for the name/category/subcategory the selector prompt
//      needs. Zero rows means "no sourceable vector yet" (including a
//      trend_id that doesn't exist at all) -> trend_found=false;
//      run_sourcing still opens a header and completes it 'failed' (this
//      IS a run, just one that can't proceed — distinct from a freshness
//      decline, which is never a run at all).
//   3. Retrieval (sql/sourcing_retrieval_query.sql, verbatim) — only run
//      when 1 and 2 both succeeded.
//   4. The sourcing.selector v1 prompt row — only fetched when retrieval
//      ran; cheap, and skipping it when declined/not-found avoids a
//      pointless query.

import snowflake from "snowflake-sdk";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const TRANSIENT =
  /network|could not reach|unable to connect|connection|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|disconnect|timed out|timeout/i;
const CATALOG_FRESHNESS_MAX_DAYS = 7;

function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWithRetry(connOpts, sqlText, binds) {
  for (let attempt = 1; ; attempt++) {
    let conn;
    let connected = false;
    try {
      conn = await connect(connOpts);
      connected = true;
      return await execute(conn, sqlText, binds);
    } catch (err) {
      const transient = !connected || TRANSIENT.test(String(err.message || err));
      if (!transient || attempt >= MAX_ATTEMPTS) {
        err.message = `Snowflake ${connected ? "execute" : "connect"} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`;
        throw err;
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? 3000;
      console.log(`Transient Snowflake error on attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}; retrying in ${backoff}ms`);
      await sleep(backoff);
    } finally {
      if (conn) await destroy(conn);
    }
  }
}

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
// reference query).
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

const Q_PROMPT = `
  SELECT TEMPLATE, MODEL, MODEL_PARAMS
  FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  WHERE PROMPT_KEY = 'sourcing.selector' AND IS_ACTIVE = TRUE
`;

function checkFreshness(maxLastSeenAt, now = new Date()) {
  if (!maxLastSeenAt) {
    return { fresh: false, ageDays: null, reason: "catalog has no active rows (MAX(LAST_SEEN_AT) is null)" };
  }
  const seenAt = maxLastSeenAt instanceof Date ? maxLastSeenAt : new Date(maxLastSeenAt);
  if (Number.isNaN(seenAt.getTime())) {
    return { fresh: false, ageDays: null, reason: `unparseable catalog LAST_SEEN_AT: ${String(maxLastSeenAt)}` };
  }
  const ageDaysRaw = (now.getTime() - seenAt.getTime()) / (1000 * 60 * 60 * 24);
  const ageDays = Math.round(ageDaysRaw * 100) / 100;
  const fresh = ageDaysRaw <= CATALOG_FRESHNESS_MAX_DAYS;
  return {
    fresh,
    ageDays,
    reason: fresh ? null : `catalog MAX(LAST_SEEN_AT) is ${ageDays} days old, exceeds the ${CATALOG_FRESHNESS_MAX_DAYS}-day freshness gate`,
  };
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    trend_id: { type: "string" },
    tier: { type: "string" },
  },
  async run({ $ }) {
    const auth = this.snowflake.$auth;
    const connOpts = {
      account: auth.account,
      username: auth.username,
      privateKey: auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_PRESENTATION",
      schema: "TREND_AGENT",
      role: "MARKETING_ENGINEER",
    };

    const freshRows = await runWithRetry(connOpts, Q_FRESHNESS, [this.tier]);
    const maxLastSeenAt = freshRows?.[0]?.MAX_LAST_SEEN_AT ?? null;
    const freshness = checkFreshness(maxLastSeenAt);

    const base = {
      trend_id: this.trend_id,
      tier: this.tier,
      catalog_fresh: freshness.fresh,
      catalog_age_days: freshness.ageDays,
      catalog_max_last_seen_at: maxLastSeenAt ? new Date(maxLastSeenAt).toISOString() : null,
      decline_reason: freshness.reason,
    };

    if (!freshness.fresh) {
      console.log(`ecomm-agent fetch_context: DECLINE trend=${this.trend_id} reason=${freshness.reason}`);
      $.export("$summary", `declined: ${freshness.reason}`);
      return { ...base, trend_found: false, trend: null, pool: [], prompt: null };
    }

    const trendRows = await runWithRetry(connOpts, Q_TREND, [this.trend_id]);
    if (!trendRows || trendRows.length === 0) {
      console.log(`ecomm-agent fetch_context: trend=${this.trend_id} has NO real (non-seed) enrichment vector`);
      $.export("$summary", `${this.trend_id}: no sourceable vector`);
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
      runWithRetry(connOpts, Q_RETRIEVAL, [this.trend_id, this.tier]),
      runWithRetry(connOpts, Q_PROMPT, []),
    ]);

    const pool = (retrievalRows || []).map((r) => ({
      catalog_product_id: r.CATALOG_PRODUCT_ID,
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
        modelParams = typeof promptRows[0].MODEL_PARAMS === "string" ? JSON.parse(promptRows[0].MODEL_PARAMS) : (promptRows[0].MODEL_PARAMS || {});
      } catch {
        modelParams = {};
      }
      prompt = { template: promptRows[0].TEMPLATE, model: promptRows[0].MODEL, params: modelParams };
    }

    console.log(`ecomm-agent fetch_context: trend=${this.trend_id} pool_size=${pool.length} prompt_loaded=${!!prompt}`);
    $.export("$summary", `${this.trend_id}: ${pool.length} candidate(s)`);
    return { ...base, trend_found: true, trend, pool, prompt };
  },
});
