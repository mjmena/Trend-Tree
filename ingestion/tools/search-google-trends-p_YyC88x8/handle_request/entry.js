// Search Google Trends (agent tool) — handle_request

const KEYWORD_MAX = 100;
const ALLOWED_GEOS = /^[A-Z]{2}$/;

function sanitizeSessionId(s) {
  if (!s) return "";
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export default defineComponent({
  props: { trigger_event: { type: "any" } },
  async run() {
    const body = this.trigger_event?.body || {};
    const keyword = String(body.keyword || "").trim();
    if (!keyword) throw new Error("missing 'keyword' in request body");
    if (keyword.length > KEYWORD_MAX) throw new Error(`keyword too long (max ${KEYWORD_MAX})`);

    const geoCandidate = String(body.geo || "US").toUpperCase();
    const geo = ALLOWED_GEOS.test(geoCandidate) ? geoCandidate : "US";
    const timeframe = String(body.timeframe || "now 7-d").trim().slice(0, 32);
    const agent_session_id = sanitizeSessionId(body.agent_session_id);

    console.log(`search-gtrends: keyword='${keyword}' geo=${geo} timeframe='${timeframe}' session=${agent_session_id || "(none)"}`);
    return { keyword, geo, timeframe, agent_session_id };
  },
});
