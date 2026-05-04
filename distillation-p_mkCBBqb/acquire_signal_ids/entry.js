// Distillation — acquire_signal_ids
//
// Threshold-gated unclaimed signal ID fetch. Polls every 30-60 min; exits
// early if fewer than 400 unclaimed discovery signals are available —
// $.flow.exit() is a clean non-error termination, no cursor update, and the
// next cron poll will retry. Once 400+ are available the run proceeds.

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
  },
  async run({ $ }) {
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
        `SELECT SIGNAL_ID
         FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
         WHERE SIGNAL_TIMESTAMP > DATEADD(hour, -24, CURRENT_TIMESTAMP())
           AND COALESCE(AGENT_SESSION_ID, '') = ''
           AND COALESCE(METADATA:signal_kind::STRING, 'discovery_signal') = 'discovery_signal'
         ORDER BY SIGNAL_TIMESTAMP DESC NULLS LAST
         LIMIT 450`,
        [],
      );
      const ids = (Array.isArray(rows) ? rows : []).map((r) => r.SIGNAL_ID).filter(Boolean);

      if (ids.length < 400) {
        $.flow.exit(`Only ${ids.length} unclaimed signals available — waiting for 400`);
      }

      console.log(`acquire_signal_ids: ${ids.length} unclaimed signals ready`);
      $.export("$summary", `${ids.length} signal IDs acquired`);
      return {
        signal_ids_json: JSON.stringify(ids),
        signal_ids: ids,
        count: ids.length,
      };
    } finally {
      await destroy(conn);
    }
  },
});
