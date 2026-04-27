// Distillation Revisit Lead — normalize_event
//
// Generates a `revisit-<uuid>` session_id (the prefix matters: it's how
// claim_revisit_signals re-stamps signals so future revisit runs skip
// them, and how PROC_RELEASE_STALE_SIGNAL_CLAIMS knows not to release
// these). Reads optional overrides from POST body (manual triggers).

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

    const agent_session_id = `revisit-${uuid()}`;
    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `chain-${uuid()}`;
    const cluster_count = clamp(body.cluster_count, 2, 10) ?? 5;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_per_subagent_usd = clamp(body.budget_per_subagent_usd, 0.25, 5.0) ?? 1.5;

    console.log(
      `revisit-lead: session=${agent_session_id} chain=${chain_id} clusters=${cluster_count} ` +
      `budget/subagent=$${budget_per_subagent_usd} dry_run=${dry_run}`,
    );

    return {
      agent_session_id,
      chain_id,
      cluster_count,
      dry_run,
      budget_per_subagent_usd,
    };
  },
});
