// Lifecycle Attribution Agent (sweeper) — normalize_event
//
// HTTP POST (manual or future cron). Override defaults:
//   { sweep_cap, dry_run, budget_per_subagent_usd, chain_id }

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

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `attr-chain-${uuid()}`;
    const sweep_cap = clamp(body.sweep_cap, 1, 100) ?? 30;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_per_subagent_usd = clamp(body.budget_per_subagent_usd, 0.01, 0.20) ?? 0.04;

    console.log(
      `attr-sweep: chain=${chain_id} sweep_cap=${sweep_cap} ` +
      `budget/subagent=$${budget_per_subagent_usd} dry_run=${dry_run}`
    );

    return { chain_id, sweep_cap, dry_run, budget_per_subagent_usd };
  },
});
