// Lifecycle Attribution Subagent — respond
//
// Returns attribution summary to the sweeper (fire-and-forget; sweeper ignores body).

export default defineComponent({
  props: {
    event: { type: "object" },
    subagent_output: { type: "any" },
    commit_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const out = this.subagent_output || {};

    const commit_raw = (this.commit_result || [])[0];
    const committed_count = commit_raw?.["number of rows inserted"] ?? commit_raw?.ROWS_INSERTED ?? null;

    const body = {
      trend_id: ev.trend_id,
      chain_id: ev.chain_id,
      session_id: ev.session_id,
      attributions_proposed: out.attributions_count ?? 0,
      committed_count,
      llm_token_usage: out.tokens || { input: 0, output: 0 },
      llm_cost_estimate: out.cost_usd || 0,
      agent_telemetry: {
        model: out.model,
        turns: out.turns,
        stop_reason: out.stop_reason,
        tool_call_count: out.tool_call_count,
        duration_ms: out.duration_ms,
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
      out.skipped
        ? `${ev.trend_id}: ${out.skipped}`
        : `${ev.trend_id}: ${out.attributions_count ?? 0} proposed, $${(out.cost_usd || 0).toFixed(3)}`
    );

    return body;
  },
});
