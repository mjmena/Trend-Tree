// write_run_cost — per-run cost/token telemetry -> STG_AGENT_RUN_COSTS (CRMA-725)
//
// Last step of every instrumented LLM workflow. Reads `_llm_calls` from the
// step return values named in `usage_steps`, prices them via the sibling
// run_cost.mjs (byte-identical copy of agents/lib/run_cost.mjs), and inserts
// one row per model used in this run.
//
// BEST-EFFORT: this step never throws. A telemetry failure is logged and
// returned, and the run still succeeds — the work it measures has already
// happened and responded. The INSERT is not retried (see RUN_COST_INSERT_SQL).
//
// This file is byte-identical across every <workflow>/write_run_cost/ dir
// (agents/lib/run_cost.test.mjs enforces it); per-workflow differences live
// only in the props wired from workflow.yaml.

import snowflake from "snowflake-sdk";
import { randomUUID } from "node:crypto";
import { buildRunCostRows, collectCalls, deriveStatus, RUN_COST_INSERT_SQL } from "./run_cost.mjs";

const CONNECT_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)) });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

export default defineComponent({
  name: "Write run cost",
  description: "Best-effort STG_AGENT_RUN_COSTS row(s) for this run (CRMA-725)",
  props: {
    snowflake: { type: "app", app: "snowflake" },
    workflow_name: { type: "string", label: "WORKFLOW_NAME to record" },
    usage_steps: {
      type: "string",
      label: "Comma-separated step names whose $return_value carries _llm_calls",
    },
    chain_id: { type: "string", optional: true },
    agent_session_id: { type: "string", optional: true },
  },
  async run({ steps, $ }) {
    let conn;
    try {
      const names = String(this.usage_steps || "").split(",").map((s) => s.trim()).filter(Boolean);
      const results = names.map((name) => steps?.[name]?.$return_value);
      const calls = collectCalls(results);
      const { status, error_message } = deriveStatus(results);

      const ctx = steps?.trigger?.context || {};
      const eventId = ctx.id || randomUUID();
      const ended_at = new Date().toISOString();
      const started_at = ctx.ts && Number.isFinite(Date.parse(ctx.ts)) ? new Date(ctx.ts).toISOString() : ended_at;

      const rows = buildRunCostRows({
        workflow_name: this.workflow_name,
        run_id: `pd-${eventId}`,
        agent_session_id: this.agent_session_id || eventId,
        chain_id: this.chain_id || eventId,
        started_at,
        ended_at,
        calls,
        status,
        error_message,
      });

      const auth = this.snowflake.$auth;
      conn = await withTimeout(connect({
        account: auth.account,
        username: auth.username,
        privateKey: auth.private_key,
        authenticator: "SNOWFLAKE_JWT",
        database: "MCC_RAW",
        schema: "MARKETING_DEV",
        role: "MARKETING_ENGINEER",
      }), CONNECT_TIMEOUT_MS, "Snowflake connect");
      await execute(conn, RUN_COST_INSERT_SQL, [JSON.stringify(rows)]);

      const total = rows.reduce((acc, r) => (r.cost_usd == null ? acc : acc + r.cost_usd), 0);
      const summary = `${rows.length} cost row(s), $${total.toFixed(4)} (${rows.map((r) => r.model || "no-llm").join(", ")})`;
      console.log(`write_run_cost: ${summary} status=${status}`);
      $.export("$summary", summary);
      return { written: rows.length, cost_usd: total, rows };
    } catch (e) {
      // Swallowed on purpose: cost telemetry must never fail the run.
      console.log(`write_run_cost: FAILED (best-effort, run unaffected): ${e.message}`);
      $.export("$summary", `cost write failed: ${e.message}`.slice(0, 200));
      return { written: 0, error: e.message };
    } finally {
      if (conn) await destroy(conn).catch(() => {});
    }
  },
});
