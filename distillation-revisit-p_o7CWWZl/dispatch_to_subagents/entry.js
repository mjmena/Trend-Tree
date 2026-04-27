// Distillation Revisit Lead — dispatch_to_subagents
//
// Groups the cluster_rows (output of PROC_CLUSTER_SIGNAL_SUBSET) by
// cluster_id, fans out to N parallel POSTs to the revisit subagent
// endpoint, aggregates proposed candidates from all responses.
//
// Each subagent gets one cluster's signal_ids + their own session_id
// for traceability. Subagent runs Sonnet 4.6 with the revisit prompt
// against just that slice; returns proposed_candidates (or empty).

const FANOUT_CONCURRENCY = 5;
const PER_CALL_TIMEOUT_MS = 540_000; // subagents have 600s lambda; allow most of that

function extractClusterRows(payload) {
  // PROC_CLUSTER_SIGNAL_SUBSET returns a single VARIANT row containing an
  // array. The SQL action wraps it as either an array of rows or a row
  // with one column whose value is the proc's return.
  let row = null;
  if (Array.isArray(payload) && payload.length > 0) row = payload[0];
  else if (payload && typeof payload === "object") row = payload;
  if (!row) return [];
  const value =
    row.PROC_CLUSTER_SIGNAL_SUBSET ??
    row.proc_cluster_signal_subset ??
    Object.values(row)[0];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default defineComponent({
  props: {
    event: { type: "object" },
    cluster_rows: { type: "any" },
    subagent_url: { type: "string" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    if (!this.subagent_url || /PLACEHOLDER/i.test(this.subagent_url)) {
      console.log(`revisit-lead: subagent_url not configured (${this.subagent_url}) — skipping fanout`);
      $.export("$summary", "subagent_url not configured");
      return {
        skipped: true,
        candidates_json: "[]",
        candidates_count: 0,
        signals_seen: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        subagent_results: [],
      };
    }

    const rows = extractClusterRows(this.cluster_rows);
    if (rows.length === 0) {
      console.log(`revisit-lead: no cluster rows; pool was empty`);
      return {
        candidates_json: "[]",
        candidates_count: 0,
        signals_seen: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        subagent_results: [],
      };
    }

    // Group signals by cluster_id
    const byCluster = new Map();
    for (const r of rows) {
      const cid = Number(r.cluster_id ?? 0);
      if (!byCluster.has(cid)) byCluster.set(cid, []);
      byCluster.get(cid).push(r.signal_id);
    }
    const clusters = [...byCluster.entries()].map(([cluster_id, signal_ids]) => ({ cluster_id, signal_ids }));

    console.log(
      `revisit-lead: dispatching ${clusters.length} clusters (${rows.length} signals) to ${this.subagent_url}`,
    );

    const t0 = Date.now();
    const results = [];
    let cursor = 0;

    const url = this.subagent_url;
    const session_id = ev.agent_session_id;
    const chain_id = ev.chain_id;
    const dry_run = ev.dry_run === true;
    const budget = ev.budget_per_subagent_usd;

    async function worker() {
      while (cursor < clusters.length) {
        const idx = cursor++;
        const c = clusters[idx];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
        const tStart = Date.now();
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cluster_id: c.cluster_id,
              signal_ids: c.signal_ids,
              agent_session_id: session_id,
              chain_id,
              dry_run,
              budget_tokens: 25_000,
            }),
            signal: ctrl.signal,
          });
          const text = await resp.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
          results.push({
            cluster_id: c.cluster_id,
            signal_count: c.signal_ids.length,
            ok: resp.ok,
            status: resp.status,
            duration_ms: Date.now() - tStart,
            response: parsed,
          });
          if (!resp.ok) {
            console.log(`revisit-lead: cluster ${c.cluster_id} → HTTP ${resp.status}`);
          }
        } catch (e) {
          const msg = e.name === "AbortError" ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : e.message;
          results.push({
            cluster_id: c.cluster_id,
            signal_count: c.signal_ids.length,
            ok: false,
            error: msg,
            duration_ms: Date.now() - tStart,
          });
          console.log(`revisit-lead: cluster ${c.cluster_id} → error: ${msg}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, clusters.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const run_duration_ms = Date.now() - t0;

    // Aggregate proposed candidates across all subagent responses
    const candidates = [];
    let totalCost = 0;
    for (const r of results) {
      const proposed = r.response?.proposed_candidates;
      if (Array.isArray(proposed)) candidates.push(...proposed);
      if (Number.isFinite(r.response?.cost_usd)) totalCost += r.response.cost_usd;
    }

    console.log(
      `revisit-lead: ${candidates.length} candidates aggregated from ${results.length} clusters ` +
      `(${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} errors) ` +
      `in ${run_duration_ms}ms; total subagent cost=$${totalCost.toFixed(4)}`,
    );
    $.export("$summary", `${candidates.length} candidates / ${clusters.length} clusters`);

    return {
      candidates_json: JSON.stringify(candidates),
      candidates_count: candidates.length,
      signals_seen: rows.length,
      cluster_count: clusters.length,
      cost_usd: totalCost,
      run_duration_ms,
      subagent_results: results,
    };
  },
});
