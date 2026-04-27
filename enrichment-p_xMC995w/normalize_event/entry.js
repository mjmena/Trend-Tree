// Enrichment — normalize_event
//
// Coerces the HTTP trigger body into a normalized event object that the
// downstream prefetch queries + agent step consume. Validates trend_id,
// derives a unique agent_session_id (used to tag any STG_EXTERNAL_SIGNALS
// rows the agent's ingest tool calls write — the post-run tag_signals
// step UPDATEs those rows with signal_kind='enrichment_citation' +
// linked_trend_id, joining by AGENT_SESSION_ID).

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run({ $ }) {
    const body = (this.trigger_event && this.trigger_event.body) || this.trigger_event || {};
    const trend_id = body.trend_id;
    if (!trend_id || typeof trend_id !== "string") {
      throw new Error(`enrichment requires {trend_id: <uuid>} in body; got ${JSON.stringify(body).slice(0, 200)}`);
    }

    // chain_id propagates upstream-supplied identifiers (dispatcher chain)
    // or generates a new one for direct/manual fires.
    const chain_id = body.chain_id || cryptoRandomId("enr-chain-");
    const agent_session_id = body.agent_session_id || cryptoRandomId("enr-sess-");
    const iteration = Number.isInteger(body.iteration) ? body.iteration : 1;

    const out = {
      trend_id,
      chain_id,
      agent_session_id,
      iteration,
      enrichment_type: body.enrichment_type || null, // overridden by q_queue if present
      dry_run: body.dry_run === true,
      budget_usd: typeof body.budget_usd === "number" ? body.budget_usd : null,
      max_iterations: Number.isInteger(body.max_iterations) ? body.max_iterations : null,
      received_at: new Date().toISOString(),
    };

    console.log(`enrichment normalize: trend=${trend_id} chain=${chain_id} session=${agent_session_id} dry_run=${out.dry_run}`);
    $.export("$summary", `${trend_id} (chain ${chain_id.slice(-6)})`);
    return out;
  },
});

function cryptoRandomId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
