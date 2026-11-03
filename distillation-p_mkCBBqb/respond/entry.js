// Distillation Lead — respond
//
// Run-history summary only. The HTTP caller already received a 202 from
// respond_accepted (which runs before the suspend in dispatch_to_cluster_agent),
// and Pipedream allows one $.respond per execution — this step deliberately
// does NOT call $.respond. The returned body shows up in the run UI for
// debugging.

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_result: { type: "any" },
    commit_result: { type: "any" },
    claimed_signal_count: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const ar = this.agent_result || {};
    const commitOk = Array.isArray(this.commit_result) || (this.commit_result && !this.commit_result.error);

    // Promotion to FCT_TRENDS now happens in the separate promotion-p_xMC99jg
    // workflow on its own cron. Distillation no longer reports promoted/dup
    // counts because those decisions are made downstream.
    const body = {
      tool: "distillation_lead",
      chain_id: ar.chain_id,
      agent_session_id: ar.agent_session_id || evt.agent_session_id,
      iteration: ar.iteration || evt.iteration,
      signals_seen: ar.signals_seen || 0,
      louvain_seen: ar.louvain_seen || 0,
      candidates_count: ar.candidates_count || 0,
      candidates_persisted: !!commitOk,
      claimed_signal_count: Number(this.claimed_signal_count) || 0,
      cost_usd: ar.cost_usd || 0,
      tokens: ar.tokens || { input: 0, output: 0, total: 0 },
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      run_duration_ms: ar.run_duration_ms || 0,
      max_signal_ts_observed: ar.max_signal_ts || null,
      final_text: ar.final_text || "",
      error: ar.error || null,
    };

    return body;
  },
});
