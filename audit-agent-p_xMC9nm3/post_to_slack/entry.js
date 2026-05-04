// Audit Agent — post_to_slack
//
// Gates the Slack DM. Sends only when overall_status != 'GREEN' OR when
// the run was HTTP-triggered with force_slack=true. Returns the prepared
// slack_text for the downstream send_slack registry-action step to consume.
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

    if (status === "GREEN" && !force) {
      return $.flow.exit(`audit ${status}, no force_slack — skipping Slack DM`);
    }

    const emoji = STATUS_EMOJI[status] || "⚪";
    const headerLine = force && status === "GREEN"
      ? `${emoji} *Audit GREEN* (forced)`
      : `${emoji} *Audit ${status}*`;
    const md = report.slack_summary_md || "(agent emitted no slack_summary_md)";

    // Belt-and-suspenders length cap (~1500 chars per the prompt contract).
    const capped = md.length > 2000 ? md.slice(0, 2000) + "…" : md;

    const slack_text = `${headerLine}\n${capped}\n_chain=${ev.chain_id || "?"}_`;

    return { slack_text, status, force };
  },
});
