// Distillation Lead — parse_cluster_result
//
// Reads the cluster agent's callback payload from
// {{steps.dispatch_to_cluster_agent.$resume_data}} and normalizes it
// into the shape downstream steps (commit_candidates, update_cursor,
// respond) expect — same field set the old synchronous
// dispatch_to_cluster_agent used to return.
//
// Three branches:
//   1. Suspend timed out: $resume_data is undefined. Emit empty
//      candidates so commit_candidates no-ops via WHERE :1 != '[]'.
//      update_cursor advances LAST_RUN_AT but COALESCE preserves
//      LAST_SIGNAL_TS. Cron retries fresh signals next tick.
//   2. Cluster agent returned an error: same empty-emit shape, with
//      error string propagated for run-history visibility.
//   3. Happy path: pass through proposed_candidates and metrics.

export default defineComponent({
  props: {
    resume_payload: { type: "any", optional: true },
    dispatch_meta: { type: "any" },
  },
  async run({ $ }) {
    const meta = this.dispatch_meta || {};
    const startedAt = meta.run_started_at || Date.now();

    const empty = (error) => ({
      proposed_candidates: [],
      candidates_json: "[]",
      candidates_count: 0,
      cost_usd: 0,
      run_duration_ms: Date.now() - startedAt,
      signals_seen: meta.signals_seen || 0,
      max_signal_ts: null,
      chain_id: meta.chain_id || null,
      agent_session_id: meta.agent_session_id || null,
      error: error || null,
    });

    const rp = this.resume_payload;
    if (rp == null) {
      console.log("parse_cluster_result: $resume_data missing — suspend timed out");
      $.export("$summary", "0 candidates (cluster agent timeout)");
      return empty("cluster_agent_timeout");
    }

    // Pipedream delivers the resume POST as an HTTP-event-shaped object:
    // { method, headers, body, ... }. Some Pipedream versions surface
    // .body parsed; some pass through flat. Defensive on both.
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
      proposed_candidates: candidates,
      candidates_json: JSON.stringify(candidates),
      candidates_count: candidates.length,
      cost_usd: body.cost_usd || 0,
      run_duration_ms: body.run_duration_ms || (Date.now() - startedAt),
      signals_seen: body.signals_seen || meta.signals_seen || 0,
      max_signal_ts: body.max_signal_ts || null,
      chain_id: body.chain_id || meta.chain_id || null,
      agent_session_id: body.agent_session_id || meta.agent_session_id || null,
      // Pass through telemetry for the lead's respond step.
      turns: body.turns || 0,
      stop_reason: body.stop_reason || "unknown",
      tokens: body.tokens || { input: 0, output: 0, total: 0 },
      final_text: body.final_text || "",
      error: null,
    };

    console.log(
      `parse_cluster_result: ${out.candidates_count} candidates, ` +
      `cost=$${out.cost_usd.toFixed(4)}, duration=${out.run_duration_ms}ms`,
    );
    $.export("$summary", `${out.candidates_count} candidates from cluster agent`);
    return out;
  },
});
