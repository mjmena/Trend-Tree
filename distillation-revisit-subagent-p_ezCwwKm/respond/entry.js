// Distillation Revisit Subagent — respond
//
// Returns proposed candidates + telemetry to the lead. Lead aggregates
// across all clusters before persisting to STG_TREND_CANDIDATES.

export default defineComponent({
  props: {
    request: { type: "object" },
    agent_result: { type: "any" },
  },
  async run({ $ }) {
    const r = this.agent_result || {};
    const body = {
      cluster_id: r.cluster_id ?? this.request?.cluster_id,
      proposed_candidates: r.proposed_candidates || [],
      candidates_count: r.candidates_count ?? 0,
      stop_reason: r.stop_reason,
      turns: r.turns,
      tokens: r.tokens,
      cost_usd: r.cost_usd,
      run_duration_ms: r.run_duration_ms,
      prompt_version: r.prompt_version,
    };
    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });
    return body;
  },
});
