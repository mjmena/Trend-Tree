// A copy of services/catalog-sync/snowflake.mjs: `snowflake-sdk` resolves from
// the importing file's own node_modules, and services/lib/ has none.

import snowflake from "snowflake-sdk";

// The driver logs every statement at INFO by default; the set queries are
// long, and their full text would flood the log.
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
