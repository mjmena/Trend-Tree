// workflow-error-receiver — subscription sink for $errors events.
//
// Deploy one instance of this source, then subscribe it to each workflow's
// $errors emitter via POST /v1/subscriptions. Attach the resulting dc_xxx
// as the trigger on error-alerts-p_zAC1Nd9.

export default {
  name: "Workflow Error Receiver",
  key: "workflow_error_receiver",
  version: "0.0.1",
  description: "Subscription sink that receives $errors events from other workflows. Subscribe via POST /v1/subscriptions, then attach as a trigger.",
  type: "source",
  props: {},
  async run(event) {
    // $errors payload shape:
    //   { original_event, original_context: { workflow_id, workflow_name, id, ts, ... },
    //     error: { code, msg, cellId, ts, stack } }
    const ctx = event.original_context || {};
    const err = event.error || {};
    const id = ctx.id || `${ctx.workflow_id || "unknown"}-${Date.now()}`;
    const summary = `Error in ${ctx.workflow_name || ctx.workflow_id || "unknown"}: ${(err.msg || err.message || "(no message)").slice(0, 120)}`;

    this.$emit(event, { id, summary, ts: Date.now() });
  },
};
