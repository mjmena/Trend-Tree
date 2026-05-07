// Distillation Lead — respond
//
// Run-history summary only. The HTTP caller already received a 202 from
// respond_accepted (which runs before the suspend in dispatch_to_cluster_agent),
// and Pipedream allows one $.respond per execution — this step deliberately
// does NOT call $.respond. The returned body shows up in the run UI for
// debugging.

// Snowflake INSERT/UPDATE actions return an array shaped like
// [{ 'number of rows inserted': N }] or [{ 'number of rows updated': N }]
// (Snowflake reports affected rows under varying key names). This helper
// extracts whichever count is present.
function affectedRows(result) {
  if (!Array.isArray(result) || result.length === 0) return 0;
  const row = result[0];
  if (!row || typeof row !== "object") return 0;
  for (const key of Object.keys(row)) {
    if (key.startsWith("number of rows")) {
      const n = Number(row[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

export default defineComponent({
  props: {
    event: { type: "any" },
    agent_result: { type: "any" },
    commit_result: { type: "any" },
    claim_signals_result: { type: "any" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const ar = this.agent_result || {};
    const commitOk = Array.isArray(this.commit_result) || (this.commit_result && !this.commit_result.error);

    const claimed_signal_count = affectedRows(this.claim_signals_result);

    // Promotion to FCT_TRENDS now happens in the separate promotion-p_xMC99jg
    // workflow on its own cron. Distillation no longer reports promoted/dup
    // counts because those decisions are made downstream.
    const body = {
      tool: "distillation_lead",
      chain_id: ar.chain_id,
      agent_session_id: ar.agent_session_id || evt.agent_session_id,
      iteration: ar.iteration || evt.iteration,
      signals_seen: ar.signals_seen || 0,
      louvain_seen: ar.louvain_seen || 0,
      candidates_count: ar.candidates_count || 0,
      candidates_persisted: !!commitOk,
      claimed_signal_count,
      cost_usd: ar.cost_usd || 0,
      tokens: ar.tokens || { input: 0, output: 0, total: 0 },
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      run_duration_ms: ar.run_duration_ms || 0,
      max_signal_ts_observed: ar.max_signal_ts || null,
      final_text: ar.final_text || "",
      error: ar.error || null,
    };

    return body;
  },
});
