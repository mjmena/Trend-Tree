// Pipedream Workflow Step: Return LLM Output
//
// Terminal step of the LLM enrichment workflow. Aggregates the outputs of
// every upstream LLM step into a single response object and returns it
// via $.respond so the HTTP caller (future orchestrator, or a curl test)
// gets the full enrichment payload synchronously.
//
// This workflow is the "LLM with callback" step of the future orchestrator.
// It writes nothing to Snowflake — orchestrator step 4 is responsible for
// persisting the output to DIM_TREND_ENRICHMENT / FCT_TREND_ENRICHMENT_HISTORY.

// Cost estimation rates (USD per 1M tokens). Must stay in sync with
// enrich_write_snowflake.mjs in trends-sql.
const COST_PER_M = {
  "gemini-2.5-flash":  { input: 0.15, output: 0.60 },
  "grok-3-mini-fast":  { input: 0.30, output: 0.50 },
  "gpt-4o-mini":       { input: 0.15, output: 0.60 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

export default defineComponent({
  name: "Return LLM Output",
  description: "Aggregates all LLM step outputs and returns them as the HTTP response body",
  version: "0.0.1",
  props: {
    enrich_context: {
      type: "object",
      label: "Trend enrichment context",
      description: "Output from the load_llm_context step",
    },
    gemini_output: {
      type: "object",
      label: "Gemini specialist output",
      optional: true,
    },
    grok_output: {
      type: "object",
      label: "Grok specialist output",
      optional: true,
    },
    chatgpt_output: {
      type: "object",
      label: "ChatGPT specialist output",
      optional: true,
    },
    claude_output: {
      type: "object",
      label: "Claude synthesizer output",
      optional: true,
    },
  },
  async run({ $ }) {
    const ctx = this.enrich_context;
    const gemini = this.gemini_output ?? null;
    const grok = this.grok_output ?? null;
    const chatgpt = this.chatgpt_output ?? null;
    const claude = this.claude_output ?? null;

    // ── Token / cost accounting ───────────────────────────────────────
    const tokenUsage = {};
    let totalInput = 0, totalOutput = 0, totalCost = 0;
    for (const [name, output] of Object.entries({ gemini, grok, chatgpt, claude })) {
      const u = output?._token_usage;
      if (u && u.model) {
        tokenUsage[name] = { input: u.input, output: u.output, model: u.model };
        totalInput += u.input || 0;
        totalOutput += u.output || 0;
        const rates = COST_PER_M[u.model];
        if (rates) {
          totalCost += (u.input / 1_000_000) * rates.input + (u.output / 1_000_000) * rates.output;
        }
      }
    }
    tokenUsage.total = { input: totalInput, output: totalOutput };
    const totalTokens = totalInput + totalOutput;
    const costEstimate = Math.round(totalCost * 10000) / 10000;

    const modelsUsed = claude?._models_used ?? [
      ...(gemini ? ["gemini-2.5-flash"] : []),
      ...(grok ? ["grok-3-mini-fast"] : []),
      ...(chatgpt ? ["gpt-4o-mini"] : []),
      ...(claude ? ["claude-sonnet-4-6"] : []),
    ];

    const body = {
      trend_id: ctx?.trend_id ?? null,
      trend_topic: ctx?.trend_topic ?? null,
      enrichment_type: ctx?.enrichment_type ?? null,
      enrich_context: ctx,
      gemini_output: gemini,
      grok_output: grok,
      chatgpt_output: chatgpt,
      claude_output: claude,
      models_used: modelsUsed,
      llm_token_usage: tokenUsage,
      llm_total_tokens: totalTokens,
      llm_cost_estimate: costEstimate,
      gated: Boolean(claude?._gated),
    };

    console.log(`\n=== LLM enrichment complete for ${ctx?.trend_id} ===`);
    console.log(`  Models: ${modelsUsed.join(", ")}`);
    console.log(`  Tokens: ${totalTokens} (${totalInput} in / ${totalOutput} out)`);
    console.log(`  Est. cost: $${costEstimate}`);
    console.log(`  Gated: ${body.gated}`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
