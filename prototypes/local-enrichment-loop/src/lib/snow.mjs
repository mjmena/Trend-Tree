// PROTOTYPE (CRMA-438) — Snowflake access via the `snow` CLI (reuses the
// operator's existing `-c claude` connection; no credentials handled here).
// Read-only by construction: every query this prototype issues is a SELECT.

import { execFile } from "node:child_process";

const CONNECTION = process.env.SNOW_CONNECTION || "claude";

export function runSql(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "snow",
      ["sql", "-c", CONNECTION, "-q", sql, "--format", "json"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`snow sql failed: ${err.message}\n${String(stderr).slice(0, 500)}`));
        }
        try {
          resolve(normalize(JSON.parse(stdout)));
        } catch (e) {
          reject(new Error(`snow sql returned non-JSON output: ${String(stdout).slice(0, 300)}`));
        }
      },
    );
  });
}

// `snow sql --format json` emits an array of row objects for a single
// statement, and an array of per-statement arrays for multi-statement
// input. This prototype always sends one statement — unwrap defensively.
function normalize(parsed) {
  if (!Array.isArray(parsed)) return [parsed];
  if (parsed.length > 0 && Array.isArray(parsed[0])) return parsed[0];
  return parsed;
}

export function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}
