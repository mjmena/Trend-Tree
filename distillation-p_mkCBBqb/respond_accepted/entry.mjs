// Distillation Lead — respond_accepted
//
// Sends a synchronous 202 ack to the HTTP caller before the workflow
// suspends in dispatch_to_cluster_agent. The cluster-agent run takes
// 6-10 min and Pipedream's HTTP-trigger sync-response cap is ~5.5 min,
// so we must respond before suspend or the caller gets a 504. Cron
// firings have no client to ack to but $.respond is harmless there.
//
// Pipedream allows one $.respond per execution. The terminal `respond`
// step deliberately drops its $.respond (kept here in commentary as a
// reminder).

export default defineComponent({
  props: {
    event: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event || {};

    await $.respond({
      status: 202,
      headers: { "Content-Type": "application/json" },
      body: {
        accepted: true,
        chain_id: evt.chain_id,
        agent_session_id: evt.agent_session_id,
        cursor_name: evt.cursor_name,
        mode: "async_distillation_run",
      },
    });

    return { acknowledged: true };
  },
});
