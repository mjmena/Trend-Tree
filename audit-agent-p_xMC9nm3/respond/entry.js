// Audit Agent — respond
//
// Responds to HTTP-triggered runs with the full audit JSON. For cron-fired
// runs, this is a no-op summary (the trigger has no caller waiting on it).
//
// Placed BEFORE post_to_slack/send_slack in the step order so the HTTP
// caller gets a response regardless of how slack-gating resolves.

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_output: { type: "any" },
    commit_result: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const agent = this.agent_output || {};
    const commit = this.commit_result || {};
    const report = agent.report || {};

    const summary = {
      chain_id: ev.chain_id,
      trigger_kind: ev.trigger_kind,
      dry_run: !!ev.dry_run,
      overall_status: report.overall_status,
      alert_count: Array.isArray(report.alerts) ? report.alerts.length : 0,
      cost_24h_usd: report.cost_24h_usd,
      agent_cost_usd: agent.telemetry?.cost_usd,
      committed: commit.committed,
      report,
    };

    if (ev.trigger_kind === "http") {
      await $.respond({
        status: 200,
        body: summary,
        headers: { "Content-Type": "application/json" },
      });
    }

    $.export(
      "$summary",
      `${report.overall_status || "?"} · ${summary.alert_count} alerts · $${(summary.cost_24h_usd ?? 0).toFixed(2)} today`
    );

    return summary;
  },
});
