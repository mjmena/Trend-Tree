// gtrends-poller — respond
//
// Manual HTTP fires get a JSON summary back (the agent_http trigger has
// customResponse=true; without $.respond() the HTTP request hangs and
// returns "Error in workflow"). Cron-fired runs ignore $.respond — they
// have no HTTP request to answer.

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

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: summary,
    });

    $.export("$summary", `${summary.ok_count}/${summary.attempted} polled, persisted=${summary.persisted}`);
    return summary;
  },
});
