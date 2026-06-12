// Ingest Gemini Other — upsert_signals
//
// MERGEs fetched signals into STG_EXTERNAL_SIGNALS.
//
// Direct snowflake-sdk connection with bounded retry (issue #46): the
// snowflake-execute-sql-query registry action's proxy (sqlProxyClient)
// intermittently failed with "Error contacting database". Connect-phase
// failures always retry; execute-phase failures retry only on
// connection-level signatures (the MERGE is idempotent, so a retry is
// safe either way).
//
// Reads `signals_json` directly from steps.fetch_source.$return_value
// and passes it as a real bind param, replacing the old $$...$$ inlining.

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
MERGE INTO MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS AS target
USING (
  SELECT
    s.value:SIGNAL_ID::STRING        AS SIGNAL_ID,
    s.value:SOURCE_NAME::STRING      AS SOURCE_NAME,
    TRY_TO_TIMESTAMP_NTZ(s.value:SIGNAL_TIMESTAMP::STRING) AS SIGNAL_TIMESTAMP,
    s.value:SIGNAL_TITLE::STRING     AS SIGNAL_TITLE,
    s.value:SIGNAL_TEXT::STRING      AS SIGNAL_TEXT,
    TRY_PARSE_JSON(s.value:METADATA::STRING) AS METADATA
  FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) s
) AS source
ON target.SIGNAL_ID = source.SIGNAL_ID
WHEN MATCHED THEN UPDATE SET
  target.SIGNAL_TIMESTAMP = source.SIGNAL_TIMESTAMP,
  target.SIGNAL_TITLE     = source.SIGNAL_TITLE,
  target.SIGNAL_TEXT      = source.SIGNAL_TEXT,
  target.METADATA         = source.METADATA
WHEN NOT MATCHED THEN INSERT (
  SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP, SIGNAL_TITLE, SIGNAL_TEXT, METADATA
) VALUES (
  source.SIGNAL_ID, source.SOURCE_NAME, source.SIGNAL_TIMESTAMP,
  source.SIGNAL_TITLE, source.SIGNAL_TEXT, source.METADATA
)
`;

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
  },
  async run({ steps, $ }) {
    const signalsJson = steps.fetch_source?.$return_value?.signals_json || "[]";
    if (signalsJson === "[]") {
      console.log("No signals to upsert; skipping");
      $.export("$summary", "0 signals (skipped)");
      return { signals: 0, skipped: true };
    }

    const auth = this.snowflake.$auth;
    console.log(`Merging ${signalsJson.length} bytes of signals JSON`);

    const rows = await runWithRetry(
      {
        account: auth.account,
        username: auth.username,
        privateKey: auth.private_key,
        authenticator: "SNOWFLAKE_JWT",
        database: "MCC_RAW",
        schema: "MARKETING_DEV",
        role: "MARKETING_ENGINEER",
      },
      SQL,
      [signalsJson],
    );

    const row = rows?.[0] || {};
    $.export(
      "$summary",
      `${row["number of rows inserted"] ?? 0} inserted, ${row["number of rows updated"] ?? 0} updated`,
    );
    return rows;
  },
});
