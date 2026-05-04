// Distillation Subagent — q_fetch_signals
//
// Direct TCP connector replacing the HTTP proxy step. The proxy timed out
// on clusters with many URL-shaped signal IDs (large inline IN-list).
// PARSE_JSON binding sidesteps the proxy size limit entirely.

import snowflake from "snowflake-sdk";

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
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    signal_ids: { type: "any" },
  },
  async run({ $ }) {
    const ids = Array.isArray(this.signal_ids) ? this.signal_ids : [];
    if (ids.length === 0) {
      console.log("q_fetch_signals: no signal_ids; returning []");
      return [];
    }

    const auth = this.snowflake.$auth;
    const conn = await connect({
      account: auth.account,
      username: auth.username,
      privateKey: auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_RAW",
      schema: "MARKETING_DEV",
      role: "MARKETING_ENGINEER",
    });

    try {
      const rows = await execute(
        conn,
        `SELECT SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP,
                SIGNAL_TITLE, LEFT(SIGNAL_TEXT, 1500) AS SIGNAL_TEXT,
                METADATA, AGENT_SESSION_ID
         FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
         WHERE SIGNAL_ID IN (SELECT VALUE::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))))
         ORDER BY SIGNAL_TIMESTAMP DESC NULLS LAST
         LIMIT 200`,
        [JSON.stringify(ids)],
      );
      const out = Array.isArray(rows) ? rows : [];
      $.export("$summary", `${out.length} signals fetched`);
      return out;
    } finally {
      await destroy(conn);
    }
  },
});
