// Error Alerts — normalize_error
//
// $errors subscription events have a fixed shape (per Pipedream):
//   { original_event, original_context: {workflow_id, workflow_name, ts, ...},
//     error: {code, msg, cellId, ts, stack} }
//
// HTTP-triggered manual invocations (for testing) put the same shape under
// trigger.event.body. Handle both.

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const ev = this.trigger_event || {};
    // Subscriptions deliver the event directly; HTTP posts wrap it in body.
    const payload = ev.body && (ev.body.error || ev.body.original_context) ? ev.body : ev;

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

    return {
      workflow_id,
      workflow_name,
      cell_id,
      code,
      msg,
      ts,
      stack_head,
    };
  },
});
