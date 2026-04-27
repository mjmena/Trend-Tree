// Upsert signals via direct snowflake-sdk connection.
//
// Pipedream's snowflake-execute-sql-query proxy 413's at ~256KB. The
// connector protocol (binary over TCP) has no such limit. Calls the
// MERGE_EXTERNAL_SIGNALS stored proc — proc owns batching, URL column
// write-through, and target-table validation.
//
// Reads `signals` directly from steps.fetch_source.$return_value rather
// than threading through a prop, since prop-wiring serialization has
// its own size cap (~512KB) that bluesky's 240KB JSON tripped on.

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
    target_table: { type: "string", default: "STG_EXTERNAL_SIGNALS_TEST" },
  },
  async run({ steps, $ }) {
    const signals = steps.fetch_source?.$return_value?.signals || [];
    if (!signals.length) {
      console.log("No signals to upsert; skipping");
      return { signals: 0, batches: 0, skipped: true };
    }

    const auth = this.snowflake.$auth;
    const signalsJson = JSON.stringify(signals);
    console.log(
      `Upserting ${signals.length} signals (${signalsJson.length} bytes) → ${this.target_table}`,
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
        [signalsJson, this.target_table],
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      const result = row?.MERGE_EXTERNAL_SIGNALS ?? row ?? null;
      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      console.log("Upsert result:", parsed);
      $.export("$summary", `${signals.length} signals → ${this.target_table}`);
      return parsed || { signals: signals.length };
    } finally {
      await destroy(conn);
    }
  },
});
