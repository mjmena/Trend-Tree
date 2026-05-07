// Distillation Revisit Lead — dispatch_to_cluster_agent
//
// Single-batch suspend pattern (mirrors distillation-p_mkCBBqb). Suspend
// before the outbound POST so resume_url is available to embed in the
// payload; the cluster agent acks 202 and POSTs back to resume_url when
// its agent loop completes (typically 5-10 min).
//
// If select_next_batch reported is_done (no PENDING work, e.g. last
// batch already drained or empty pool on start), this step returns
// without suspending so finalize_or_continue runs in the same execution.
//
// Why suspend: a synchronous fetch of the cluster agent fails at
// Pipedream's HTTP-trigger sync-response cap (~5.5 min) regardless of
// our own AbortController, which is why the previous 4-way parallel
// fanout was timing out consistently.

const SUSPEND_TIMEOUT_MS = 20 * 60 * 1000;
const POST_TIMEOUT_MS = 30_000;

export default defineComponent({
  props: {
    cluster_agent_url: { type: "string", label: "Cluster Agent HTTP trigger URL" },
    next_batch: { type: "any" },
  },
  async run({ $ }) {
    const nb = this.next_batch || {};

    if (nb.is_done === true) {
      console.log("dispatch_to_cluster_agent: chain done — skipping suspend");
      $.export("$summary", "chain done (no dispatch)");
      return {
        skipped: true,
        chain_id: nb.chain_id,
        agent_session_id: nb.agent_session_id,
        total_batches: nb.total_batches ?? 0,
      };
    }

    const url = this.cluster_agent_url;
    if (!url || /PLACEHOLDER/i.test(url)) {
      throw new Error("cluster_agent_url is not configured");
    }

    const { resume_url, cancel_url } = $.flow.suspend(SUSPEND_TIMEOUT_MS);

    const payload = {
      cluster_rows: Array.isArray(nb.cluster_rows) ? nb.cluster_rows : [],
      signal_ids_json: nb.signal_ids_json,
      agent_session_id: nb.agent_session_id,
      chain_id: nb.chain_id,
      resume_url,
    };

    console.log(
      `dispatch_to_cluster_agent: chain=${nb.chain_id} batch=${nb.batch_index}/${nb.total_batches} ` +
      `signals=${nb.signal_count} suspend=${SUSPEND_TIMEOUT_MS / 60000}min`,
    );

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      try { await fetch(cancel_url, { method: "POST" }); } catch {}
      throw new Error(`dispatch_to_cluster_agent fetch failed: ${e.message}`);
    }
    clearTimeout(timer);

    const text = await resp.text();
    if (!resp.ok) {
      try { await fetch(cancel_url, { method: "POST" }); } catch {}
      throw new Error(`Cluster agent HTTP ${resp.status}: ${text.slice(0, 400)}`);
    }

    let ackBody = null;
    try { ackBody = JSON.parse(text); } catch {}

    console.log(
      `dispatch_to_cluster_agent: ack ${resp.status} mode=${ackBody?.mode || "unknown"} ` +
      `chain=${ackBody?.chain_id || nb.chain_id}`,
    );
    $.export("$summary", "suspended for cluster agent callback");

    return {
      skipped: false,
      suspended: true,
      cluster_agent_acknowledged: true,
      resume_url,
      cancel_url,
      chain_id: nb.chain_id,
      agent_session_id: nb.agent_session_id,
      batch_index: nb.batch_index,
      total_batches: nb.total_batches,
      signals_seen: nb.signal_count,
      run_started_at: Date.now(),
    };
  },
});
