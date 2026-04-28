// Lifecycle Agent (sweeper) — respond
//
// Cron-triggered, no $.respond() needed. Just summarize the run for logs.

// Sweeper respond — fire-and-forget summary.
//
// Subagents commit their own decisions via PROC_LIFECYCLE_APPLY; the sweeper
// only knows about dispatch outcomes here. To see actual lifecycle decisions,
// query FCT_TREND_LIFECYCLE_HISTORY filtered by chain_id ~1-3 min after the
// sweep fires.

export default defineComponent({
  props: {
    event: { type: "object" },
    due_count: { type: "any" },
    dispatch_result: { type: "any" },
  },
  async run({ $ }) {
    const dr = this.dispatch_result || {};

    const summary = {
      chain_id: this.event?.chain_id,
      write_live: !!this.event?.write_live,
      due_count: Number(this.due_count) || 0,
      dispatched: dr.dispatched_count || 0,
      dispatch_errors: dr.error_count || 0,
      run_duration_ms: dr.run_duration_ms || 0,
      note: "subagents commit independently; query FCT_TREND_LIFECYCLE_HISTORY by chain_id in 1-3 min",
    };

    $.export(
      "$summary",
      `dispatched ${summary.dispatched}/${summary.due_count} trends (write_live=${summary.write_live})`
    );

    return summary;
  },
});
