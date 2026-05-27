// Enrichment — respond
//
// Final $.respond() handler. Assembles the full enrichment payload from
// the agent step output + the post-emission name reviewer pass, and
// returns it synchronously to the dispatcher. Output shape compatible
// with write-p_o7CWa2K's compute_scores: top-level keys consumed there
// are `enrichment_output`, `models_used`, `llm_token_usage`,
// `llm_total_tokens`, `llm_cost_estimate`, `gated`, `enrichment_type`.

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_output: { type: "any" },
    reviewer_output: { type: "any", optional: true },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const agent = this.agent_output || {};
    const reviewer = this.reviewer_output || null;

    const gated = !!agent.gated;
    const enrichment_type = agent.enrichment_type || evt.enrichment_type || "FULL";

    // Stitch reviewer output into the enrichment record so write-p sees it
    // alongside the agent's own output. New (2026-05-27) reviewer shape is
    // a two-call decode_pass test — fields live at the top level of the
    // reviewer return, not under .review. Pluck the persistable fields
    // into a name_reviewer object on enrichment_output.
    let enrichment_output = agent.enrichment_output || null;
    if (enrichment_output && reviewer && !reviewer.skipped) {
      enrichment_output = {
        ...enrichment_output,
        name_reviewer: {
          tier1_pass:        reviewer.tier1_pass ?? null,
          tier1_banned_word: reviewer.tier1_banned_word ?? null,
          tier1_first_beat:  reviewer.tier1_first_beat ?? null,
          decoder_guess:     reviewer.decoder_guess ?? null,
          decode_pass:       reviewer.decode_pass ?? null,
          score:             reviewer.score ?? null,
          rationale:         reviewer.rationale ?? null,
          alternate:         reviewer.alternate ?? null,
          model:             reviewer.model || null,
          decoder_prompt_version:  reviewer.decoder_prompt_version ?? null,
          verifier_prompt_version: reviewer.verifier_prompt_version ?? null,
        },
      };
    }

    const llm_token_usage = {
      agent: agent.tokens || { input: 0, output: 0 },
      reviewer: reviewer?.tokens || { input: 0, output: 0 },
      total: {
        input: (agent.tokens?.input || 0) + (reviewer?.tokens?.input || 0),
        output: (agent.tokens?.output || 0) + (reviewer?.tokens?.output || 0),
      },
    };
    const llm_total_tokens = llm_token_usage.total.input + llm_token_usage.total.output;
    const llm_cost_estimate = Math.round(((agent.cost_usd || 0) + (reviewer?.cost_usd || 0)) * 10000) / 10000;

    const agentModel = agent.model || "gemini-3.1-pro-preview";
    const reviewerModel = reviewer?.model || "claude-sonnet-4-6";

    const payload = {
      trend_id: evt.trend_id,
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      enrichment_type,
      gated,
      enrichment_output,
      models_used: reviewer && !reviewer.skipped ? [agentModel, reviewerModel] : [agentModel],
      llm_token_usage,
      llm_total_tokens,
      llm_cost_estimate,
      agent_telemetry: {
        model: agentModel,
        turns: agent.turns ?? 0,
        stop_reason: agent.stop_reason || null,
        tool_call_count: agent.tool_call_count ?? 0,
        reasoning_trace_size: agent.reasoning_trace_size ?? 0,
        agent_duration_ms: agent.duration_ms ?? null,
      },
    };

    console.log(`enrichment respond: trend=${evt.trend_id} cost=$${llm_cost_estimate} gated=${gated} reviewer=${reviewer ? "ran" : "skipped"}`);
    $.export("$summary", `${evt.trend_id}: $${llm_cost_estimate}, ${agent.turns ?? 0} turns${gated ? " (gated)" : ""}`);
    await $.respond({ status: 200, headers: { "Content-Type": "application/json" }, body: payload });
    return payload;
  },
});
