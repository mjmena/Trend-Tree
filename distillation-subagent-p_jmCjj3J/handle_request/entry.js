// Distillation Subagent — handle_request
//
// Validates the lead's POST body and produces a normalized inputs object.
// Also produces a SQL-safe IN-list for the q_fetch_signals step. SIGNAL_ID
// in STG_EXTERNAL_SIGNALS is a URL for many sources (Wikipedia, GDELT,
// etc.) so the validator allows any printable non-whitespace string up to
// 300 chars. Single-quote SQL escaping (line 38) is the actual injection
// defense; the regex just rejects obvious garbage (empty, whitespace,
// control chars).

const SIGNAL_ID_OK = /^[^\s\x00-\x1F\x7F]{1,300}$/;
const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;
const HYPOTHESIS_MAX = 2000;

function sanitizeId(s, regex) {
  if (!s) return "";
  const v = String(s);
  return regex.test(v) ? v : "";
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

    const hypothesis = String(body.hypothesis || "").trim();
    if (!hypothesis) {
      $.flow.exit("ignored: POST with no hypothesis (health probe or test payload)");
      return;
    }
    if (hypothesis.length > HYPOTHESIS_MAX) throw new Error(`hypothesis too long (max ${HYPOTHESIS_MAX} chars)`);

    const rawSignalIds = Array.isArray(body.signal_ids) ? body.signal_ids : [];
    const signal_ids = rawSignalIds.map((s) => sanitizeId(s, SIGNAL_ID_OK)).filter(Boolean).slice(0, 100);
    if (signal_ids.length === 0) throw new Error("no valid signal_ids in request body");

    // Build a SQL-safe IN-list. Each id has been validated against SIGNAL_ID_OK
    // so single-quoting is safe; double-checked here belt-and-suspenders.
    const signal_ids_sql_in = signal_ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");

    const budget_tokens = Math.min(Math.max(5000, Number(body.budget_tokens) || 30000), 80000);
    const agent_session_id = sanitizeId(body.agent_session_id, SHORT_ID_OK);
    const chain_id = sanitizeId(body.chain_id, SHORT_ID_OK);
    const dry_run = body.dry_run === true || body.dry_run === "true";

    console.log(
      `subagent: signals=${signal_ids.length} budget=${budget_tokens} session=${agent_session_id} chain=${chain_id} dry_run=${dry_run}`,
    );
    console.log(`hypothesis: ${hypothesis.slice(0, 200)}`);

    return {
      hypothesis,
      signal_ids,
      signal_ids_sql_in,
      budget_tokens,
      agent_session_id,
      chain_id,
      dry_run,
    };
  },
});
