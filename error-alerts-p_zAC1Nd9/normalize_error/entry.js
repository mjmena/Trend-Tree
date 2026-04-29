// Error Alerts — normalize_error
//
// Three delivery shapes to handle:
//   1. Built-in $errors trigger: steps.trigger.event = { context, event: { error, original_context, original_event } }
//   2. HTTP POST (manual/smoke test): steps.trigger.event.body = { error, original_context }
//   3. Fallback: treat trigger.event itself as the payload
//
// allowed_project_ids / allowed_project_names are parallel arrays — index N in
// one corresponds to index N in the other. The Pipedream REST API does not
// expose a project-list endpoint, so names must be configured here.
// Leave both empty to forward all projects (single-project deployments).

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
    allowed_project_ids: {
      type: "string[]",
      label: "Allowed Project IDs",
      description: "Only forward errors from these projects. Leave empty to allow all.",
      optional: true,
    },
    allowed_project_names: {
      type: "string[]",
      label: "Project Names",
      description: "Human-readable names, one per Allowed Project ID (same order).",
      optional: true,
    },
  },
  async run({ $ }) {
    const ev = this.trigger_event || {};
    let payload;
    if (ev.event && (ev.event.error || ev.event.original_context)) {
      payload = ev.event;
    } else if (ev.body && (ev.body.error || ev.body.original_context)) {
      payload = ev.body;
    } else {
      payload = ev;
    }

    const error_project_id = payload.original_context?.project_id;
    const allowed = this.allowed_project_ids;

    if (allowed?.length && error_project_id && !allowed.includes(error_project_id)) {
      const wf_name = payload.original_context?.workflow_name || payload.original_context?.workflow_id || "unknown workflow";
      return $.flow.exit(`Skipping "${wf_name}" (${error_project_id}) — not in allowed list`);
    }

    // Resolve human-readable project name from the parallel names array.
    const project_idx = allowed?.indexOf(error_project_id) ?? -1;
    const project_name = (project_idx >= 0 && this.allowed_project_names?.[project_idx])
      || error_project_id
      || "(unknown project)";

    const ctx = payload.original_context || {};
    const err = payload.error || {};

    const workflow_id = ctx.workflow_id || "(unknown)";
    const workflow_name = ctx.workflow_name || workflow_id;
    const cell_id = err.cellId || "(no cell)";
    const code = err.code || "Error";
    const msg = (err.msg || err.message || "(no message)").slice(0, 600);
    const ts = err.ts || ctx.ts || new Date().toISOString();

    // Strip Pipedream runtime internals — show only frames from user/action code.
    const INTERNAL = ["node_modules/@lambda-v2", "launch_worker.js", "node:internal/"];
    const stack_head = (err.stack || "")
      .split("\n")
      .filter(l => !INTERNAL.some(p => l.includes(p)))
      .slice(0, 5)
      .join("\n")
      .slice(0, 800);

    console.log(`error-alerts: [${project_name}] ${workflow_name} cell=${cell_id} code=${code}`);

    const errorPrefix = code && code !== "Error" ? `\`${code}\` — ` : "";
    const stackBlock = stack_head ? "\n```" + stack_head + "```" : "";
    const slack_text =
      `🚨 *${workflow_name}* failed\n` +
      `*Project:* ${project_name}  ·  *Workflow:* \`${workflow_id}\`\n` +
      `*Error:* ${errorPrefix}${msg}\n` +
      `*Cell:* \`${cell_id}\`  ·  *Time:* ${ts}` +
      stackBlock;

    return {
      workflow_id,
      workflow_name,
      project_name,
      project_id: error_project_id,
      cell_id,
      code,
      msg,
      ts,
      stack_head,
      slack_text,
    };
  },
});
