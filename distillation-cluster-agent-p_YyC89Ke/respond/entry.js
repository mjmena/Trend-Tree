// Distillation Cluster Agent — respond
//
// Returns the run result to the caller (dispatcher) via $.respond().
// The caller is either the main dispatcher or the revisit dispatcher;
// both expect the same shape: proposed_candidates, cost_usd, run_duration_ms.

export default defineComponent({
  props: {
    request: { type: "any" },
    agent_result: { type: "any" },
  },
  async run({ $ }) {
    const req = this.request || {};
    const ar = this.agent_result || {};

    const body = {
      proposed_candidates: ar.candidates || [],
      candidates_count: ar.candidates_count || 0,
      cost_usd: ar.cost_usd || 0,
      run_duration_ms: ar.run_duration_ms || 0,
      signals_seen: ar.signals_seen || 0,
      max_signal_ts: ar.max_signal_ts || null,
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      agent_session_id: req.agent_session_id,
      chain_id: req.chain_id,
      error: ar.error || null,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
