// Ecomm Agent — respond
//
// Final $.respond() handler (CRMA-776). The trigger's custom_response is
// on, so SOMETHING must call $.respond() or the endpoint 400s even when
// every upstream step succeeded (pipedream-synced-project skill) — this
// is that step, and it is the only one, so every path (declined,
// completed, failed) must reach it with a renderable body.

export default defineComponent({
  props: {
    event: { type: "any" },
    result: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const r = this.result || {};

    const body = {
      trend_id: evt.trend_id,
      tier: evt.tier,
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      decision: r.decision || "unknown",
      sourcing_run_id: r.sourcing_run_id || null,
      outcome: r.outcome || (r.decision === "declined" ? "not_sourced" : null),
      selector_note: r.selector_note ?? null,
      error_message: r.error_message ?? r.reason ?? null,
      candidate_count: Array.isArray(r.candidates) ? r.candidates.length : null,
      selected_count: Array.isArray(r.candidates) ? r.candidates.filter((c) => c.selected).length : null,
      candidates: r.candidates ?? [],
      warnings: r.warnings ?? [],
      selector_telemetry: r.selector_telemetry ?? null,
      catalog_age_days: r.catalog_age_days ?? null,
      cost_row_error: r.cost_row_error ?? null,
    };

    // outcome==="failed" also covers decision==="completed" (e.g. no
    // sourceable vector for the trend) — that path never hits
    // decision==="failed" but still needs its real error_message surfaced
    // here, not swallowed behind a generic "N picked" summary.
    const summary =
      r.decision === "declined" ? `declined: ${r.reason}` :
      (r.decision === "failed" || r.outcome === "failed") ? `failed: ${body.error_message}` :
      `${body.outcome}: ${body.selected_count ?? 0} picked`;

    console.log(`ecomm-agent respond: trend=${evt.trend_id} ${summary}`);
    $.export("$summary", `${evt.trend_id}: ${summary}`);
    await $.respond({ status: 200, headers: { "Content-Type": "application/json" }, body });
    return body;
  },
});
