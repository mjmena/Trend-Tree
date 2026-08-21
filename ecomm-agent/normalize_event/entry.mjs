// Ecomm Agent — normalize_event
//
// CRMA-776 (epic CRMA-772, "Trend-to-product sourcing" — Shopify first
// pass). The tracer-bullet story: POST {trend_id} sources that one trend
// end-to-end (retrieval -> selector -> ledger rows) via a single HTTP call.
//
// Coerces the HTTP trigger body into a normalized event. Validates
// trend_id is present and UUID-shaped (this repo's other trend_id-driven
// HTTP workflows, e.g. enrichment-p_xMC995w/normalize_event, only check
// "non-empty string" — this step goes one step further and validates
// shape too, since trend_id here also gets used as a bind parameter value
// across three Snowflake steps and a malformed value should fail fast and
// legibly rather than surface as a confusing empty-pool or driver error
// downstream).
//
// TIER is a code constant here ('shopify' — the only tier this build
// implements, see docs/prd/trend-to-product-sourcing.md) threaded through
// every downstream step's props rather than re-declared in each step, so
// there is exactly one place that would need to change for a future
// second tier's HTTP entrypoint.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIER = "shopify";

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run({ $ }) {
    const body = (this.trigger_event && this.trigger_event.body) || this.trigger_event || {};
    const trend_id = body.trend_id;

    if (!trend_id || typeof trend_id !== "string" || !UUID_RE.test(trend_id.trim())) {
      throw new Error(
        `ecomm-agent requires {trend_id: <uuid>} in body; got ${JSON.stringify(body).slice(0, 200)}`,
      );
    }

    const chain_id = body.chain_id || cryptoRandomId("ecomm-chain-");
    const agent_session_id = body.agent_session_id || cryptoRandomId("ecomm-sess-");

    const out = {
      trend_id: trend_id.trim(),
      tier: TIER,
      chain_id,
      agent_session_id,
      received_at: new Date().toISOString(),
    };

    console.log(`ecomm-agent normalize: trend=${out.trend_id} tier=${TIER} chain=${chain_id} session=${agent_session_id}`);
    $.export("$summary", `${out.trend_id} (${TIER})`);
    return out;
  },
});

function cryptoRandomId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
