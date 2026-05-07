// Distillation Cluster Agent — respond
//
// Two modes:
//   1. Async callback (request.resume_url is set): handle_request already
//      sent a 202 to the caller. POST the result body to resume_url so a
//      $.flow.suspend()ed caller can resume. Do NOT call $.respond again
//      (Pipedream allows one per execution).
//   2. Synchronous (no resume_url): legacy path used by revisit and curl
//      debug. $.respond the result with status 200.
//
// Both branches return the same body for run-history visibility.

const RESUME_POST_TIMEOUT_MS = 30_000;

export default defineComponent({
  props: {
    request: { type: "any" },
    agent_result: { type: "any" },
    resume_url: { type: "string", optional: true },
  },
  async run({ $ }) {
    const req = this.request || {};
    const ar = this.agent_result || {};

    const body = {
      proposed_candidates: ar.candidates || [],
      candidates_count: ar.candidates_count || 0,
      cost_usd: ar.cost_usd || 0,
      run_duration_ms: ar.run_duration_ms || 0,
      signals_seen: ar.signals_seen || 0,
      max_signal_ts: ar.max_signal_ts || null,
      turns: ar.turns || 0,
      stop_reason: ar.stop_reason || "unknown",
      agent_session_id: req.agent_session_id,
      chain_id: req.chain_id,
      error: ar.error || null,
      final_text: ar.final_text || "",
      reasoning_trace: ar.reasoning_trace || [],
      tool_calls_summary: ar.tool_calls_summary || [],
    };

    if (this.resume_url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), RESUME_POST_TIMEOUT_MS);
      try {
        const resp = await fetch(this.resume_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          // Don't throw: handle_request already $.respond()ed 202, and a
          // throw here marks the run as failed even though the work is
          // done. The caller will hit suspend timeout and degrade gracefully.
          console.log(`resume_url POST returned HTTP ${resp.status}: ${text.slice(0, 240)}`);
        } else {
          console.log(`resume_url POST ok (${body.candidates_count} candidates)`);
        }
      } catch (e) {
        console.log(`resume_url POST failed: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body,
      });
    }

    return body;
  },
});
