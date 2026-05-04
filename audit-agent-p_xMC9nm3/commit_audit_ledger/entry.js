// Audit Agent — commit_audit_ledger
//
// INSERT one row per run into FCT_AUDIT_LEDGER. Skipped when dry_run=true.
//
// Direct snowflake-sdk TCP connector (mirroring distillation-subagent's
// q_fetch_signals pattern). Bypasses the HTTP proxy's 256KB body cap from
// the pipedream_sql_proxy_413 memory — even though our payload is small,
// using TCP is consistent with every other custom Snowflake step in the repo.

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
    event: { type: "any" },
    agent_output: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const agent = this.agent_output || {};
    const report = agent.report || {};
    const tel = agent.telemetry || {};

    if (ev.dry_run) {
      console.log(`audit commit: dry_run=true — skipping FCT_AUDIT_LEDGER INSERT`);
      $.export("$summary", "skipped (dry_run)");
      return { committed: false, reason: "dry_run", overall_status: report.overall_status };
    }

    const auth = this.snowflake.$auth;
    const conn = await connect({
      account: auth.account,
      username: auth.username,
      privateKey: auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_PRESENTATION",
      schema: "TREND_AGENT",
      role: "MARKETING_ENGINEER",
    });

    try {
      const reportJson = JSON.stringify(report);
      const alertsJson = JSON.stringify(report.alerts || []);

      const sql = `
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_AUDIT_LEDGER
          (CHAIN_ID, TRIGGER_KIND, OVERALL_STATUS, WORKFLOWS_AUDITED, ALERT_COUNT,
           REPORT, ALERTS, COST_24H_USD, AGENT_COST_USD, INPUT_TOKENS, OUTPUT_TOKENS, MODEL_USED)
        SELECT ?, ?, ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), ?, ?, ?, ?, ?
      `;
      const binds = [
        ev.chain_id || null,
        ev.trigger_kind || null,
        report.overall_status || null,
        Number(report.workflow_health?.audited_count ?? 0),
        Array.isArray(report.alerts) ? report.alerts.length : 0,
        reportJson,
        alertsJson,
        Number(report.cost_24h_usd ?? 0),
        Number(tel.cost_usd ?? 0),
        Number(tel.tokens?.input ?? 0),
        Number(tel.tokens?.output ?? 0),
        tel.model || null,
      ];

      const rows = await execute(conn, sql, binds);
      const inserted = Array.isArray(rows) ? rows[0]?.["number of rows inserted"] ?? 1 : 1;

      console.log(
        `audit commit: inserted ${inserted} row to FCT_AUDIT_LEDGER ` +
        `(chain=${ev.chain_id}, status=${report.overall_status}, alerts=${binds[4]})`
      );
      $.export("$summary", `committed ${report.overall_status} (${binds[4]} alerts)`);

      return {
        committed: true,
        rows_affected: inserted,
        chain_id: ev.chain_id,
        overall_status: report.overall_status,
      };
    } finally {
      await destroy(conn);
    }
  },
});
