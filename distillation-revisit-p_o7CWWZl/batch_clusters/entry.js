// Distillation Revisit — batch_clusters
//
// Greedy bin-packer: groups Louvain communities into batches of ≤400 signals,
// then each batch is dispatched as one call to the cluster agent. This lets
// the cluster agent run one Gemini lead loop per batch — small enough to fit
// in context, large enough to see cross-community patterns.
//
// Algorithm: sort communities by size DESC, greedily pack into the current
// batch until adding a community would exceed 400. If a single community
// is itself > 400 signals, cap it at 400 (take first 400 by signal order).

const MAX_BATCH_SIZE = 400;

export default defineComponent({
  props: {
    cluster_rows: { type: "any" },
    signal_ids_json: { type: "string" },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.cluster_rows) ? this.cluster_rows : [];

    if (rows.length === 0) {
      $.export("$summary", "0 signals → 0 batches");
      return { batches: [], total_signals: 0 };
    }

    // Group by cluster_id → communities
    const byCluster = new Map();
    for (const r of rows) {
      const cid = r.cluster_id ?? 0;
      if (!byCluster.has(cid)) byCluster.set(cid, []);
      byCluster.get(cid).push(r);
    }

    // Sort communities largest-first so big ones don't strand at the end
    const communities = [...byCluster.values()].sort((a, b) => b.length - a.length);

    const batches = [];
    let current = [];

    for (const community of communities) {
      const slice = community.slice(0, MAX_BATCH_SIZE);

      if (current.length + slice.length > MAX_BATCH_SIZE) {
        if (current.length > 0) batches.push(current);
        current = slice;
      } else {
        current = current.concat(slice);
      }
    }
    if (current.length > 0) batches.push(current);

    const result = batches.map((batchRows, i) => {
      const signal_ids = batchRows.map((r) => r.signal_id);
      return {
        batch_index: i,
        cluster_rows: batchRows,
        signal_ids_json: JSON.stringify(signal_ids),
        signal_count: signal_ids.length,
        community_count: new Set(batchRows.map((r) => r.cluster_id)).size,
      };
    });

    console.log(
      `batch_clusters: ${rows.length} signals → ${result.length} batches ` +
      `(sizes: ${result.map((b) => b.signal_count).join(", ")})`,
    );
    $.export("$summary", `${rows.length} signals → ${result.length} batches`);

    return { batches: result, total_signals: rows.length };
  },
});
