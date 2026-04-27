// Promotion Subagent — respond
//
// Returns the agent's decision via $.respond(). Requires the trigger's
// "Return a custom response" toggle to be ON (custom_response: true).
// See CLAUDE.md gotcha #6.

export default defineComponent({
  props: {
    request: { type: "any" },
    agent_result: { type: "any" },
  },
  async run({ $ }) {
    const req = this.request || {};
    const ar = this.agent_result || {};
    const c = req.candidate || {};

    const body = {
      tool: "promotion_subagent",
      candidate_id: c.candidate_id,
      // Pass through context for the lead's audit
      distillation_verdict: c.distillation_verdict,
      // Decision (from agent loop)
      decision: ar.decision || "ERROR",
      decision_category: ar.decision_category || null,
      target_trend_id: ar.target_trend_id || null,
      trend_topic: ar.trend_topic || c.candidate_topic,   // default to candidate topic on PROMOTE
      trend_vector: c.candidate_vector,                   // pass through for PROMOTE_NEW
      rejection_reason: ar.rejection_reason || null,
      defer_until: ar.defer_until || null,
      defer_reason: ar.defer_reason || null,
      rationale: ar.rationale || ar.final_text || "",
      max_neighbor_sim: ar.max_neighbor_sim || null,
      considered_neighbors: ar.considered_neighbors || [],
      // Telemetry
      model_used: ar.model || null,
      tokens: ar.tokens || { input: 0, output: 0, total: 0 },
      cost_usd: ar.cost_usd || 0,
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      reasoning_trace_size: Array.isArray(ar.reasoning_trace) ? ar.reasoning_trace.length : 0,
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
