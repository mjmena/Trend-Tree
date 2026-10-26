// Snowflake access for the replay harness, over the `snow` CLI.
//
// The harness runs offline against history, so every query here is a READ.
// The one exception is the descriptor-neighbor axis (CRMA-728), which writes
// to a scratch table under SCRATCH_SCHEMA — never to a production ledger.
//
// Why the CLI and not a driver: this repo has no package.json and no
// node_modules, so the harness must run on a bare `node` with zero installs.
// `snow` is already configured with the `claude` connection.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONNECTION = process.env.SNOW_CONNECTION || "claude";

/** Where the harness is allowed to write. Never a TREND_AGENT ledger. */
export const SCRATCH_SCHEMA = "MCC_RAW.MARKETING_DEV";

/**
 * Run a query and return rows as objects with UPPERCASE keys, matching what
 * the deployed `snowflake-execute-sql-query` steps hand to the code steps.
 *
 * @param {string} sql        One statement. Do not pass a whole .sql file —
 *                            see the "never run full DDL files live" rule.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Array<Object>}
 */
export function query(sql, { timeoutMs = 300_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "replay-sql-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  let stdout;
  try {
    stdout = execFileSync(
      "snow",
      [
        "sql",
        "-c",
        CONNECTION,
        "--format",
        "json",
        // The CLI templates the SQL before sending it, and several ids in
        // this pipeline are URLs — STG_EXTERNAL_SIGNALS.SIGNAL_ID is the URL
        // itself for some sources. A query string full of `&`/`?` makes the
        // renderer fail with a bare "SQL rendering error". Nothing here wants
        // client-side templating, so turn it off.
        "--enable-templating",
        "NONE",
        "-f",
        file,
      ],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message).slice(0, 1200);
    if (/authenticat|token|expired|browser/i.test(detail)) {
      throw new Error(
        `Snowflake auth failed — the SSO token has probably expired.\n` +
          `Run this yourself to re-authenticate, then retry:\n` +
          `  snow sql -c ${CONNECTION} -q "SELECT 1"\n\n${detail}`,
      );
    }
    throw new Error(`snow sql failed:\n${detail}\n\n--- SQL ---\n${sql.slice(0, 1500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`snow sql returned non-JSON output:\n${trimmed.slice(0, 800)}`);
  }
  // A multi-statement file yields an array of result sets; we send one.
  if (Array.isArray(parsed) && Array.isArray(parsed[0])) return parsed[0];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Run a statement and discard the result set. */
export function execute(sql, opts) {
  query(sql, opts);
}

/**
 * Escape a value for inline SQL. The deployed workflows interpolate
 * `{{steps.*}}` straight into their SQL, so the harness reproduces that
 * shape — but every value it substitutes comes from a ledger id it just
 * read, and this keeps a stray quote from breaking the statement.
 */
export function sqlStr(v) {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Parse a VARIANT column that the CLI may hand back as a JSON string. */
export function variant(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
