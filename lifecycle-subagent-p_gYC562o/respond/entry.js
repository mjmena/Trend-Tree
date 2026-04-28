// lifecycle-subagent — respond
//
// Returns the lifecycle_decision payload (or skip-reason) to the sweeper.
// $.respond is fire-and-forget shaped; sweeper reads the JSON body.

export default defineComponent({
  props: {
    event: { type: "object" },
    subagent_output: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const out = this.subagent_output || {};

    const body = {
      trend_id: ev.trend_id,
      chain_id: ev.chain_id,
      agent_session_id: ev.agent_session_id,
      lifecycle_decision: out.lifecycle_decision || null,
      heat_base: out.heat_base ?? null,
      llm_token_usage: out.tokens || { input: 0, output: 0 },
      llm_total_tokens: (out.tokens?.input || 0) + (out.tokens?.output || 0),
      llm_cost_estimate: out.cost_usd || 0,
      agent_telemetry: {
        model: out.model,
        turns: out.turns,
        stop_reason: out.stop_reason,
        tool_call_count: out.tool_call_count,
        reasoning_trace_size: out.reasoning_trace_size,
        agent_duration_ms: out.duration_ms,
      },
      skipped: out.skipped || null,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    $.export(
      "$summary",
      out.lifecycle_decision
        ? `${ev.trend_id}: ${out.lifecycle_decision.status}, $${(out.cost_usd || 0).toFixed(3)}`
        : `${ev.trend_id}: ${out.skipped || "no decision"}`
    );

    return body;
  },
});
