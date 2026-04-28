// lifecycle-subagent — respond
//
// Returns the lifecycle_decision payload (or skip-reason) to the sweeper.
// $.respond is fire-and-forget shaped; sweeper reads the JSON body.

function unwrapProcResult(payload) {
  let row = null;
  if (Array.isArray(payload) && payload.length > 0) row = payload[0];
  else if (payload && typeof payload === "object") row = payload;
  if (!row) return null;
  const value = row.PROC_LIFECYCLE_APPLY ?? row.proc_lifecycle_apply ?? Object.values(row)[0];
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

export default defineComponent({
  props: {
    event: { type: "object" },
    subagent_output: { type: "any" },
    commit_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const out = this.subagent_output || {};
    const proc = unwrapProcResult(this.commit_result) || {};
    const myResult = (proc.results && proc.results[0]) || {};

    const body = {
      trend_id: ev.trend_id,
      chain_id: ev.chain_id,
      agent_session_id: ev.agent_session_id,
      lifecycle_decision: out.lifecycle_decision || null,
      heat_base: out.heat_base ?? null,
      committed: {
        applied: proc.applied_count || 0,
        applied_status: myResult.applied_status || null,
        retire_first_cycle: !!myResult.retire_first_cycle,
        committed_actions: myResult.committed_actions || [],
        write_live: !!proc.write_live,
        error: myResult.error || null,
      },
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
