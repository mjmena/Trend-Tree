// Distillation Revisit Lead — parse_cluster_result
//
// Reads the cluster agent's callback payload from
// {{steps.dispatch_to_cluster_agent.$resume_data}} and normalizes it
// into the shape commit_batch_result + finalize_or_continue expect.
// Mirrors distillation-p_mkCBBqb/parse_cluster_result/entry.mjs.
//
// Three branches:
//   1. dispatch was a no-op (no PENDING batch — already finalized).
//      pass through with skipped flag.
//   2. Suspend timed out: $resume_data is undefined. Mark the batch
//      FAILED downstream with cluster_agent_timeout error.
//   3. Cluster agent returned an error: same FAILED path with the
//      reported error string.
//   4. Happy path: pass through proposed_candidates and metrics.

export default defineComponent({
  props: {
    resume_payload: { type: "any", optional: true },
    dispatch_meta: { type: "any" },
  },
  async run({ $ }) {
    const meta = this.dispatch_meta || {};
    const startedAt = meta.run_started_at || Date.now();

    if (meta.skipped === true) {
      console.log("parse_cluster_result: dispatch was skipped (no PENDING batch)");
      return {
        skipped: true,
        proposed_candidates: [],
        candidates_json: "[]",
        candidates_count: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        signals_seen: 0,
        max_signal_ts: null,
        chain_id: meta.chain_id || null,
        agent_session_id: meta.agent_session_id || null,
        batch_index: meta.batch_index ?? null,
        error: null,
      };
    }

    const empty = (error) => ({
      skipped: false,
      proposed_candidates: [],
      candidates_json: "[]",
      candidates_count: 0,
      cost_usd: 0,
      run_duration_ms: Date.now() - startedAt,
      signals_seen: meta.signals_seen || 0,
      max_signal_ts: null,
      chain_id: meta.chain_id || null,
      agent_session_id: meta.agent_session_id || null,
      batch_index: meta.batch_index ?? null,
      error: error || null,
    });

    const rp = this.resume_payload;
    if (rp == null) {
      console.log("parse_cluster_result: $resume_data missing — suspend timed out");
      $.export("$summary", "0 candidates (cluster agent timeout)");
      return empty("cluster_agent_timeout");
    }

    const body = (rp && typeof rp === "object" && rp.body && typeof rp.body === "object") ? rp.body : rp;

    if (body && body.error) {
      console.log(`parse_cluster_result: cluster agent reported error: ${body.error}`);
      $.export("$summary", `0 candidates (cluster agent error: ${String(body.error).slice(0, 80)})`);
      return empty(String(body.error));
    }

    if (!Array.isArray(body?.proposed_candidates)) {
      console.log("parse_cluster_result: malformed callback body, no proposed_candidates array");
      $.export("$summary", "0 candidates (malformed callback)");
      return empty("malformed_callback_body");
    }

    const candidates = body.proposed_candidates;
    const out = {
      skipped: false,
      proposed_candidates: candidates,
      candidates_json: JSON.stringify(candidates),
      candidates_count: candidates.length,
      cost_usd: body.cost_usd || 0,
      run_duration_ms: body.run_duration_ms || (Date.now() - startedAt),
      signals_seen: body.signals_seen || meta.signals_seen || 0,
      max_signal_ts: body.max_signal_ts || null,
      chain_id: body.chain_id || meta.chain_id || null,
      agent_session_id: body.agent_session_id || meta.agent_session_id || null,
      batch_index: meta.batch_index ?? null,
      turns: body.turns || 0,
      stop_reason: body.stop_reason || "unknown",
      tokens: body.tokens || { input: 0, output: 0, total: 0 },
      final_text: body.final_text || "",
      error: null,
    };

    console.log(
      `parse_cluster_result: batch=${out.batch_index} ${out.candidates_count} candidates, ` +
      `cost=$${out.cost_usd.toFixed(4)}, duration=${out.run_duration_ms}ms`,
    );
    $.export("$summary", `${out.candidates_count} candidates from cluster agent`);
    return out;
  },
});
