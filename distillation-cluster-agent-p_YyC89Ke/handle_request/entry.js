// Distillation Cluster Agent — handle_request
//
// Validates and normalizes the inbound batch from either dispatcher.
// The cluster agent is source-agnostic: it doesn't know or care whether
// cluster_rows came from the 24h main pool or the 48h revisit pool.
//
// Async-callback mode: when the caller passes body.resume_url, this step
// $.respond()s 202 immediately so the caller's outbound fetch can return
// (and the caller's lambda can suspend cleanly). The terminal `respond`
// step then POSTs the result body to that resume_url instead of $.respond.
// Synchronous mode (no resume_url): legacy path, terminal step $.respond's.
// Pipedream allows one $.respond per execution; the two branches never
// fire together.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;
const RESUME_URL_MAX = 4096;

function sanitizeId(s) {
  if (!s) return "";
  const v = String(s).trim();
  return SHORT_ID_OK.test(v) ? v : "";
}

function sanitizeResumeUrl(s) {
  if (typeof s !== "string") return null;
  const v = s.trim();
  if (!v || v.length > RESUME_URL_MAX) return null;
  if (!/^https:\/\//i.test(v)) return null;
  return v;
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
    const resume_url = sanitizeResumeUrl(body.resume_url);

    console.log(
      `cluster-agent: signal_ids=${signal_ids.length} cluster_rows=${cluster_rows.length} ` +
      `session=${agent_session_id} chain=${chain_id} dry_run=${dry_run} ` +
      `resume_url=${resume_url ? "present" : "none"}`,
    );

    if (resume_url) {
      await $.respond({
        status: 202,
        headers: { "Content-Type": "application/json" },
        body: { accepted: true, agent_session_id, chain_id, mode: "async_callback" },
      });
    }

    return {
      cluster_rows,
      signal_ids,
      signal_ids_json,
      agent_session_id,
      chain_id,
      dry_run,
      budget_usd,
      resume_url,
      iteration: 1,
    };
  },
});
