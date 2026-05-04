// lifecycle-subagent — handle_request
//
// Per-trend HTTP entry. Sweeper POSTs:
//   { trend_id, chain_id, agent_session_id, dry_run, budget_usd, write_live }
// Manual POSTs (testing) follow the same shape.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;
const TREND_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(Number(n))) return null;
  return Math.min(Math.max(Number(n), lo), hi);
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
    }
    const trend_id = String(body.trend_id || "").trim();
    if (!trend_id) {
      $.flow.exit("ignored: POST with no trend_id (health probe or test payload)");
    }
    if (!TREND_ID_OK.test(trend_id)) {
      throw new Error(`invalid or missing 'trend_id' (got '${trend_id}')`);
    }

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `lcy-chain-${uuid()}`;
    const agent_session_id = SHORT_ID_OK.test(body.agent_session_id || "")
      ? body.agent_session_id
      : `lcy-sess-${uuid()}`;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_usd = clamp(body.budget_usd, 0.01, 0.50) ?? 0.06;
    // write_live is the gate the sweeper's commit_decisions step honors;
    // subagent doesn't act on it but echoes it back so the sweeper can decide.
    const write_live = body.write_live === true || body.write_live === "true";

    console.log(
      `lcy-sub: trend=${trend_id} session=${agent_session_id} chain=${chain_id} ` +
      `budget=$${budget_usd} dry_run=${dry_run} write_live=${write_live}`
    );

    return {
      trend_id,
      chain_id,
      agent_session_id,
      dry_run,
      budget_usd,
      write_live,
    };
  },
});
