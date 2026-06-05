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

    // snowflake-execute-sql-query@0.2.3 returns $return_value as the row array
    // directly (not wrapped in { rows }). Stay tolerant of both shapes.
    const asRows = (v) => (Array.isArray(v) ? v : (Array.isArray(v?.rows) ? v.rows : []));

    const s = asRows(this.summary)[0] || {};

    // The INSERT step returns one row like { "number of rows inserted": N }.
    const ins = asRows(this.commit_result)[0] || {};
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
