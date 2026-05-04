// Distillation Revisit — q_cluster_signals (direct TCP connector)
//
// Calls PROC_CLUSTER_SIGNAL_SUBSET (Louvain, resolution=0.8) across the
// full 48h claimed-but-unpromotable signal pool. Runs across the full pool
// so signals from different days can cluster together — that's the whole
// point of the revisit pass. Uses TCP to bypass proxy size/timeout limits.

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
  },
  async run({ $ }) {
    const ids = JSON.parse(this.signal_ids_json || "[]");
    if (ids.length === 0) {
      console.log("q_cluster_signals: no signal_ids; returning []");
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
      console.log(`Louvain clustering ${ids.length} revisit signals (resolution=0.8)`);
      const rows = await execute(
        conn,
        "CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(PARSE_JSON(?)::ARRAY, 0.8::FLOAT)",
        [this.signal_ids_json],
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      const raw = row ? Object.values(row)[0] : null;
      const result = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      const clusters = Array.isArray(result) ? result : [];
      const k = new Set(clusters.map((c) => c.cluster_id)).size;
      console.log(`Louvain revisit: ${clusters.length} signals → ${k} communities`);
      $.export("$summary", `${clusters.length} signals → ${k} communities`);
      return clusters;
    } finally {
      await destroy(conn);
    }
  },
});
