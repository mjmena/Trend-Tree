// Discovery — write_discovered_signals
//
// Calls MERGE_EXTERNAL_SIGNALS via direct snowflake-sdk TCP connection.
// Same pattern as ingestion/*/upsert_signals/entry.js — bypasses the
// Pipedream SQL proxy, which 413's at ~256KB request bodies (the new
// canonicalize_and_validate metadata pushed discovery into that range).

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
      complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    target_table: { type: "string", default: "STG_EXTERNAL_SIGNALS" },
  },
  async run({ steps, $ }) {
    const signals_json = steps.canonicalize_and_validate?.$return_value?.signals_json || "[]";
    const signal_count = steps.canonicalize_and_validate?.$return_value?.signal_count || 0;
    if (signal_count === 0 || signals_json === "[]") {
      console.log("No signals to write; skipping");
      return { signals: 0, batches: 0, skipped: true };
    }

    const auth = this.snowflake.$auth;
    console.log(
      `Writing ${signal_count} discovery signals (${signals_json.length} bytes) → ${this.target_table}`,
    );

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
        "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(?, '', 500, ?)",
        [signals_json, this.target_table],
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      const result = row?.MERGE_EXTERNAL_SIGNALS ?? row ?? null;
      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      console.log("Write result:", parsed);
      $.export("$summary", `${signal_count} signals → ${this.target_table}`);
      return parsed || { signals: signal_count };
    } finally {
      await destroy(conn);
    }
  },
});
