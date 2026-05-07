// Distillation Revisit Lead — respond_accepted
//
// Sends a synchronous 202 ack to the HTTP caller (cron firings have no
// client; $.respond is harmless there) before the per-batch run suspends
// in dispatch_to_cluster_agent. Cluster agent runs take 6-10 min and
// Pipedream's HTTP-trigger sync-response cap is ~5.5 min, so we must
// respond before suspend or the caller gets a 504.
//
// Pipedream allows one $.respond per execution. No subsequent step in
// this workflow calls $.respond — the only consumer of intermediate
// results is finalize_or_continue's self-POST, which is fire-and-forget.

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
        mode: evt.mode,
        chain_id: evt.chain_id,
        agent_session_id: evt.agent_session_id,
      },
    });

    return { acknowledged: true };
  },
});
