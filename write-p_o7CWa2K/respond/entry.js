// Write Enrichment — respond
//
// Terminal step. Returns a compact summary of what was written so the
// dispatcher can log it and the trend's enrichment state is visible
// to any ad-hoc curl test.

export default defineComponent({
  props: {
    compute_scores_output: {
      type: "object",
      label: "Output from compute_scores",
    },
    call_proc_result: {
      type: "any",
      optional: true,
    },
  },
  async run({ $ }) {
    const cs = this.compute_scores_output || {};

    // PROC_ENRICHMENT_APPLY returns a single VARIANT row; unwrap it.
    let procResult = null;
    try {
      const raw = Array.isArray(this.call_proc_result) ? this.call_proc_result[0] : this.call_proc_result;
      const value = raw?.PROC_ENRICHMENT_APPLY ?? raw?.proc_enrichment_apply ?? raw;
      procResult = typeof value === "string" ? JSON.parse(value) : value;
    } catch (e) {
      procResult = { error: e.message };
    }

    const body = {
      trend_id: cs.trend_id,
      enrichment_type: cs.enrichment_type,
      tier: cs.tier,
      skip_dim: cs.skip_dim,
      trend_name_b2c: cs.payload?.trend_name_b2c ?? null,
      category: cs.payload?.category ?? null,
      source_coverage: cs.source_coverage ?? 0,
      llm_total_tokens: cs.llm_total_tokens ?? 0,
      llm_cost_estimate: cs.llm_cost_estimate ?? 0,
      proc_result: procResult,
    };

    console.log(`\n=== Write complete: ${body.trend_id} [${body.tier}] ===`);
    console.log(`  Trend: "${body.trend_name_b2c}" (${body.category})`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
