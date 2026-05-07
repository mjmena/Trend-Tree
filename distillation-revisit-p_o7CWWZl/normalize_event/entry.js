// Distillation Revisit Lead — normalize_event
//
// Two run modes, distinguished by whether the trigger body carries a
// chain_id (and mode="continue"):
//
//   - start:    cron firing or manual POST without chain_id. Mints a fresh
//               revisit-<uuid> session and chain-<uuid>. prepare_chain
//               will load the pool, cluster, batch, persist queue rows,
//               and claim signals.
//
//   - continue: self-POST from finalize_or_continue carrying the existing
//               chain_id (and matching agent_session_id). prepare_chain
//               no-ops; select_next_batch pulls the next PENDING row.
//
// claim_revisit_signals semantics still hold: the revisit- prefix on
// agent_session_id keeps PROC_RELEASE_STALE_SIGNAL_CLAIMS from releasing
// these signals, and future revisit runs skip them via NOT EXISTS.

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
    const is_continue = body.mode === "continue" && SHORT_ID_OK.test(body.chain_id || "");

    let agent_session_id;
    let chain_id;

    if (is_continue) {
      chain_id = body.chain_id;
      agent_session_id = SHORT_ID_OK.test(body.agent_session_id || "")
        ? body.agent_session_id
        : null;
      if (!agent_session_id) {
        throw new Error(`continue mode requires agent_session_id alongside chain_id=${chain_id}`);
      }
    } else {
      agent_session_id = `revisit-${uuid()}`;
      chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `chain-${uuid()}`;
    }

    const dry_run = body.dry_run === true || body.dry_run === "true";
    const budget_per_subagent_usd = clamp(body.budget_per_subagent_usd, 0.25, 5.0) ?? 1.5;

    console.log(
      `revisit-lead: mode=${is_continue ? "continue" : "start"} ` +
      `session=${agent_session_id} chain=${chain_id} dry_run=${dry_run}`,
    );

    return {
      mode: is_continue ? "continue" : "start",
      is_start: !is_continue,
      is_continue,
      agent_session_id,
      chain_id,
      dry_run,
      budget_per_subagent_usd,
    };
  },
});
