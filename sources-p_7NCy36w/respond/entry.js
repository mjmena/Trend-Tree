// Sources Enrichment — respond
//
// Terminal step. Assembles the HTTP response body for the sources
// workflow and sends it via $.respond. The downstream orchestrator
// consumes this to (a) decide whether source coverage is high enough
// for the LLM workflow to produce a useful result, and (b) log
// search terms used for this trend.

export default defineComponent({
  props: {
    aggregate_output: {
      type: "object",
      label: "Output from aggregate step",
    },
    merge_result: {
      type: "any",
      label: "Output from merge_fct_metrics registry step",
      optional: true,
    },
  },
  async run({ $ }) {
    const agg = this.aggregate_output || {};
    const body = {
      trend_id: agg.trend_id,
      trend_topic: agg.trend_topic,
      enrichment_type: agg.enrichment_type,
      source_coverage: agg.source_coverage ?? 0,
      search_terms: agg.search_terms ?? [],
      records: agg.records ?? [],
      all_records: agg.all_records ?? [],
      merge_rows_affected: Array.isArray(this.merge_result)
        ? this.merge_result.length
        : null,
      _token_usage: agg._token_usage ?? null,
    };

    console.log(`\n=== Sources enrichment complete for ${agg.trend_id} ===`);
    console.log(`  Coverage: ${body.source_coverage}/3 sources`);
    console.log(`  Records written: ${body.records.length}`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
