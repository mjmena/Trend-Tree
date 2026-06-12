// Prediction Agent — summarize
//
// Reads the just-committed batch back from the ledger by CHAIN_ID so
// `respond` can echo counts for cron-side observability.
//
// Direct snowflake-sdk connection with bounded retry (issue #46) — see
// commit_to_ledger/entry.mjs for the rationale. Returns the row array,
// same shape the snowflake-execute-sql-query registry action returned.

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
SELECT
  COUNT(*)                          AS TOTAL_ROWS,
  COUNT(PREDICTION_SCORE)           AS SCORED_COUNT,
  COUNT_IF(PREDICTION_ELIGIBLE)     AS ELIGIBLE_COUNT,
  COUNT(*) - COUNT(PREDICTION_SCORE) AS NULL_COUNT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER
WHERE CHAIN_ID = ?
`;

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    chain_id: { type: "string" },
  },
  async run({ $ }) {
    const auth = this.snowflake.$auth;

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
      [this.chain_id],
    );

    const s = rows?.[0] || {};
    $.export(
      "$summary",
      `chain ${this.chain_id}: ${s.TOTAL_ROWS ?? 0} rows, ${s.SCORED_COUNT ?? 0} scored, ${s.ELIGIBLE_COUNT ?? 0} eligible`,
    );
    return rows;
  },
});
