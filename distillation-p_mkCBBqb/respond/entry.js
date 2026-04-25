// Distillation Lead — respond
//
// Returns a run summary via $.respond(). Useful for manual debug runs
// (POST to the HTTP endpoint and inspect the response). Cron firings
// also produce this body but Pipedream doesn't surface it anywhere
// other than the run history.
//
// Requires the trigger's "Return a custom response" toggle to be ON
// (custom_response: true). See CLAUDE.md gotcha #6.

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_result: { type: "any" },
    commit_result: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const ar = this.agent_result || {};
    const commitOk = Array.isArray(this.commit_result) || (this.commit_result && !this.commit_result.error);

    const body = {
      tool: "distillation_lead",
      chain_id: ar.chain_id,
      agent_session_id: ar.agent_session_id || evt.agent_session_id,
      iteration: ar.iteration || evt.iteration,
      signals_seen: ar.signals_seen || 0,
      louvain_seen: ar.louvain_seen || 0,
      candidates_count: ar.candidates_count || 0,
      candidates_persisted: !!commitOk,
      cost_usd: ar.cost_usd || 0,
      tokens: ar.tokens || { input: 0, output: 0, total: 0 },
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      run_duration_ms: ar.run_duration_ms || 0,
      max_signal_ts_observed: ar.max_signal_ts || null,
      final_text: ar.final_text || "",
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
