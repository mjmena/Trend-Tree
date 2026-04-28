// gtrends-poller — respond
//
// Cron-triggered, no $.respond() needed (Pipedream cron runs synchronously
// and the workflow's return value is captured in the run log). Just emit
// a $summary for the run list.

export default defineComponent({
  props: {
    event: { type: "object" },
    fetch_result: { type: "any" },
    insert_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};
    const insertOk = Array.isArray(this.insert_result) || (this.insert_result && !this.insert_result.error);

    const summary = {
      chain_id: this.event?.chain_id,
      attempted: fr.attempted || 0,
      ok_count: fr.ok_count || 0,
      error_count: fr.error_count || 0,
      persisted: !!insertOk,
      run_duration_ms: fr.run_duration_ms || 0,
      errors: fr.errors || [],
    };

    $.export("$summary", `${summary.ok_count}/${summary.attempted} polled, persisted=${summary.persisted}`);
    return summary;
  },
});
