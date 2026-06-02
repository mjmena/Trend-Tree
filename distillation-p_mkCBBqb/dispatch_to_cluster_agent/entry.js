// Distillation — dispatch_to_cluster_agent
//
// Suspends the workflow on $.flow.suspend(), POSTs the cluster batch
// to the cluster agent's HTTP trigger with the resume_url in the body,
// and returns metadata describing the suspended state. The cluster
// agent acks 202 synchronously (handle_request) and then POSTs the
// final result to resume_url when its agent loop completes (respond).
//
// Why suspend: the cluster agent run can take 6-10 min; Pipedream's
// HTTP-trigger sync-response delivery caps around 5.5 min. Holding open
// a fetch for that long fails with TypeError: fetch failed regardless
// of our own AbortController. Suspend sidesteps the cap entirely —
// no connection is held open; the lambda terminates after this step
// returns and a fresh one resumes when resume_url is POSTed.
//
// Downstream consumer: parse_cluster_result reads
// {{steps.dispatch_to_cluster_agent.$resume_data}} and normalizes the
// callback body into the field set commit_candidates / update_cursor /
// respond expect.

const SUSPEND_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min — cluster agent's lambda budget is 750s
const POST_TIMEOUT_MS = 30_000;              // 30s — initial POST should ack 202 in <2s

export default defineComponent({
  props: {
    cluster_agent_url: { type: "string", label: "Cluster Agent HTTP trigger URL" },
    cluster_rows: { type: "any" },
    signal_ids_json: { type: "string" },
    agent_session_id: { type: "string" },
    chain_id: { type: "string" },
  },
  async run({ $ }) {
    const url = this.cluster_agent_url;
    if (!url || /PLACEHOLDER/i.test(url)) {
      throw new Error("cluster_agent_url is not configured — set it in workflow.yaml after creating the Distillation Cluster Agent workflow");
    }

    // Allocate the suspend BEFORE the outbound POST so the URL exists
    // to embed in the payload. The actual suspend takes effect when this
    // step's run() returns successfully.
    const { resume_url, cancel_url } = $.flow.suspend(SUSPEND_TIMEOUT_MS);

    // Slim cluster_rows to the join essentials before POSTing — signal_title /
    // source_name are redundant (the cluster-agent re-fetches them in
    // signal_rows and looks them up by signal_id). Keeps the POST + the agent's
    // handle_request bundle small at a 1600-signal pool.
    const cluster_rows_arr = (Array.isArray(this.cluster_rows) ? this.cluster_rows : [])
      .map((c) => ({ signal_id: c.signal_id, cluster_id: c.cluster_id, similarity_to_seed: c.similarity_to_seed }));
    const payload = {
      cluster_rows: cluster_rows_arr,
      signal_ids_json: this.signal_ids_json,
      agent_session_id: this.agent_session_id,
      chain_id: this.chain_id,
      resume_url,
    };

    console.log(
      `dispatch_to_cluster_agent: POSTing ${cluster_rows_arr.length} cluster rows ` +
      `to ${url} (suspend ${SUSPEND_TIMEOUT_MS / 60000}min)`,
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
      // Outbound POST failed entirely (DNS, network, abort). Cancel the
      // suspend so we don't leave a 20-min ghost waiting. Then re-throw
      // to surface the error in workflow_list_errors.
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
      `dispatch_to_cluster_agent: cluster agent ack ${resp.status} ` +
      `mode=${ackBody?.mode || "unknown"} chain=${ackBody?.chain_id || this.chain_id}`,
    );
    $.export("$summary", "suspended for cluster agent callback");

    return {
      suspended: true,
      cluster_agent_acknowledged: true,
      resume_url,
      cancel_url,
      chain_id: this.chain_id,
      agent_session_id: this.agent_session_id,
      signals_seen: cluster_rows_arr.length,    // fallback; parse_cluster_result overwrites with authoritative
      run_started_at: Date.now(),
    };
  },
});
