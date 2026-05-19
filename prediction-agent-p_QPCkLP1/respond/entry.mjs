// Prediction Agent — respond
//
// Summary response. Echoes counts for cron-side observability.

export default defineComponent({
  props: {
    event:            { type: "any" },
    serialized:       { type: "any" },
    commit_result:    { type: "any" },
  },
  async run({ $ }) {
    const e = this.event || {};
    const s = this.serialized || {};
    // Snowflake registry action returns rows[] under the proc's key.
    const commit = Array.isArray(this.commit_result?.rows) && this.commit_result.rows[0]
      ? this.commit_result.rows[0]
      : (this.commit_result || {});
    const commit_payload = commit.PROC_PREDICTION_APPLY ?? commit;

    const summary = {
      chain_id:        e.chain_id,
      dry_run:         !!e.dry_run,
      total_rows:      s.total_rows ?? 0,
      scored_count:    s.scored_count ?? 0,
      eligible_count:  s.eligible_count ?? 0,
      null_count:      s.null_count ?? 0,
      committed:       commit_payload,
    };

    console.log(`pred-done: ${JSON.stringify(summary)}`);

    if ($ && typeof $.respond === "function") {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: summary,
      });
    }

    return summary;
  },
});
