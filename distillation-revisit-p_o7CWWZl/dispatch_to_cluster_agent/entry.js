// Distillation Revisit — dispatch_to_cluster_agent
//
// Fans out each Louvain batch to the cluster agent HTTP trigger in parallel
// (concurrency 4). Each batch is an independent synchronous call; the cluster
// agent runs one Gemini 3.1 Pro lead loop per batch and returns candidates.
// Aggregates proposed_candidates from all batch responses.

const FANOUT_CONCURRENCY = 4;
const PER_CALL_TIMEOUT_MS = 700_000;

export default defineComponent({
  props: {
    cluster_agent_url: { type: "string", label: "Cluster Agent HTTP trigger URL" },
    batches: { type: "any" },
    agent_session_id: { type: "string" },
    chain_id: { type: "string" },
  },
  async run({ $ }) {
    const url = this.cluster_agent_url;
    if (!url || /PLACEHOLDER/i.test(url)) {
      throw new Error("cluster_agent_url is not configured — set it in workflow.yaml after creating the Distillation Cluster Agent workflow");
    }

    const batches = Array.isArray(this.batches) ? this.batches : [];
    if (batches.length === 0) {
      console.log("dispatch_to_cluster_agent: no batches; pool was empty");
      $.export("$summary", "0 batches dispatched");
      return {
        candidates_json: "[]",
        candidates_count: 0,
        signals_seen: 0,
        batches_dispatched: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        batch_results: [],
      };
    }

    console.log(`dispatch_to_cluster_agent: dispatching ${batches.length} batches to ${url}`);

    const t0 = Date.now();
    const results = new Array(batches.length);
    let cursor = 0;

    const agent_session_id = this.agent_session_id;
    const chain_id = this.chain_id;

    async function worker() {
      while (cursor < batches.length) {
        const idx = cursor++;
        const batch = batches[idx];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
        const tStart = Date.now();
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cluster_rows: batch.cluster_rows,
              signal_ids_json: batch.signal_ids_json,
              agent_session_id,
              chain_id,
            }),
            signal: ctrl.signal,
          });
          const text = await resp.text();
          let data;
          try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 500) }; }
          results[idx] = {
            batch_index: idx,
            signal_count: batch.signal_count,
            ok: resp.ok,
            status: resp.status,
            duration_ms: Date.now() - tStart,
            data,
          };
          if (!resp.ok) console.log(`dispatch batch ${idx} → HTTP ${resp.status}`);
        } catch (e) {
          const msg = e.name === "AbortError" ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : e.message;
          results[idx] = {
            batch_index: idx,
            signal_count: batch.signal_count,
            ok: false,
            error: msg,
            duration_ms: Date.now() - tStart,
          };
          console.log(`dispatch batch ${idx} → error: ${msg}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const run_duration_ms = Date.now() - t0;

    const candidates = [];
    let totalCost = 0;
    let totalSignals = 0;
    for (const r of results) {
      const proposed = r.data?.proposed_candidates;
      if (Array.isArray(proposed)) candidates.push(...proposed);
      if (Number.isFinite(r.data?.cost_usd)) totalCost += r.data.cost_usd;
      totalSignals += r.signal_count || 0;
    }

    const ok = results.filter((r) => r.ok).length;
    const errors = results.filter((r) => !r.ok).length;
    console.log(
      `dispatch_to_cluster_agent: ${candidates.length} candidates from ${results.length} batches ` +
      `(${ok} ok, ${errors} errors) in ${run_duration_ms}ms; cost=$${totalCost.toFixed(4)}`,
    );
    $.export("$summary", `${candidates.length} candidates / ${batches.length} batches`);

    return {
      candidates_json: JSON.stringify(candidates),
      candidates_count: candidates.length,
      signals_seen: totalSignals,
      batches_dispatched: batches.length,
      cost_usd: totalCost,
      run_duration_ms,
      batch_results: results,
    };
  },
});
