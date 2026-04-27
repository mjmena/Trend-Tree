// Promotion Lead — respond
//
// Returns a run summary via $.respond(). Required because the HTTP trigger
// has custom_response: true — without a $.respond call the request errors
// out as "Error in workflow".

export default defineComponent({
  props: {
    event: { type: "any" },
    lead_result: { type: "any", optional: true },
    apply_result: { type: "any", optional: true },
    eval_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const lead = this.lead_result || {};
    const evalR = this.eval_result || {};

    let applyParsed = null;
    try {
      const raw = this.apply_result;
      let row = null;
      if (Array.isArray(raw) && raw.length > 0) row = raw[0];
      else if (raw && typeof raw === "object") row = raw;
      if (row) {
        const value = row.PROC_PROMOTION_APPLY ?? row.proc_promotion_apply ?? Object.values(row)[0];
        applyParsed = typeof value === "string" ? JSON.parse(value) : value;
      }
    } catch (e) {
      applyParsed = { parse_error: e.message };
    }

    const body = {
      tool: "promotion_lead",
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      dry_run: evt.dry_run === true,
      bundle_count: lead.bundle_count ?? 0,
      dispatched_count: lead.dispatched_count ?? 0,
      quality_gate_rejected: lead.quality_gate_rejected ?? 0,
      failed_dispatches: lead.failed_dispatches ?? [],
      cost_usd: lead.cost_usd ?? 0,
      run_duration_ms: lead.run_duration_ms ?? 0,
      apply_result: applyParsed,
      looped: evalR.looped ?? false,
      stop_reasons: evalR.stop_reasons ?? null,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
