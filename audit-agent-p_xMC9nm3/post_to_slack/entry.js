// Audit Agent — post_to_slack
//
// Gates the Slack DM. run_audit_agent makes the send decision
// (saturation.mjs, CRMA-1031) and records it in report.saturation.slack:
// send when the status or the set of RED areas changed since the last
// scheduled run, on the weekly reminder of a RED streak, or when the run was
// HTTP-triggered with force_slack=true. This step carries the decision out
// and returns the prepared slack_text for the downstream send_slack
// registry-action step to consume.
//
// Calls $.flow.exit("...") when no post is needed. send_slack is the next
// step after this and won't run when we exit early.

const STATUS_EMOJI = {
  GREEN: "🟢",
  YELLOW: "🟡",
  RED: "🔴",
};

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_output: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const agent = this.agent_output || {};
    const report = agent.report || {};

    const status = report.overall_status || "UNKNOWN";
    const force = !!ev.force_slack;

    // The decision already accounts for force_slack. A report with no
    // decision gets the rule from before CRMA-1031: send unless GREEN, or
    // when forced.
    const gate = report.saturation?.slack || {
      send: force || status !== "GREEN",
      reason: force ? "force_slack=true" : `no send decision in the report; status ${status}`,
    };

    if (!gate.send) {
      return $.flow.exit(`audit ${status} — no Slack DM: ${gate.reason}`);
    }

    const emoji = STATUS_EMOJI[status] || "⚪";
    const headerLine = force && status === "GREEN"
      ? `${emoji} *Audit GREEN* (forced)`
      : `${emoji} *Audit ${status}*`;
    const md = report.slack_summary_md || "(agent emitted no slack_summary_md)";

    // Belt-and-suspenders length cap (~1500 chars per the prompt contract).
    const capped = md.length > 2000 ? md.slice(0, 2000) + "…" : md;

    const slack_text = `${headerLine}\n${capped}\n_chain=${ev.chain_id || "?"} · sent: ${gate.reason}_`;

    return { slack_text, status, force };
  },
});
