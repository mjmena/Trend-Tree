// Ecomm Agent — Snowflake access (CRMA-776, epic CRMA-772).
//
// Direct snowflake-sdk with bounded retry, ported verbatim from the removed
// Pipedream steps (ecomm-agent/fetch_context/entry.mjs and
// ecomm-agent/run_sourcing/entry.mjs, commit 61d0318) — which in turn followed
// prediction-agent-p_QPCkLP1/commit_to_ledger/entry.mjs. The two step copies
// were byte-identical; on Cloud Run they collapse into this one module because
// the image bundles real imports.
//
// Known follow-up (carried over from CRMA-776's code review, deliberately not
// fixed here): every query opens and destroys its own connection. That is a
// latency/efficiency cost — roughly five connects per /source call — not a
// correctness bug, and keeping the verified connect-per-query shape is what
// makes this a port rather than a rewrite. A pooled or request-scoped
// connection is the obvious next optimization.

import snowflake from "snowflake-sdk";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const TRANSIENT =
  /network|could not reach|unable to connect|connection|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|disconnect|timed out|timeout/i;

// The driver logs every statement at INFO to stdout by default, which on Cloud
// Run means the full SQL text (and bind values) lands in Cloud Logging.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// General-purpose retry: safe for reads and for PROC_SOURCING_APPLY 'complete'
// (which has its own double-completion guard, so a retried complete() after a
// lost response is a harmless no-op, not a duplicate write). NOT used for
// 'open' — see runWithConnectRetryOnly below.
export async function runWithRetry(connOpts, sqlText, binds) {
  for (let attempt = 1; ; attempt++) {
    let conn;
    let connected = false;
    try {
      conn = await connect(connOpts);
      connected = true;
      const rows = await execute(conn, sqlText, binds);
      await destroy(conn);
      return rows;
    } catch (err) {
      if (conn) await destroy(conn); // destroy the broken connection BEFORE backing off, not after
      const transient = !connected || TRANSIENT.test(String(err.message || err));
      if (!transient || attempt >= MAX_ATTEMPTS) {
        err.message = `Snowflake ${connected ? "execute" : "connect"} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`;
        throw err;
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? 3000;
      console.log(`Transient Snowflake error on attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}; retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// PROC_SOURCING_APPLY('open', ...) has NO idempotency key — SOURCING_RUN_ID is
// generated server-side (uuid4()) and the proc deliberately does not dedupe
// concurrent 'running' headers for the same (TREND_ID, TIER) (see
// sql/proc_sourcing_apply.sql's own header comment — that's the future poll
// cron's job). Retrying an 'open' call whose execute() already reached the
// server (response merely lost in transit) would silently insert a SECOND
// 'running' header. So this only retries a CONNECT-phase failure (nothing was
// sent yet, safe to retry) — once execute() has been attempted, any failure
// propagates immediately, no retry.
export async function runWithConnectRetryOnly(connOpts, sqlText, binds) {
  for (let attempt = 1; ; attempt++) {
    let conn;
    let connected = false;
    try {
      conn = await connect(connOpts);
      connected = true;
      const rows = await execute(conn, sqlText, binds);
      await destroy(conn);
      return rows;
    } catch (err) {
      if (conn) await destroy(conn);
      if (connected || attempt >= MAX_ATTEMPTS) {
        err.message = `Snowflake ${connected ? "execute" : "connect"} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`;
        throw err;
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? 3000;
      console.log(`Transient Snowflake CONNECT error on attempt ${attempt}/${MAX_ATTEMPTS} (connect-phase only): ${err.message}; retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// A proc's VARIANT receipt arrives as the single column of the single row,
// sometimes already parsed, sometimes as a JSON string.
export function parseReceipt(rows) {
  const first = rows?.[0];
  if (!first) return null;
  const raw = first[Object.keys(first)[0]];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}
