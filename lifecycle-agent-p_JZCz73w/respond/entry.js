// Lifecycle Agent (sweeper) — respond
//
// Cron-triggered, no $.respond() needed. Just summarize the run for logs.

function unwrapProcResult(payload) {
  // PROC_LIFECYCLE_APPLY returns a single VARIANT row.
  let row = null;
  if (Array.isArray(payload) && payload.length > 0) row = payload[0];
  else if (payload && typeof payload === "object") row = payload;
  if (!row) return null;
  const value =
    row.PROC_LIFECYCLE_APPLY ??
    row.proc_lifecycle_apply ??
    Object.values(row)[0];
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

export default defineComponent({
  props: {
    event: { type: "object" },
    due_count: { type: "any" },
    dispatch_result: { type: "any" },
    commit_result: { type: "any" },
  },
  async run({ $ }) {
    const dr = this.dispatch_result || {};
    const proc = unwrapProcResult(this.commit_result) || {};

    const summary = {
      chain_id: this.event?.chain_id,
      write_live: !!this.event?.write_live,
      due_count: Number(this.due_count) || 0,
      dispatched: dr.subagent_results?.length || 0,
      decisions: dr.decisions_count || 0,
      applied: proc.applied_count || 0,
      errors: (proc.error_count || 0) + (dr.error_count || 0),
      retire_proposals_logged: proc.retire_proposals || 0,
      retire_committed: proc.retire_committed || 0,
      cost_usd: dr.cost_usd || 0,
      run_duration_ms: dr.run_duration_ms || 0,
    };

    $.export(
      "$summary",
      `${summary.applied}/${summary.due_count} trends applied (write_live=${summary.write_live}), $${summary.cost_usd.toFixed(3)}`
    );

    return summary;
  },
});
