// Grok Live Search (agent tool) — handle_request

const QUERY_MAX = 400;
const ALLOWED_MODES = new Set(["web", "x", "both"]);

function sanitizeSessionId(s) {
  if (!s) return "";
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export default defineComponent({
  props: { trigger_event: { type: "any" } },
  async run() {
    const body = this.trigger_event?.body || {};
    const query = String(body.query || "").trim();
    if (!query) throw new Error("missing 'query' in request body");
    if (query.length > QUERY_MAX) throw new Error(`query too long (max ${QUERY_MAX})`);

    const mode = ALLOWED_MODES.has(body.mode) ? body.mode : "both";
    const agent_session_id = sanitizeSessionId(body.agent_session_id);

    console.log(`grok-live-search: q='${query.slice(0, 80)}' mode=${mode} session=${agent_session_id || "(none)"}`);
    return { query, mode, agent_session_id };
  },
});
