// Distillation Subagent — respond
//
// Returns the agent's verdict + candidates + reasoning trace via $.respond().
// Requires the trigger's "Return a custom response" toggle to be ON
// (custom_response: true). See CLAUDE.md gotcha #6.

export default defineComponent({
  props: {
    request: { type: "any" },
    agent_result: { type: "any" },
  },
  async run({ $ }) {
    const req = this.request || {};
    const ar = this.agent_result || {};

    const body = {
      tool: "distillation_subagent",
      hypothesis: req.hypothesis,
      verdict: ar.verdict || "ERROR",
      candidates: ar.candidates || [],
      final_text: ar.final_text || "",
      reasoning_trace: ar.reasoning_trace || [],
      tool_calls: ar.tool_calls || [],
      cost_usd: ar.cost_usd || 0,
      tokens: ar.tokens || { input: 0, output: 0, total: 0 },
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
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
