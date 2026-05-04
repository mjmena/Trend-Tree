// Distillation Subagent — q_fetch_neighbors
//
// Replaces the inline proxy step that queried stale FCT_TRENDS columns
// (TREND_TOPIC, TREND_HEAT_INDEX, etc.) removed in the 2026-04-28 refactor.
// Sources from DT_TREND_DASHBOARD which is the canonical post-refactor surface.

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
      database: "MCC_PRESENTATION",
      schema: "TREND_AGENT",
      role: "MARKETING_ENGINEER",
    });

    try {
      const rows = await execute(
        conn,
        `SELECT TREND_ID, TREND_NAME, TOTAL_CLUSTER_SIZE,
                DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION,
                COALESCE(HEAT_INDEX, 0) AS HEAT_INDEX,
                LAST_LIFECYCLE_EVAL_AT
         FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
         WHERE COALESCE(LIFECYCLE_STATUS, '') NOT IN ('RETIRED', 'DORMANT')
           AND COALESCE(LAST_LIFECYCLE_EVAL_AT, ENRICHED_AT) > DATEADD(day, -30, CURRENT_TIMESTAMP())
         ORDER BY COALESCE(HEAT_INDEX, 0) DESC NULLS LAST
         LIMIT 200`,
        [],
      );
      const out = Array.isArray(rows) ? rows : [];
      $.export("$summary", `${out.length} neighbor trends`);
      return out;
    } finally {
      await destroy(conn);
    }
  },
});
