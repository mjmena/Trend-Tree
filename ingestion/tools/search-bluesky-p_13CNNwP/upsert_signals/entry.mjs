// Search Bluesky (agent tool) — upsert_signals
//
// Persists fetched posts via the MERGE_EXTERNAL_SIGNALS stored proc.
//
// Direct snowflake-sdk connection with bounded retry (issue #46): the
// snowflake-execute-sql-query registry action's proxy (sqlProxyClient)
// intermittently failed with "Error contacting database", which failed
// the synchronous agent tool call. Connect-phase failures always retry;
// execute-phase failures retry only on connection-level signatures (the
// MERGE proc is idempotent, so a retry is safe either way).
//
// Reads `signals_json` directly from steps.fetch_search.$return_value
// rather than threading through a prop — prop-wiring serialization has
// its own size cap (~512KB) that bluesky-sized JSON can trip. The JSON
// is passed as a real bind param, replacing the old $$...$$ inlining.

import snowflake from "snowflake-sdk";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const TRANSIENT =
  /network|could not reach|unable to connect|connection|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|disconnect|timed out|timeout/i;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWithRetry(connOpts, sqlText, binds) {
  for (let attempt = 1; ; attempt++) {
    let conn;
    let connected = false;
    try {
      conn = await connect(connOpts);
      connected = true;
      return await execute(conn, sqlText, binds);
    } catch (err) {
      const transient = !connected || TRANSIENT.test(String(err.message || err));
      if (!transient || attempt >= MAX_ATTEMPTS) {
        err.message = `Snowflake ${connected ? "execute" : "connect"} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`;
        throw err;
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? 3000;
      console.log(
        `Transient Snowflake error on attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}; retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    } finally {
      if (conn) await destroy(conn);
    }
  }
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    agent_session_id: { type: "string", optional: true, default: "" },
  },
  async run({ steps, $ }) {
    const signalsJson = steps.fetch_search?.$return_value?.signals_json || "[]";
    if (signalsJson === "[]") {
      console.log("No signals to upsert; skipping");
      $.export("$summary", "0 signals (skipped)");
      return { signals: 0, skipped: true };
    }

    const auth = this.snowflake.$auth;
    console.log(`Upserting ${signalsJson.length} bytes of signals JSON`);

    const rows = await runWithRetry(
      {
        account: auth.account,
        username: auth.username,
        privateKey: auth.private_key,
        authenticator: "SNOWFLAKE_JWT",
        database: "MCC_RAW",
        schema: "MARKETING_DEV",
        role: "MARKETING_ENGINEER",
      },
      "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(?, ?, 500)",
      [signalsJson, this.agent_session_id || ""],
    );

    const row = Array.isArray(rows) ? rows[0] : rows;
    const result = row?.MERGE_EXTERNAL_SIGNALS ?? row ?? null;
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    console.log("Upsert result:", parsed);
    $.export("$summary", "signals merged via MERGE_EXTERNAL_SIGNALS");
    return parsed || rows;
  },
});
