// Enrichment Dispatcher — respond
//
// Terminal step. Calls $.respond() so the HTTP trigger returns the
// orchestrate output as a JSON body instead of Pipedream's default
// "Error in workflow" 400 (which is what custom_response:true returns
// when no step ever calls $.respond).
//
// Status code reflects the run outcome: 200 on success, 500 on any
// failure inside the orchestrate fetch chain. The dispatcher's
// Snowflake polling trigger doesn't care about HTTP status, so this
// step is effectively a no-op when invoked from that trigger
// (Pipedream just discards the response).

export default defineComponent({
  props: {
    orchestrate_output: {
      type: "any",
      label: "Output from orchestrate step",
    },
  },
  async run({ $ }) {
    const out = this.orchestrate_output || {};
    const errored = !!out.error_message;
    const status = errored ? 500 : 200;

    const body = {
      ok: !errored,
      trend_id: out.trend_id ?? null,
      enrichment_type: out.enrichment_type ?? null,
      stage: out.stage ?? null,
      duration_ms: out.duration_ms ?? null,
      error_message: out.error_message || null,
      sources_summary: out.sources
        ? {
            source_coverage: out.sources.source_coverage,
            records_written: Array.isArray(out.sources.records) ? out.sources.records.length : null,
          }
        : null,
      llm_summary: out.llm
        ? {
            tokens: out.llm.llm_total_tokens,
            cost: out.llm.llm_cost_estimate,
            gated: out.llm.gated,
            models: out.llm.models_used,
          }
        : null,
      write_summary: out.write
        ? {
            tier: out.write.tier,
            commercial_score: out.write.commercial_score,
            agreement_score: out.write.agreement_score,
            trend_name: out.write.trend_name,
            category: out.write.category,
          }
        : null,
    };

    await $.respond({
      status,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
