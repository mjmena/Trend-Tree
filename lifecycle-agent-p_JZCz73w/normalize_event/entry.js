// Lifecycle Agent (sweeper) — normalize_event
//
// Cron-fired by sources/lifecycle-cron most of the time. Manual POSTs
// (testing) can override:
//   { sweep_cap, write_live, dry_run, budget_per_subagent_usd, chain_id }

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

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

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `lcy-chain-${uuid()}`;
    const sweep_cap = clamp(body.sweep_cap, 1, 100) ?? 25;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    // write_live defaults to FALSE — shadow mode by default until ops flips it.
    // Per the plan, the first 7 days of operation should be shadow mode so the
    // commit step writes only to history tables, not to FCT_TRENDS.
    const write_live = body.write_live === true || body.write_live === "true";
    const budget_per_subagent_usd = clamp(body.budget_per_subagent_usd, 0.01, 0.50) ?? 0.06;

    console.log(
      `lcy-sweep: chain=${chain_id} sweep_cap=${sweep_cap} ` +
      `budget/subagent=$${budget_per_subagent_usd} dry_run=${dry_run} write_live=${write_live}`
    );

    return {
      chain_id,
      sweep_cap,
      dry_run,
      write_live,
      budget_per_subagent_usd,
    };
  },
});
