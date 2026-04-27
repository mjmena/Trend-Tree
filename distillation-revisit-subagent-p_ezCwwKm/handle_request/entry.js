// Distillation Revisit Subagent — handle_request
//
// Validates the lead's POST body and produces a normalized inputs object.
// Each subagent run is given ONE pre-clustered slice of leftover signals
// and asked: "do these collectively suggest a trend the main pass missed?"
//
// Single-quote SQL escaping (line ~40) is the injection defense; the regex
// just rejects obvious garbage.

const SIGNAL_ID_OK = /^[^\s\x00-\x1F\x7F]{1,300}$/;
const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;
const MAX_SIGNALS = 100;

function sanitizeId(s, regex) {
  if (!s) return "";
  const v = String(s);
  return regex.test(v) ? v : "";
}

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body || {};

    const rawSignalIds = Array.isArray(body.signal_ids) ? body.signal_ids : [];
    const signal_ids = rawSignalIds
      .map((s) => sanitizeId(s, SIGNAL_ID_OK))
      .filter(Boolean)
      .slice(0, MAX_SIGNALS);
    if (signal_ids.length === 0) throw new Error("no valid signal_ids in request body");

    // Build a SQL-safe IN-list (validated above; single-quoting is the actual defense).
    const signal_ids_sql_in = signal_ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");

    const cluster_id = Number.isFinite(Number(body.cluster_id)) ? Number(body.cluster_id) : 0;
    const budget_tokens = Math.min(Math.max(5000, Number(body.budget_tokens) || 25000), 60000);
    const agent_session_id = sanitizeId(body.agent_session_id, SHORT_ID_OK);
    const chain_id = sanitizeId(body.chain_id, SHORT_ID_OK);
    const dry_run = body.dry_run === true || body.dry_run === "true";

    console.log(
      `revisit-subagent: cluster=${cluster_id} signals=${signal_ids.length} budget=${budget_tokens} session=${agent_session_id} dry_run=${dry_run}`,
    );

    return {
      cluster_id,
      signal_ids,
      signal_ids_sql_in,
      budget_tokens,
      agent_session_id,
      chain_id,
      dry_run,
    };
  },
});
