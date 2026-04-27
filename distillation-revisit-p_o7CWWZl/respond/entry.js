// Distillation Revisit Lead — respond
//
// Returns a tight summary: pool size, clusters dispatched, candidates
// proposed, candidates persisted, claim count, total cost.

export default defineComponent({
  props: {
    event: { type: "object" },
    pool_size: { type: "any", optional: true },
    dispatch_result: { type: "any", optional: true },
    commit_result: { type: "any", optional: true },
    claim_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const dr = this.dispatch_result || {};

    const body = {
      session_id: ev.agent_session_id,
      chain_id: ev.chain_id,
      pool_size: Number(this.pool_size ?? 0),
      cluster_count: dr.cluster_count ?? 0,
      candidates_proposed: dr.candidates_count ?? 0,
      candidates_persisted: Array.isArray(this.commit_result) ? this.commit_result.length : null,
      signals_claimed: Array.isArray(this.claim_result) ? this.claim_result.length : null,
      total_cost_usd: dr.cost_usd ?? 0,
      run_duration_ms: dr.run_duration_ms ?? 0,
      dry_run: ev.dry_run === true,
      subagent_results: dr.subagent_results,
    };

    console.log(`\n=== Revisit complete: ${body.session_id} ===`);
    console.log(`  pool=${body.pool_size}  clusters=${body.cluster_count}  candidates=${body.candidates_proposed} (persisted=${body.candidates_persisted})  cost=$${(body.total_cost_usd || 0).toFixed(4)}`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });
    return body;
  },
});
