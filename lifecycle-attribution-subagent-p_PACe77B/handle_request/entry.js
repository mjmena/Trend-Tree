// Lifecycle Attribution Subagent — handle_request
//
// Sweeper POSTs: { trend_id, chain_id, budget_usd }
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
  async run() {
    const body = this.trigger_event?.body || {};

    const trend_id = String(body.trend_id || "").trim();
    if (!TREND_ID_OK.test(trend_id)) {
      throw new Error(`invalid or missing 'trend_id' (got '${trend_id}')`);
    }

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `attr-chain-${uuid()}`;
    const session_id = `attr-sess-${uuid()}`;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_usd = clamp(body.budget_usd, 0.01, 0.20) ?? 0.04;

    console.log(
      `attr-sub: trend=${trend_id} session=${session_id} chain=${chain_id} ` +
      `budget=$${budget_usd} dry_run=${dry_run}`
    );

    return { trend_id, chain_id, session_id, dry_run, budget_usd };
  },
});
