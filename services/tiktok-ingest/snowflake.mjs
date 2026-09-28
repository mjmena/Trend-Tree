// TikTok ingester — Snowflake access (CRMA-1337).
//
// A copy of services/catalog-sync/snowflake.mjs, not an import of it:
// `snowflake-sdk` resolves from the importing file's own node_modules, and
// services/lib/ has none, so a shared driver module cannot live there. A run
// holds one connection for its whole length and does not retry a statement —
// the Cloud Run job's own retry re-runs the whole ingest, and the MERGE plus
// the video-ID dedup make that safe.

import snowflake from "snowflake-sdk";

// The driver logs every statement at INFO by default, which would put the
// MERGE call's whole JSON payload into Cloud Logging.
snowflake.configure({ logLevel: "ERROR" });

export function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

export function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

export function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}
