// Search GDELT (agent tool) — handle_request

const TOPIC_MAX = 300;
const WINDOW_MAX = 30;
const ALLOWED_MODES = new Set(["ArtList", "ArtRecent"]);

function sanitizeSessionId(s) {
  if (!s) return "";
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export default defineComponent({
  props: { trigger_event: { type: "any" } },
  async run() {
    const body = this.trigger_event?.body || {};
    const topic = String(body.topic || "").trim();
    if (!topic) throw new Error("missing 'topic' in request body");
    if (topic.length > TOPIC_MAX) throw new Error(`topic too long (max ${TOPIC_MAX})`);

    const window_days = Math.min(Math.max(1, Number(body.window_days) || 7), WINDOW_MAX);
    const mode = ALLOWED_MODES.has(body.mode) ? body.mode : "ArtList";
    const agent_session_id = sanitizeSessionId(body.agent_session_id);

    console.log(`search-gdelt: topic='${topic.slice(0, 80)}' window=${window_days}d mode=${mode} session=${agent_session_id || "(none)"}`);
    return { topic, window_days, mode, agent_session_id };
  },
});
