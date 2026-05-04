// Distillation — dispatch_to_cluster_agent
//
// POSTs the Louvain cluster batch to the cluster agent HTTP trigger and
// waits for the synchronous response (timeout 700s). The cluster agent
// runs the Gemini 3.1 Pro lead loop + subagent dispatch and returns
// proposed_candidates. Replaces run_lead_agent in this workflow.

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

    const payload = {
      cluster_rows: this.cluster_rows,
      signal_ids_json: this.signal_ids_json,
      agent_session_id: this.agent_session_id,
      chain_id: this.chain_id,
    };

    console.log(`dispatch_to_cluster_agent: POSTing ${(this.cluster_rows || []).length} cluster rows to ${url}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700_000);
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!resp.ok) throw new Error(`Cluster agent HTTP ${resp.status}: ${text.slice(0, 400)}`);

    const candidates = data.proposed_candidates || [];
    const candidates_json = JSON.stringify(candidates);
    console.log(
      `dispatch_to_cluster_agent: ${candidates.length} candidates, ` +
      `cost=$${(data.cost_usd || 0).toFixed(4)}, duration=${data.run_duration_ms || 0}ms`,
    );
    $.export("$summary", `${candidates.length} candidates from cluster agent`);

    return {
      proposed_candidates: candidates,
      candidates_json,
      candidates_count: candidates.length,
      cost_usd: data.cost_usd || 0,
      run_duration_ms: data.run_duration_ms || 0,
      signals_seen: data.signals_seen || 0,
      max_signal_ts: data.max_signal_ts || null,
    };
  },
});
