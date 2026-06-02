// Distillation — q_cluster_signals (direct TCP connector)
//
// Calls PROC_CLUSTER_SIGNAL_SUBSET (Louvain) via the snowflake-sdk TCP
// connector. Bypasses the HTTP proxy's size/timeout limits.
//
// RESOLUTION raised 0.8 → 3.0 (2026-06-01): at 0.8 the proc's permissive
// 0.3-cosine edges collapsed the pool into a few incoherent megaclusters
// (e.g. Dirty Soda + Beef Liver + ear seeding in one community), so the
// agent sub-selected thin single-source slices that failed the promotion
// 2-source-family gate. 3.0 (tuned empirically on the 1600-signal pool —
// bigger pools need higher resolution) yields ~17 multi-family clusters of
// 20-30 coherent signals; ephemeral gtrss news self-segregates into a few
// big single-family blobs that simply don't promote.
//
// NB: the proc's EDGE_THRESHOLD stays 0.3 — raising it (tested 0.45) cuts
// the *cross-source* edges first (an LLM-authored sentence vs a news
// headline about the same topic only score ~0.3-0.4 cosine), which
// destroys exactly the multi-family corroboration we want. Resolution, not
// threshold, is the lever.
//
// Returns a flat array of { signal_id, cluster_id, signal_title,
// source_name, similarity_to_seed } objects.

import snowflake from "snowflake-sdk";

const RESOLUTION = 3.0;

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
      console.log(`Louvain clustering ${ids.length} signals (resolution=${RESOLUTION})`);
      const rows = await execute(
        conn,
        `CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(PARSE_JSON(?)::ARRAY, ${RESOLUTION}::FLOAT)`,
        [this.signal_ids_json],
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      const raw = row ? Object.values(row)[0] : null;
      const result = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      const clusters = Array.isArray(result) ? result : [];
      const k = new Set(clusters.map((c) => c.cluster_id)).size;
      console.log(`Louvain: ${clusters.length} signals → ${k} communities`);
      $.export("$summary", `${clusters.length} signals → ${k} communities`);
      return clusters;
    } finally {
      await destroy(conn);
    }
  },
});
