// Distillation Subagent — q_fetch_signals
//
// Direct TCP connector replacing the HTTP proxy step. The proxy timed out
// on clusters with many URL-shaped signal IDs (large inline IN-list).
// PARSE_JSON binding sidesteps the proxy size limit entirely.

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
    signal_ids: { type: "any" },
  },
  async run({ steps, $ }) {
    // Read signal_ids from steps.$return_value (not a prop): at a 1600-signal
    // pool the id list (~256KB of URLs) exceeds Pipedream's prop cap.
    const ids = (Array.isArray(this.signal_ids) && this.signal_ids.length)
      ? this.signal_ids
      : (steps?.handle_request?.$return_value?.signal_ids || []);
    if (ids.length === 0) {
      console.log("q_fetch_signals: no signal_ids; returning []");
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
      const rows = await execute(
        conn,
        // The lead agent only skims (240-char snippets + title); deep reading
        // is the subagent's job (it re-fetches full SIGNAL_TEXT by id). So:
        //  - LEFT(SIGNAL_TEXT, 240): fetch only what the snippet shows, not 1500.
        //  - extract MD_DOMAIN / MD_URL as scalars instead of shipping the whole
        //    METADATA VARIANT (lead only ever uses domain + url).
        //  - drop AGENT_SESSION_ID (unused by the lead).
        // LIMIT 1600 matches the acquire pool; the lead reads this result via
        // steps.$return_value (not a prop), dodging the ~512KB prop cap. Trimmed
        // rows keep the payload to ~1.1MB at 1600.
        `SELECT SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP,
                SIGNAL_TITLE, LEFT(SIGNAL_TEXT, 240) AS SIGNAL_TEXT,
                METADATA:domain::string AS MD_DOMAIN,
                COALESCE(METADATA:url::string, METADATA:canonical_url::string,
                         METADATA:original_url::string, METADATA:uri::string,
                         METADATA:embedded_url::string) AS MD_URL
         FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
         WHERE SIGNAL_ID IN (SELECT VALUE::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))))
         ORDER BY SIGNAL_TIMESTAMP DESC NULLS LAST
         LIMIT 1600`,
        [JSON.stringify(ids)],
      );
      const out = Array.isArray(rows) ? rows : [];
      $.export("$summary", `${out.length} signals fetched`);
      return out;
    } finally {
      await destroy(conn);
    }
  },
});
