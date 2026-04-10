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
    merge_dim_result: {
      type: "any",
      optional: true,
    },
    insert_history_result: {
      type: "any",
      optional: true,
    },
    update_queue_result: {
      type: "any",
      optional: true,
    },
  },
  async run({ $ }) {
    const cs = this.compute_scores_output || {};
    const rowCount = (r) => (Array.isArray(r) ? r.length : null);

    const body = {
      trend_id: cs.trend_id,
      enrichment_type: cs.enrichment_type,
      tier: cs.tier,
      skip_dim: cs.skip_dim,
      trend_name: cs.payload?.trend_name ?? null,
      category: cs.payload?.category ?? null,
      source_coverage: cs.source_coverage ?? 0,
      commercial_score: cs.commercial_score ?? null,
      agreement_score: cs.agreement_score ?? null,
      llm_total_tokens: cs.llm_total_tokens ?? 0,
      llm_cost_estimate: cs.llm_cost_estimate ?? 0,
      merge_dim_rows: rowCount(this.merge_dim_result),
      insert_history_rows: rowCount(this.insert_history_result),
      update_queue_rows: rowCount(this.update_queue_result),
    };

    console.log(`\n=== Write complete: ${body.trend_id} [${body.tier}] ===`);
    console.log(`  Trend: "${body.trend_name}" (${body.category})`);
    console.log(`  Commercial: ${body.commercial_score}, Agreement: ${body.agreement_score}`);
    console.log(`  Queue rows updated: ${body.update_queue_rows}`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
