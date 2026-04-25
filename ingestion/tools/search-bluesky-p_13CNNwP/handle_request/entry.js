// Search Bluesky (agent tool) — handle_request
//
// Parses the agent's HTTP POST body, validates, and produces a normalized
// inputs object for downstream steps. Sanitizes agent_session_id (UUID-ish
// pattern only) since it gets inlined into the upsert MERGE SQL via
// mustache substitution; any unexpected character would be a SQL-injection
// vector.

const QUERY_MAX = 200;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 25;

function sanitizeSessionId(s) {
  if (!s) return "";
  // Allow alphanumerics, dash, underscore. Cap at 64 chars.
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body || {};
    const query = String(body.query || "").trim();
    const limitRaw = Number(body.limit);
    const sort = ["latest", "top"].includes(body.sort) ? body.sort : "latest";
    const agent_session_id = sanitizeSessionId(body.agent_session_id);

    if (!query) throw new Error("missing 'query' in request body");
    if (query.length > QUERY_MAX) throw new Error(`query too long (max ${QUERY_MAX} chars)`);
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : LIMIT_DEFAULT), LIMIT_MAX);

    console.log(`search-bluesky: q='${query.slice(0, 80)}' limit=${limit} sort=${sort} session=${agent_session_id || "(none)"}`);

    return { query, limit, sort, agent_session_id };
  },
});
