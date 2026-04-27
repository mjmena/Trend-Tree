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
    gemini_result: { type: "any", optional: true },
    grok_result: { type: "any", optional: true },
    chatgpt_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const rerank = this.rerank_result || {};
    const canon = this.canon_result || {};
    const write = this.write_result;

    const summarizeModel = (r) => {
      if (!r) return null;
      return {
        proposals: (r.proposals || []).length,
        shards_attempted: r.shards_attempted ?? null,
        shards_succeeded: r.shards_succeeded ?? null,
        per_vertical_counts: r.per_vertical_counts ?? null,
        error: r.error ?? null,
      };
    };

    // MERGE_EXTERNAL_SIGNALS returns VARIANT { batches, signals, ... }.
    // Pipedream's snowflake-execute-sql-query wraps a CALL result as an
    // array of rows where the proc's return lives under a column named
    // after the proc. Be tolerant of either shape (raw dict vs row-array).
    const writeRow = Array.isArray(write) ? write[0] : write;
    const writeData = writeRow?.MERGE_EXTERNAL_SIGNALS
      ?? writeRow?.["MERGE_EXTERNAL_SIGNALS"]
      ?? writeRow
      ?? {};
    const signalsPersisted = writeData?.signals
      ?? writeData?.SIGNALS
      ?? canon.signal_count   // fallback: canon already counted what we sent
      ?? null;

    const body = {
      tool: "discovery",
      proposals_raw: rerank.raw_input_count ?? 0,
      proposals_kept_by_rerank: (rerank.kept_proposals || []).length,
      signals_after_canonicalize: canon.signal_count ?? 0,
      dropped_4xx: canon.dropped_404 ?? 0,
      dropped_dupe: canon.dropped_dupe ?? 0,
      dropped_invalid: canon.dropped_invalid ?? 0,
      signals_persisted: signalsPersisted,
      rerank_cost_tokens: rerank._token_usage || null,
      rerank_error: rerank.error || null,
      models: {
        gemini: summarizeModel(this.gemini_result),
        grok: summarizeModel(this.grok_result),
        chatgpt: summarizeModel(this.chatgpt_result),
      },
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
