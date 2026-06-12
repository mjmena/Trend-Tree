// Prediction Agent — commit_to_ledger
//
// Scores all live trends and writes the daily batch to
// FCT_TREND_PREDICTION_LEDGER in a single INSERT...SELECT (no proc, no
// JSON round-trip — see issue #33 / the proxy-413 history).
//
// Direct snowflake-sdk connection with bounded retry (issue #46): the
// snowflake-execute-sql-query registry action's proxy (sqlProxyClient)
// intermittently failed with "Error contacting database", and one blip
// killed the whole daily scoring run. Connect-phase failures always
// retry; execute-phase failures retry only on connection-level
// signatures. The NOT EXISTS guard on CHAIN_ID makes the INSERT
// idempotent if a retry races an ambiguous mid-execute disconnect.
//
// Returns the row array ([{ "number of rows inserted": N }]), same shape
// the registry action returned — `respond` depends on it.

import snowflake from "snowflake-sdk";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const TRANSIENT =
  /network|could not reach|unable to connect|connection|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|disconnect|timed out|timeout/i;

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
      console.log(
        `Transient Snowflake error on attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}; retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    } finally {
      if (conn) await destroy(conn);
    }
  }
}

const SQL = `
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER (
  TREND_ID, CHAIN_ID,
  PREDICTION_SCORE, PREDICTION_FLAG, PREDICTION_ELIGIBLE,
  INPUT_HEAT_NOW, INPUT_HEAT_7D, INPUT_HEAT_14D,
  INPUT_ACCELERATION, INPUT_INVERSE_HEAT,
  INPUT_SOURCES_LAST_7D, INPUT_SOURCES_PRIOR_7D, INPUT_SOURCE_DELTA,
  INPUT_SIGNALS_LAST_7D, INPUT_SIGNALS_PRIOR_7D, INPUT_SIGNAL_DELTA,
  INPUT_SCORE_PERCENTILE, DAYS_SINCE_PROMOTION, COMPUTATION_VERSION
)
WITH lifecycle_now AS (
  SELECT TREND_ID,
         NEW_HEAT_SMOOTHED AS heat_now,
         NEW_STATUS        AS lifecycle_status
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  ) WHERE rn = 1
),
lifecycle_7d AS (
  SELECT TREND_ID, NEW_HEAT_SMOOTHED AS heat_7d
  FROM (
    SELECT TREND_ID, NEW_HEAT_SMOOTHED, EVALUATED_AT,
           ROW_NUMBER() OVER (
             PARTITION BY TREND_ID
             ORDER BY ABS(DATEDIFF('hour', EVALUATED_AT, DATEADD(day, -7, CURRENT_TIMESTAMP())))
           ) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    WHERE EVALUATED_AT BETWEEN DATEADD(day, -9, CURRENT_TIMESTAMP())
                           AND DATEADD(day, -5, CURRENT_TIMESTAMP())
  ) WHERE rn = 1
),
lifecycle_14d AS (
  SELECT TREND_ID, NEW_HEAT_SMOOTHED AS heat_14d
  FROM (
    SELECT TREND_ID, NEW_HEAT_SMOOTHED, EVALUATED_AT,
           ROW_NUMBER() OVER (
             PARTITION BY TREND_ID
             ORDER BY ABS(DATEDIFF('hour', EVALUATED_AT, DATEADD(day, -14, CURRENT_TIMESTAMP())))
           ) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    WHERE EVALUATED_AT BETWEEN DATEADD(day, -16, CURRENT_TIMESTAMP())
                           AND DATEADD(day, -12, CURRENT_TIMESTAMP())
  ) WHERE rn = 1
),
signal_domains AS (
  SELECT s.SIGNAL_ID,
    CASE
      WHEN s.SOURCE_NAME = 'wikimedia'             THEN 'wikipedia.org'
      WHEN s.SOURCE_NAME = 'amazon_trends'         THEN 'amazon.com'
      WHEN s.SOURCE_NAME = 'tiktok'                THEN 'tiktok.com'
      WHEN s.SOURCE_NAME = 'pinterest'             THEN 'pinterest.com'
      WHEN s.SOURCE_NAME = 'bluesky'               THEN 'bsky.app'
      WHEN s.SOURCE_NAME = 'google_trends_explore' THEN 'trends.google.com'
      WHEN s.SOURCE_NAME = 'grok_live'             THEN 'x.com'
      WHEN s.SOURCE_NAME = 'gdelt'
        THEN LOWER(REGEXP_REPLACE(s.METADATA:domain::STRING, '^www[.]', ''))
      WHEN STARTSWITH(s.SOURCE_NAME, 'gemini_')
        THEN LOWER(s.METADATA:source_name::STRING)
      WHEN STARTSWITH(s.SOURCE_NAME, 'agent_') AND ENDSWITH(s.SOURCE_NAME, '_discovery') THEN
        CASE
          WHEN s.METADATA:canonical_url::STRING LIKE '%vertexaisearch.cloud.google.com%' THEN NULL
          ELSE LOWER(REGEXP_REPLACE(
            REGEXP_SUBSTR(s.METADATA:canonical_url::STRING, 'https?://([^/]+)', 1, 1, 'e', 1),
            '^www[.]', ''))
        END
      ELSE NULL
    END AS DOMAIN
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
),
-- Cumulative-set growth (backfill-insensitive): each publisher/signal is
-- attributed to the 7-day window in which it FIRST links to the trend, so
-- the delta is a level-difference of a monotonic distinct-count and can
-- never go negative. A bulk re-link of historical signals raises the
-- cumulative count once and it stays elevated -- no phantom cliff. (issue #33)
source_first_link AS (
  SELECT ts.TREND_ID, sd.DOMAIN, MIN(ts.LINKED_AT) AS first_linked
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  JOIN signal_domains sd ON sd.SIGNAL_ID = ts.SIGNAL_ID
  WHERE sd.DOMAIN IS NOT NULL
  GROUP BY ts.TREND_ID, sd.DOMAIN
),
sources_cumulative AS (
  SELECT TREND_ID,
         COUNT(*)                                                      AS n_now,
         COUNT_IF(first_linked < DATEADD(day, -7, CURRENT_TIMESTAMP())) AS n_prior
  FROM source_first_link
  GROUP BY TREND_ID
),
signal_first_link AS (
  SELECT TREND_ID, SIGNAL_ID, MIN(LINKED_AT) AS first_linked
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
  GROUP BY TREND_ID, SIGNAL_ID
),
signals_cumulative AS (
  SELECT TREND_ID,
         COUNT(*)                                                      AS n_now,
         COUNT_IF(first_linked < DATEADD(day, -7, CURRENT_TIMESTAMP())) AS n_prior
  FROM signal_first_link
  GROUP BY TREND_ID
),
raw AS (
  SELECT
    t.TREND_ID,
    ln.lifecycle_status,
    ln.heat_now,
    l7.heat_7d,
    l14.heat_14d,
    (ln.heat_now - l7.heat_7d) - (l7.heat_7d - l14.heat_14d) AS acceleration,
    (100 - ln.heat_now)                                       AS inverse_heat,
    COALESCE(sc.n_now, 0)                                     AS sources_last_7d,
    COALESCE(sc.n_prior, 0)                                   AS sources_prior_7d,
    (COALESCE(sc.n_now, 0) - COALESCE(sc.n_prior, 0))         AS source_delta,
    COALESCE(gc.n_now, 0)                                     AS signals_last_7d,
    COALESCE(gc.n_prior, 0)                                   AS signals_prior_7d,
    (COALESCE(gc.n_now, 0) - COALESCE(gc.n_prior, 0))         AS signal_delta,
    DATEDIFF('day', t.PROMOTED_AT, CURRENT_TIMESTAMP())       AS days_since_promotion
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
  LEFT JOIN lifecycle_now    ln  ON ln.TREND_ID  = t.TREND_ID
  LEFT JOIN lifecycle_7d     l7  ON l7.TREND_ID  = t.TREND_ID
  LEFT JOIN lifecycle_14d    l14 ON l14.TREND_ID = t.TREND_ID
  LEFT JOIN sources_cumulative sc ON sc.TREND_ID = t.TREND_ID
  LEFT JOIN signals_cumulative gc ON gc.TREND_ID = t.TREND_ID
  WHERE NVL(ln.lifecycle_status, 'NEW') != 'RETIRED'
),
scored AS (
  SELECT
    r.*,
    CASE
      WHEN r.days_since_promotion < 14
        OR r.heat_now  IS NULL
        OR r.heat_7d   IS NULL
        OR r.heat_14d  IS NULL
      THEN NULL
      ELSE ROUND(
          0.25 * GREATEST(0, LEAST(100, (r.acceleration  + 30) / 60.0  * 100))
        + 0.25 * GREATEST(0, LEAST(100, r.inverse_heat))
        + 0.25 * GREATEST(0, LEAST(100, r.source_delta / 2.0 * 100))
        + 0.25 * GREATEST(0, LEAST(100, r.signal_delta / 4.0 * 100)),
        1
      )
    END AS prediction_score
  FROM raw r
),
ranked AS (
  SELECT
    s.*,
    CASE
      WHEN s.prediction_score IS NULL THEN NULL
      ELSE PERCENT_RANK() OVER (
        PARTITION BY (CASE WHEN s.prediction_score IS NULL THEN 0 ELSE 1 END)
        ORDER BY s.prediction_score
      )
    END AS score_percentile
  FROM scored s
)
SELECT
  TREND_ID,
  ?                                                         AS CHAIN_ID,
  prediction_score                                          AS PREDICTION_SCORE,
  CASE
    WHEN prediction_score IS NULL    THEN NULL
    WHEN prediction_score >= 80      THEN 'High Potential'
    WHEN prediction_score >= 65      THEN 'Watchlist'
    WHEN prediction_score >= 40      THEN 'Emerging'
    ELSE NULL
  END                                                       AS PREDICTION_FLAG,
  (prediction_score      IS NOT NULL
    AND heat_now         <  70
    AND acceleration     >  0
    AND (source_delta > 0 OR signal_delta > 0)
    AND days_since_promotion >= 14
    AND score_percentile >= 0.70)                           AS PREDICTION_ELIGIBLE,
  heat_now                                                  AS INPUT_HEAT_NOW,
  heat_7d                                                   AS INPUT_HEAT_7D,
  heat_14d                                                  AS INPUT_HEAT_14D,
  acceleration                                              AS INPUT_ACCELERATION,
  inverse_heat                                              AS INPUT_INVERSE_HEAT,
  sources_last_7d                                           AS INPUT_SOURCES_LAST_7D,
  sources_prior_7d                                          AS INPUT_SOURCES_PRIOR_7D,
  source_delta                                              AS INPUT_SOURCE_DELTA,
  signals_last_7d                                           AS INPUT_SIGNALS_LAST_7D,
  signals_prior_7d                                          AS INPUT_SIGNALS_PRIOR_7D,
  signal_delta                                              AS INPUT_SIGNAL_DELTA,
  score_percentile                                          AS INPUT_SCORE_PERCENTILE,
  days_since_promotion                                      AS DAYS_SINCE_PROMOTION,
  'v2'                                                      AS COMPUTATION_VERSION
FROM ranked
WHERE ? <> 'true'
  -- retry-idempotence guard: a retried run no-ops if this chain already committed
  AND NOT EXISTS (
    SELECT 1
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
    WHERE CHAIN_ID = ?
  )
`;

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    chain_id: { type: "string" },
    dry_run: { type: "string", optional: true, default: "false" },
  },
  async run({ $ }) {
    const auth = this.snowflake.$auth;
    const dryRun = String(this.dry_run) === "true" ? "true" : "false";

    const rows = await runWithRetry(
      {
        account: auth.account,
        username: auth.username,
        privateKey: auth.private_key,
        authenticator: "SNOWFLAKE_JWT",
        database: "MCC_PRESENTATION",
        schema: "TREND_AGENT",
        role: "MARKETING_ENGINEER",
      },
      SQL,
      [this.chain_id, dryRun, this.chain_id],
    );

    const inserted = rows?.[0]?.["number of rows inserted"] ?? null;
    $.export("$summary", `chain ${this.chain_id}: ${inserted ?? "?"} rows inserted`);
    return rows;
  },
});
