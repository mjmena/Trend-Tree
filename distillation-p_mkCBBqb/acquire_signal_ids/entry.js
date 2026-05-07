// Distillation — acquire_signal_ids
//
// Threshold-gated unclaimed signal ID fetch. Polls every 30-60 min; exits
// early if fewer than 150 unclaimed discovery signals are available —
// $.flow.exit() is a clean non-error termination, no cursor update, and the
// next cron poll will retry. Once 150+ are available the run proceeds.
//
// Floor lowered from 400 to 150 on 2026-05-07: the original sizing assumed
// agent-derived grok_live citations would contribute ~190/day, but those
// only land when the agent runs — creating a self-gating spiral when
// discovery throughput dips. 150 reflects the realistic external-pull
// floor (bluesky + google_trends + amazon + gemini verticals).

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
         LIMIT 200`,
        [],
      );
      const ids = (Array.isArray(rows) ? rows : []).map((r) => r.SIGNAL_ID).filter(Boolean);

      if (ids.length < 150) {
        $.flow.exit(`Only ${ids.length} unclaimed signals available — waiting for 150`);
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
