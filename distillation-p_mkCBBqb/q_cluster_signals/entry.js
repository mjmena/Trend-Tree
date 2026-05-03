// Distillation — q_cluster_signals (direct TCP connector)
//
// Calls PROC_CLUSTER_SIGNAL_SUBSET via snowflake-sdk over a direct TCP
// connection instead of the Pipedream HTTP SQL proxy. The proc runs a
// k-means++ seed loop with k-1 cross-join queries; total wall clock for
// large inputs (183 signals, k=10) exceeds the proxy's keep-alive window,
// causing "Error contacting database" on every cron run. The SDK streams
// binary over TCP with no body-size or timeout limit at the HTTP layer.
//
// Returns a flat array of { signal_id, cluster_id, signal_title,
// source_name, similarity_to_seed } objects — the same shape that
// run_lead_agent's parseClusterRows() already handles.

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
    signal_ids_json: { type: "string" },
    k: { type: "integer" },
  },
  async run({ $ }) {
    const k = Number(this.k) || 0;
    if (k === 0) {
      console.log("k=0, skipping cluster proc");
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
      console.log(`Clustering ${this.signal_ids_json.length} chars JSON, k=${k}`);
      const rows = await execute(
        conn,
        "CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(PARSE_JSON(?)::ARRAY, ?)",
        [this.signal_ids_json, k],
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      const raw = row ? Object.values(row)[0] : null;
      const result = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      const clusters = Array.isArray(result) ? result : [];
      console.log(`Cluster assignments: ${clusters.length} signals across ${k} clusters`);
      $.export("$summary", `${clusters.length} signals → ${k} clusters`);
      return clusters;
    } finally {
      await destroy(conn);
    }
  },
});
