// Discovery — respond
//
// Terminal step. Returns a JSON summary so curl tests / future
// orchestrators see what discovery produced. Doesn't write anything;
// write_discovered_signals already persisted to STG_EXTERNAL_SIGNALS.

export default defineComponent({
  props: {
    rerank_result: { type: "any", optional: true },
    canon_result: { type: "any", optional: true },
    write_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const rerank = this.rerank_result || {};
    const canon = this.canon_result || {};
    const write = this.write_result || {};

    const body = {
      tool: "discovery",
      proposals_raw: rerank.raw_input_count ?? 0,
      proposals_kept_by_rerank: (rerank.kept_proposals || []).length,
      signals_after_canonicalize: canon.signal_count ?? 0,
      dropped_4xx: canon.dropped_404 ?? 0,
      dropped_dupe: canon.dropped_dupe ?? 0,
      dropped_invalid: canon.dropped_invalid ?? 0,
      signals_persisted: write?.signals ?? write?.[0]?.signals ?? null,
      rerank_cost_tokens: rerank._token_usage || null,
      rerank_error: rerank.error || null,
    };

    console.log(`Discovery complete:`, body);
    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });
    return body;
  },
});
