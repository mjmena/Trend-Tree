// Prediction Agent — respond
//
// Summary response. Echoes counts for cron-side observability.
// Counts come from the `summarize` step (reads the ledger back by CHAIN_ID);
// committed row count comes from the `commit_to_ledger` INSERT.

export default defineComponent({
  props: {
    event:         { type: "any" },
    summary:       { type: "any" },
    commit_result: { type: "any" },
  },
  async run({ $ }) {
    const e = this.event || {};

    // snowflake-execute-sql-query returns rows[] for the summarize SELECT.
    const s = (Array.isArray(this.summary?.rows) && this.summary.rows[0]) || {};

    // The INSERT step returns a single row like { "number of rows inserted": N }.
    const ins = (Array.isArray(this.commit_result?.rows) && this.commit_result.rows[0]) || {};
    const inserted = ins["number of rows inserted"] ?? ins.NUMBER_OF_ROWS_INSERTED ?? null;

    const summary = {
      chain_id:       e.chain_id,
      dry_run:        !!e.dry_run,
      total_rows:     s.TOTAL_ROWS ?? 0,
      scored_count:   s.SCORED_COUNT ?? 0,
      eligible_count: s.ELIGIBLE_COUNT ?? 0,
      null_count:     s.NULL_COUNT ?? 0,
      rows_inserted:  inserted,
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
