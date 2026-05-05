// Distillation Cluster Agent — handle_request
//
// Validates and normalizes the inbound batch from either dispatcher.
// The cluster agent is source-agnostic: it doesn't know or care whether
// cluster_rows came from the 24h main pool or the 48h revisit pool.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

function sanitizeId(s) {
  if (!s) return "";
  const v = String(s).trim();
  return SHORT_ID_OK.test(v) ? v : "";
}

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run({ $ }) {
    const body = this.trigger_event?.body || {};

    const method = (this.trigger_event?.method || "").toUpperCase();
    if (method !== "POST") {
      $.flow.exit(`ignored: method=${method || "unknown"}`);
      return;
    }

    const cluster_rows = Array.isArray(body.cluster_rows) ? body.cluster_rows : [];
    const signal_ids_json = String(body.signal_ids_json || "[]");

    let signal_ids;
    try {
      signal_ids = JSON.parse(signal_ids_json);
      if (!Array.isArray(signal_ids)) signal_ids = [];
    } catch {
      signal_ids = [];
    }

    if (signal_ids.length === 0) {
      throw new Error("signal_ids_json parsed to empty array — nothing to process");
    }

    const agent_session_id = sanitizeId(body.agent_session_id) || `sess-ca-${Date.now().toString(36)}`;
    const chain_id = sanitizeId(body.chain_id) || `chain-${Date.now().toString(36)}`;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_usd = Math.min(Math.max(1.0, Number(body.budget_usd) || 5.0), 20.0);

    console.log(
      `cluster-agent: signal_ids=${signal_ids.length} cluster_rows=${cluster_rows.length} ` +
      `session=${agent_session_id} chain=${chain_id} dry_run=${dry_run}`,
    );

    return {
      cluster_rows,
      signal_ids,
      signal_ids_json,
      agent_session_id,
      chain_id,
      dry_run,
      budget_usd,
      iteration: 1,
    };
  },
});
