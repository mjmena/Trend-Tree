// Distillation Revisit Subagent — q_fetch_neighbors (direct TCP connector)
//
// Fetches the agent's dedup context: top 100 active trends from the last
// 30 days. Sourced from DT_TREND_DASHBOARD because the post-2026-04-28
// agent-owned-ledgers refactor moved TOTAL_CLUSTER_SIZE,
// DISTINCT_SOURCE_COUNT, VELOCITY_DIRECTION, and HEAT_INDEX off
// FCT_TRENDS — they're now derived in the dashboard view.
//
// Same TCP pattern as q_fetch_signals to stay consistent and avoid
// any further proxy-timeout exposure.

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
         LIMIT 100`,
        [],
      );
      const out = Array.isArray(rows) ? rows : [];
      console.log(`Fetched ${out.length} neighbor trends`);
      $.export("$summary", `${out.length} neighbors`);
      return out;
    } finally {
      await destroy(conn);
    }
  },
});
