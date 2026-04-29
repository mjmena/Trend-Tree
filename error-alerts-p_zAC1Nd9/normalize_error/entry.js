// Error Alerts — normalize_error
//
// Three delivery shapes to handle:
//   1. Built-in $errors trigger: steps.trigger.event = { context, event: { error, original_context, original_event } }
//   2. HTTP POST (manual/smoke test): steps.trigger.event.body = { error, original_context }
//   3. Fallback: treat trigger.event itself as the payload
//
// Only forward errors originating from the Trend Tree project (proj_x9sLmqO).

const TREND_TREE_PROJECT_ID = "proj_x9sLmqO";

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.trigger_event || {};
    let payload;
    if (ev.event && (ev.event.error || ev.event.original_context)) {
      // Built-in $errors trigger
      payload = ev.event;
    } else if (ev.body && (ev.body.error || ev.body.original_context)) {
      // HTTP POST
      payload = ev.body;
    } else {
      payload = ev;
    }

    const project_id = payload.original_context?.project_id;
    if (project_id && project_id !== TREND_TREE_PROJECT_ID) {
      return $.flow.exit(`Skipping error from project ${project_id}`);
    }

    const ctx = payload.original_context || {};
    const err = payload.error || {};

    const workflow_id = ctx.workflow_id || "(unknown)";
    const workflow_name = ctx.workflow_name || workflow_id;
    const cell_id = err.cellId || "(no cell)";
    const code = err.code || "Error";
    const msg = (err.msg || err.message || "(no message)").slice(0, 600);
    const ts = err.ts || ctx.ts || new Date().toISOString();
    const stack_head = (err.stack || "").split("\n").slice(0, 4).join("\n").slice(0, 800);

    console.log(`error-alerts: ${workflow_name} cell=${cell_id} code=${code}`);

    // Pre-format the Slack message text. The registry Slack action
    // (slack_v2-send-message-to-channel) only takes a single `text` field;
    // markdown formatting works in Slack, but Block Kit needs the legacy
    // chat.postMessage path. This is plain markdown.
    const stackBlock = stack_head ? "\n```" + stack_head + "```" : "";
    const slack_text =
      `🚨 *${workflow_name}* failed\n` +
      `*Error:* \`${code}\` — ${msg}\n` +
      `*Cell:* \`${cell_id}\`  ·  *Time:* ${ts}` +
      stackBlock;

    return {
      workflow_id,
      workflow_name,
      cell_id,
      code,
      msg,
      ts,
      stack_head,
      slack_text,
    };
  },
});
