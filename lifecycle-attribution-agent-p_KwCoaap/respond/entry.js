// Lifecycle Attribution Agent (sweeper) — respond
//
// HTTP trigger so $.respond() is needed. Returns dispatch summary.
// Actual attribution results land in FCT_TREND_SIGNALS — check there.

export default defineComponent({
  props: {
    event: { type: "object" },
    active_count: { type: "any" },
    dispatch_result: { type: "any" },
  },
  async run({ $ }) {
    const dr = this.dispatch_result || {};

    const body = {
      chain_id: this.event?.chain_id,
      active_count: Number(this.active_count) || 0,
      dispatched: dr.dispatched_count || 0,
      dispatch_errors: dr.error_count || 0,
      run_duration_ms: dr.run_duration_ms || 0,
      skipped: dr.skipped || null,
      note: "subagents attribute independently; query FCT_TREND_SIGNALS by LINKED_AT in 1-3 min",
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    $.export(
      "$summary",
      `dispatched ${body.dispatched}/${body.active_count} trends for attribution`
    );

    return body;
  },
});
