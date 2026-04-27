// Error Alerts — post_to_slack
//
// Posts a formatted alert to Slack via chat.postMessage using the legacy
// Slack auth (apn_3JhV9gb). Channel is configurable via the `channel` prop;
// can be a channel name (without #) or a channel ID. The bot must be in
// the channel — `/invite @<bot-name>` once if posting fails with not_in_channel.

export default defineComponent({
  props: {
    slack: { type: "app", app: "slack", optional: false },
    error: { type: "object" },
    channel: { type: "string", default: "ops-alerts" },
  },
  async run({ $ }) {
    const e = this.error || {};
    const token = this.slack?.$auth?.oauth_access_token;
    if (!token) throw new Error("slack auth missing oauth_access_token");

    const text =
      `:rotating_light: *${e.workflow_name}* failed\n` +
      `*Error:* \`${e.code}\` — ${e.msg}\n` +
      `*Cell:* \`${e.cell_id}\`  ·  *Time:* ${e.ts}\n` +
      (e.stack_head ? "```" + e.stack_head + "```" : "");

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `🚨 ${e.workflow_name}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Error*\n\`${e.code}\`` },
          { type: "mrkdwn", text: `*Cell*\n\`${e.cell_id}\`` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Message*\n${e.msg}` },
      },
    ];
    if (e.stack_head) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "```" + e.stack_head + "```" },
      });
    }
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${e.ts} · ${e.workflow_id}` },
      ],
    });

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: this.channel,
        text, // fallback for notifications
        blocks,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.log(`slack post failed: ${data.error || JSON.stringify(data)}`);
      $.export("$summary", `slack: ${data.error}`);
      return { ok: false, slack_error: data.error };
    }
    $.export("$summary", `posted to ${this.channel}`);
    return { ok: true, channel: data.channel, ts: data.ts };
  },
});
